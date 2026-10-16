/**
 * Persistence for opportunity scan runs (issue #27).
 *
 * Until now an OpportunityScanResult existed only inside the response
 * that produced it: scans could not be audited, retrieved later, or
 * diffed run-over-run, and the result itself carried no generatedAt,
 * model version, or record of what produced it (the provenance fields
 * now ride on the result — see opportunityScanner.ts). This module is
 * the persistence seam. The scanner stays a pure compute class; callers
 * that own a Durable Object storage handle hand a ScanRunStore to the
 * scan paths (NLQ, unified opportunities), and contexts without a store
 * behave exactly as before.
 *
 * Pattern note (verified against the codebase): recommendations were
 * NOT previously persisted anywhere — there is no recommendations table
 * and no code path inserts them. The nearest persisted-run pattern is
 * `mas_policy_verdicts` (autopilot policy verdicts, written inline in
 * src/agents/orchestrator.ts via sql.exec with JSON payload columns,
 * indexed on created_at): mas_* tables in DO SQLite. SqlScanRunStore
 * follows that pattern, with the table ensured lazily by the store so
 * ensureTables() needs no new entry.
 */

import type {
  FitGateBucket,
  OpportunityScanResult,
  ScanCoverage,
  ScanMode,
} from "./opportunityScanner";

/** Days a persisted scan run is retained. 365 matches the settled
 *  retention for discovery runs: diffing a scan against the same setup
 *  a year apart stays possible, and nothing older silently accumulates. */
export const SCAN_RUN_RETENTION_DAYS = 365;

/** Hard row cap for the scan-run table (oldest pruned first), so a
 *  high-frequency caller cannot grow DO storage without bound inside
 *  the retention window. */
export const SCAN_RUN_MAX_ROWS = 1000;

/** The listing projection of a stored run: everything a history view
 *  needs, without hauling the full result. */
export interface ScanRunSummary {
  id: string;
  generatedAt: string;
  mode: ScanMode;
  modelVersion: string;
  gate: OpportunityScanResult["gate"];
  coverage: ScanCoverage;
}

/** A persisted scan run: its summary plus the full result as produced. */
export interface StoredScanRun extends ScanRunSummary {
  result: OpportunityScanResult;
}

export interface ScanRunStore {
  /** Persist a scan result and return the stored run (with its id).
   *  Saving also prunes: rows older than the retention window and rows
   *  beyond the row cap are deleted, oldest first. */
  save(result: OpportunityScanResult): Promise<StoredScanRun>;
  /** Newest-first summaries (generatedAt descending, id descending on
   *  ties), paginated by limit/offset. */
  list(options?: { limit?: number; offset?: number }): Promise<ScanRunSummary[]>;
  /** The full stored run, or null when the id is unknown (or pruned). */
  get(id: string): Promise<StoredScanRun | null>;
  /** Delete rows older than the retention window (relative to `now`)
   *  and rows beyond the row cap; returns how many rows were deleted. */
  prune(now: Date): Promise<number>;
}

/**
 * Minimal SQL executor matching the Durable Object SqlStorage `exec`
 * signature (the same shape src/orm/index.ts declares): run a statement
 * with bound parameters, get back an iterable of row objects. The real
 * `this.ctx.storage.sql` satisfies it structurally.
 */
export interface ScanSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export interface ScanRunStoreOptions {
  /** Id factory for new runs. Default: crypto.randomUUID() (available
   *  in Workers and Node ≥ 19); injectable for deterministic tests. */
  idFactory?: () => string;
  /** Retention window override (days). Default SCAN_RUN_RETENTION_DAYS. */
  retentionDays?: number;
  /** Row-cap override. Default SCAN_RUN_MAX_ROWS. */
  maxRows?: number;
}

const TABLE = "mas_opportunity_scans";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, generated_at TEXT NOT NULL, ` +
  `mode TEXT NOT NULL, model_version TEXT NOT NULL, summary_json TEXT NOT NULL, result_json TEXT NOT NULL)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_opportunity_scans_generated_at ON ${TABLE} (generated_at DESC)`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, generated_at, mode, model_version, summary_json, result_json) VALUES (?, ?, ?, ?, ?, ?)`;
const GET_SQL = `SELECT summary_json, result_json FROM ${TABLE} WHERE id = ?`;
const LIST_SQL =
  `SELECT summary_json FROM ${TABLE} ORDER BY generated_at DESC, id DESC LIMIT ? OFFSET ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE generated_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY generated_at DESC, id DESC LIMIT ?)`;

function summarize(id: string, result: OpportunityScanResult): ScanRunSummary {
  return {
    id,
    generatedAt: result.generatedAt,
    mode: result.mode,
    modelVersion: result.modelVersion,
    gate: result.gate,
    coverage: result.coverage,
  };
}

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/** Newest-first ordering shared by both stores: generatedAt descending,
 *  id descending on ties (matches the SQL ORDER BY exactly). */
function byNewestFirst(a: ScanRunSummary, b: ScanRunSummary): number {
  if (a.generatedAt !== b.generatedAt) return a.generatedAt < b.generatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * ScanRunStore over Durable Object SQLite. The table is ensured lazily
 * on first use (CREATE TABLE/INDEX IF NOT EXISTS), mirroring how
 * mas_policy_verdicts is written from the orchestrator: plain sql.exec
 * statements with bound parameters and JSON payload columns.
 */
export class SqlScanRunStore implements ScanRunStore {
  private ensured = false;
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(
    private readonly sql: ScanSqlExecutor,
    options: ScanRunStoreOptions = {},
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? SCAN_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? SCAN_RUN_MAX_ROWS;
  }

  private ensure(): void {
    if (this.ensured) return;
    this.sql.exec(CREATE_TABLE_SQL);
    this.sql.exec(CREATE_INDEX_SQL);
    this.ensured = true;
  }

  private count(): number {
    const rows = Array.from(this.sql.exec(COUNT_SQL)) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  async save(result: OpportunityScanResult): Promise<StoredScanRun> {
    this.ensure();
    const id = this.idFactory();
    const summary = summarize(id, result);
    const run: StoredScanRun = { ...summary, result };
    this.sql.exec(
      INSERT_SQL,
      id,
      result.generatedAt,
      result.mode,
      result.modelVersion,
      JSON.stringify(summary),
      JSON.stringify(result),
    );
    // Retention is enforced on the write path, relative to the run's
    // own timestamp: a run saved with an old generatedAt (backfill,
    // replay) prunes against its own clock, not the wall clock.
    await this.prune(new Date(result.generatedAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number } = {}): Promise<ScanRunSummary[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const rows = Array.from(this.sql.exec(LIST_SQL, limit, offset)) as Array<{ summary_json: string }>;
    return rows.map((r) => JSON.parse(r.summary_json) as ScanRunSummary);
  }

  async get(id: string): Promise<StoredScanRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
    if (!rows.length) return null;
    const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
    const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
    return { ...summary, result };
  }

  async prune(now: Date): Promise<number> {
    this.ensure();
    const before = this.count();
    this.sql.exec(PRUNE_AGE_SQL, retentionCutoff(now, this.retentionDays));
    this.sql.exec(PRUNE_CAP_SQL, this.maxRows);
    return before - this.count();
  }
}

/**
 * In-memory ScanRunStore with semantics identical to SqlScanRunStore —
 * for tests and for contexts with no Durable Object storage handle.
 */
export class InMemoryScanRunStore implements ScanRunStore {
  private runs: StoredScanRun[] = [];
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(options: ScanRunStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? SCAN_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? SCAN_RUN_MAX_ROWS;
  }

  async save(result: OpportunityScanResult): Promise<StoredScanRun> {
    const run: StoredScanRun = { ...summarize(this.idFactory(), result), result };
    this.runs.push(run);
    await this.prune(new Date(result.generatedAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number } = {}): Promise<ScanRunSummary[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return [...this.runs]
      .sort(byNewestFirst)
      .slice(offset, offset + limit)
      .map(({ result: _result, ...summary }) => summary);
  }

  async get(id: string): Promise<StoredScanRun | null> {
    return this.runs.find((r) => r.id === id) ?? null;
  }

  async prune(now: Date): Promise<number> {
    const cutoff = retentionCutoff(now, this.retentionDays);
    const kept = [...this.runs]
      .sort(byNewestFirst)
      .filter((r) => r.generatedAt >= cutoff)
      .slice(0, this.maxRows);
    const deleted = this.runs.length - kept.length;
    this.runs = kept;
    return deleted;
  }
}

/** Run-over-run diff of two scan results (issue #27). */
export interface ScanRunDiff {
  /** Symbols gated "fit" in `b` that were not fit in `a`. */
  newFits: string[];
  /** Symbols gated "fit" in `a` that are no longer fit in `b`. */
  droppedFits: string[];
  /** Symbols gated "fit" in both runs. */
  stillFitting: string[];
  /** Symbols evaluated in BOTH runs (gate judged in both) whose gate
   *  bucket changed. Symbols skipped in either run are never judged,
   *  so they cannot appear here. */
  bucketChanges: Array<{ symbol: string; from: FitGateBucket; to: FitGateBucket }>;
  /** Symbols present in `b`'s matrix but not in `a`'s. */
  addedSymbols: string[];
  /** Symbols present in `a`'s matrix but not in `b`'s. */
  removedSymbols: string[];
}

/**
 * Diff two scan results run-over-run (issue #27): `a` is the older run,
 * `b` the newer. Fit membership is the #24 gate bucket on each matrix
 * row. Pure — operates on the results (or the results of two stored
 * runs), no store involved.
 */
export function diffScanRuns(a: OpportunityScanResult, b: OpportunityScanResult): ScanRunDiff {
  const rowsA = new Map(a.matrix.map((r) => [r.symbol, r]));
  const rowsB = new Map(b.matrix.map((r) => [r.symbol, r]));
  const fitsOf = (rows: Map<string, OpportunityScanResult["matrix"][number]>) =>
    new Set([...rows.values()].filter((r) => r.gateBucket === "fit").map((r) => r.symbol));
  const fitsA = fitsOf(rowsA);
  const fitsB = fitsOf(rowsB);
  const ascending = (symbols: Iterable<string>) => [...symbols].sort((x, y) => x.localeCompare(y));

  const bucketChanges: ScanRunDiff["bucketChanges"] = [];
  for (const [symbol, rowA] of rowsA) {
    const rowB = rowsB.get(symbol);
    if (!rowB) continue;
    if (rowA.gateBucket !== null && rowB.gateBucket !== null && rowA.gateBucket !== rowB.gateBucket) {
      bucketChanges.push({ symbol, from: rowA.gateBucket, to: rowB.gateBucket });
    }
  }
  bucketChanges.sort((x, y) => x.symbol.localeCompare(y.symbol));

  return {
    newFits: ascending([...fitsB].filter((s) => !fitsA.has(s))),
    droppedFits: ascending([...fitsA].filter((s) => !fitsB.has(s))),
    stillFitting: ascending([...fitsA].filter((s) => fitsB.has(s))),
    bucketChanges,
    addedSymbols: ascending([...rowsB.keys()].filter((s) => !rowsA.has(s))),
    removedSymbols: ascending([...rowsA.keys()].filter((s) => !rowsB.has(s))),
  };
}
