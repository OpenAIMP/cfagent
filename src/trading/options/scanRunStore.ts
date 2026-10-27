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
 *
 * Issue #103 polish: summaries carry the run's profileRef (no N+1
 * fetch to label a history row), and saves may stamp the saver's
 * userLogin — list/get then scope per user (see visibleToCaller for
 * the rule; rows written before scoping have user_login NULL and stay
 * visible to everyone). The column is added idempotently at ensure
 * time for pre-existing tables.
 */

import type {
  FitGateBucket,
  OpportunityScanResult,
  OptionsPartialQualification,
  ScanCoverage,
  ScanMode,
} from "./opportunityScanner";
import type { ProfileRef } from "./strategyProfile";

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
  /** The saved profile the run ran under (issue #103, completing
   *  #28's stamp): copied from the result so history rows can show it
   *  without fetching every run in full. Null when no profile was
   *  applied. Summaries persisted before issue #103 lack the field at
   *  runtime (undefined); readers must treat absent as null. */
  profileRef: ProfileRef | null;
  /** The run's generated PDF storage key when the producing flow
   *  stamped one at save time (issue #1239). Optional deliberately:
   *  summaries persisted before #1239 lack the field at runtime;
   *  readers must treat absent as null. */
  pdfKey?: string | null;
  /** The run's partial-coverage qualification when the scan did not
   *  evaluate the full requested universe (issue #1850, R6's
   *  OptionsPartialQualification). Optional deliberately, same pattern
   *  as pdfKey: summaries persisted before #1850 lack the field at
   *  runtime; readers must treat absent as null. Null (not absent)
   *  means the run evaluated completely. */
  partial?: OptionsPartialQualification | null;
  /** The login that saved the run (issue #103 per-user scoping).
   *  Optional deliberately: runs persisted before scoping existed —
   *  and runs saved by contexts with no identity — carry none, and
   *  an absent login is exactly what makes a run "legacy" under the
   *  visibility rule (see visibleToCaller). */
  userLogin?: string;
}

/** A persisted scan run: its summary plus the full result as produced. */
export interface StoredScanRun extends ScanRunSummary {
  result: OpportunityScanResult;
}

export interface ScanRunStore {
  /** Persist a scan result and return the stored run (with its id).
   *  Saving also prunes: rows older than the retention window and rows
   *  beyond the row cap are deleted, oldest first. `userLogin` stamps
   *  the saver's identity for per-user scoping (issue #103); call
   *  sites with no identity omit it and the run is saved unscoped —
   *  identity is never invented here. `id` (issue #1157, E2) lets a
   *  caller that minted the run id BEFORE the scan ran — so fetch-time
   *  captures could be attributed to it — persist the run under that
   *  very id; absent, the store's idFactory mints one as before. */
  save(result: OpportunityScanResult, options?: { userLogin?: string; id?: string }): Promise<StoredScanRun>;
  /** Newest-first summaries (generatedAt descending, id descending on
   *  ties), paginated by limit/offset, filtered by the visibility
   *  rule when a `userLogin` scope is given (and when it is not — an
   *  unscoped caller sees only unscoped runs). */
  list(options?: { limit?: number; offset?: number; userLogin?: string }): Promise<ScanRunSummary[]>;
  /** The full stored run, or null when the id is unknown (or pruned)
   *  or the run is not visible to the `userLogin` scope — invisibility
   *  reads exactly like absence, so a run's existence never leaks
   *  across users. */
  get(id: string, options?: { userLogin?: string }): Promise<StoredScanRun | null>;
  /** Stamp a generated PDF key onto an already-saved run (issue
   *  #1209: the interactive route generates the PDF AFTER the scan is
   *  saved, so the row's pdfKey stays null until this backfill — the
   *  runs-list badge reads pdfKey, so without it the badge never
   *  lights up). Updates both the summary and the stored result so
   *  they agree. Returns true when a visible row was updated, false
   *  when the id is unknown, invisible to `userLogin`, or the key is
   *  blank — invisibility reads exactly like absence. Never throws
   *  for unknown ids; callers that must not fail a response treat
   *  false as "badge stays dark". */
  updatePdfKey(id: string, pdfKey: string, options?: { userLogin?: string }): Promise<boolean>;
  /** Delete rows older than the retention window (relative to `now`)
   *  and rows beyond the row cap; returns how many rows were deleted.
   *  Retention is global (not per-user), as before issue #103. */
  prune(now: Date): Promise<number>;
}

/**
 * The per-user visibility rule (issue #103), applied identically by
 * both stores and relied on by the scans routes: a run saved WITH a
 * userLogin is visible only to that login; a run saved WITHOUT one
 * (everything persisted before issue #103, and anything saved by an
 * identity-less context) is visible to every caller, scoped or not.
 * An unscoped caller (no userLogin) therefore sees only legacy runs.
 */
export function visibleToCaller(summary: ScanRunSummary, userLogin?: string): boolean {
  return summary.userLogin === undefined || summary.userLogin === null || summary.userLogin === userLogin;
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
  `mode TEXT NOT NULL, model_version TEXT NOT NULL, user_login TEXT, summary_json TEXT NOT NULL, result_json TEXT NOT NULL)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_opportunity_scans_generated_at ON ${TABLE} (generated_at DESC)`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, generated_at, mode, model_version, user_login, summary_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)`;
// The visibility predicate lives in the list statement itself (issue
// #103) so pagination walks only rows the caller may see — filtering
// after LIMIT/OFFSET would return short pages. With a NULL scope
// parameter the `user_login = NULL` comparison is never true, so an
// unscoped caller gets exactly the legacy (user_login IS NULL) rows.
const LIST_SQL =
  `SELECT summary_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) ` +
  `ORDER BY generated_at DESC, id DESC LIMIT ? OFFSET ?`;
const GET_SQL = `SELECT summary_json, result_json FROM ${TABLE} WHERE id = ?`;
const UPDATE_PDF_KEY_SQL = `UPDATE ${TABLE} SET summary_json = ?, result_json = ? WHERE id = ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE generated_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY generated_at DESC, id DESC LIMIT ?)`;
const TABLE_INFO_SQL = `PRAGMA table_info(${TABLE})`;
const ADD_USER_LOGIN_COLUMN_SQL = `ALTER TABLE ${TABLE} ADD COLUMN user_login TEXT`;

function summarize(id: string, result: OpportunityScanResult, userLogin?: string): ScanRunSummary {
  return {
    id,
    generatedAt: result.generatedAt,
    mode: result.mode,
    modelVersion: result.modelVersion,
    gate: result.gate,
    coverage: result.coverage,
    profileRef: result.profileRef ?? null,
    pdfKey: result.pdfKey ?? null,
    partial: result.partial ?? null,
    ...(userLogin !== undefined ? { userLogin } : {}),
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
    // Issue #103 migration: tables created before per-user scoping
    // have no user_login column. PRAGMA table_info (the repo's ORM
    // uses the same probe) → ALTER TABLE ADD COLUMN when missing;
    // existing rows read back NULL, which the visibility rule treats
    // as legacy/unscoped. Idempotent: once the column exists the
    // probe finds it and no ALTER runs.
    const columns = Array.from(this.sql.exec(TABLE_INFO_SQL)) as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "user_login")) {
      this.sql.exec(ADD_USER_LOGIN_COLUMN_SQL);
    }
    this.ensured = true;
  }

  private count(): number {
    const rows = Array.from(this.sql.exec(COUNT_SQL)) as Array<{ count: number }>;
    return Number(rows[0]?.count ?? 0);
  }

  async save(result: OpportunityScanResult, options: { userLogin?: string; id?: string } = {}): Promise<StoredScanRun> {
    this.ensure();
    const id = options.id ?? this.idFactory();
    const summary = summarize(id, result, options.userLogin);
    const run: StoredScanRun = { ...summary, result };
    this.sql.exec(
      INSERT_SQL,
      id,
      result.generatedAt,
      result.mode,
      result.modelVersion,
      summary.userLogin ?? null,
      JSON.stringify(summary),
      JSON.stringify(result),
    );
    // Retention is enforced on the write path, relative to the run's
    // own timestamp: a run saved with an old generatedAt (backfill,
    // replay) prunes against its own clock, not the wall clock.
    await this.prune(new Date(result.generatedAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number; userLogin?: string } = {}): Promise<ScanRunSummary[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const rows = Array.from(this.sql.exec(LIST_SQL, options.userLogin ?? null, limit, offset)) as Array<{
      summary_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.summary_json) as ScanRunSummary);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredScanRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
    if (!rows.length) return null;
    const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
    // The summary is the scoping authority (it is what summarize()
    // stamped); an invisible run reads as absent.
    if (!visibleToCaller(summary, options.userLogin)) return null;
    const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
    return { ...summary, result };
  }

  async updatePdfKey(id: string, pdfKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!pdfKey) return false;
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; result_json: string }>;
    if (!rows.length) return false;
    const summary = JSON.parse(rows[0].summary_json) as ScanRunSummary;
    if (!visibleToCaller(summary, options.userLogin)) return false;
    const result = JSON.parse(rows[0].result_json) as OpportunityScanResult;
    summary.pdfKey = pdfKey;
    result.pdfKey = pdfKey;
    this.sql.exec(UPDATE_PDF_KEY_SQL, JSON.stringify(summary), JSON.stringify(result), id);
    return true;
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

  async save(result: OpportunityScanResult, options: { userLogin?: string; id?: string } = {}): Promise<StoredScanRun> {
    const run: StoredScanRun = { ...summarize(options.id ?? this.idFactory(), result, options.userLogin), result };
    this.runs.push(run);
    await this.prune(new Date(result.generatedAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number; userLogin?: string } = {}): Promise<ScanRunSummary[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return [...this.runs]
      .filter((r) => visibleToCaller(r, options.userLogin))
      .sort(byNewestFirst)
      .slice(offset, offset + limit)
      .map(({ result: _result, ...summary }) => summary);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredScanRun | null> {
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return null;
    return run;
  }

  async updatePdfKey(id: string, pdfKey: string, options: { userLogin?: string } = {}): Promise<boolean> {
    if (!pdfKey) return false;
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !visibleToCaller(run, options.userLogin)) return false;
    run.pdfKey = pdfKey;
    run.result = { ...run.result, pdfKey };
    return true;
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
