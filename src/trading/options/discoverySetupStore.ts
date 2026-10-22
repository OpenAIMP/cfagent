/**
 * Discovery (issue #14) — the Phase 1 run store (spec §6, stage 6).
 *
 * Persists one record per discovery run: the expressed setups and
 * the abstentions, with the provenance the spec requires (model
 * version, config hash) and coverage counts that must reconcile
 * (acceptance (e): considered = setups + abstentions +
 * pre-screened-out + errors) — a run whose counts do not reconcile
 * is rejected at save, never stored half-true.
 *
 * This is a separate store from discoveryRunStore.ts on purpose:
 * that store persists the #533/#223 scheduled-analysis lineage
 * (saved requests and profile-derived targets). This one persists
 * the signal-driven Phase 1 pipeline's runs, whose items are
 * inferred setups, and whose scopeKey is the comparability key the
 * delta classification (#14 slice 4, discoveryDelta.ts) runs
 * against: two runs are comparable iff they share a scopeKey.
 *
 * Shape follows the house run-store pattern (scan/discovery
 * stores): an interface with SQL (Durable Object SQLite) and
 * in-memory implementations, the #103 per-user visibility rule, and
 * retention (365 days per Decision 5, plus a row cap) enforced on
 * the write path.
 */

import type { DiscoveryConfidence } from "./discoveryInference";
import type { DiscoverySignalType } from "./discoverySignals";
import type { FitGateBucket } from "./opportunityScanner";
import type { OptionThesis } from "./strategyEngine";

export const DISCOVERY_MODEL_VERSION = "discovery-v1";
export const DISCOVERY_SETUP_RUN_RETENTION_DAYS = 365;
export const DISCOVERY_SETUP_RUN_MAX_ROWS = 1000;

/** One expressed setup: an inferred view the pipeline priced and
 *  the fit gate judged. The evidence line is mandatory — a setup
 *  that cannot say why it exists does not get stored. */
export interface DiscoverySetupExpressedItem {
  kind: "setup";
  symbol: string;
  thesis: OptionThesis;
  ruleId: string;
  confidence: DiscoveryConfidence;
  /** The expressed pick's composite score (0–100) — the number the
   *  delta classification and (in Phase 2) alert thresholds read. */
  discoveryScore: number;
  gateBucket: FitGateBucket;
  targetPrice: number;
  targetDate: string;
  firedSignals: DiscoverySignalType[];
  evidence: string;
}

/** One name the run considered but did not express, with the stage
 *  that stopped it and the reason in plain language. */
export interface DiscoverySetupAbstentionItem {
  kind: "abstention";
  symbol: string;
  stage: "prescreen" | "inference" | "expression";
  reason: string;
  nearMissSignals: DiscoverySignalType[];
}

export type DiscoverySetupItem = DiscoverySetupExpressedItem | DiscoverySetupAbstentionItem;

/** Coverage accounting for a run. `considered` is the universe size
 *  the run started from; every considered name lands in exactly one
 *  bucket (acceptance (e)). */
export interface DiscoveryRunCounts {
  considered: number;
  setups: number;
  abstentions: number;
  prescreenedOut: number;
  errors: number;
}

export function validateDiscoveryRunCounts(
  counts: DiscoveryRunCounts,
  items: readonly DiscoverySetupItem[],
): string | null {
  const setups = items.filter((i) => i.kind === "setup").length;
  const abstentions = items.length - setups;
  if (counts.setups !== setups || counts.abstentions !== abstentions) {
    return (
      `counts disagree with the run's items: counts claim ${counts.setups} setups / ` +
      `${counts.abstentions} abstentions but the items carry ${setups} / ${abstentions}`
    );
  }
  const total = counts.setups + counts.abstentions + counts.prescreenedOut + counts.errors;
  if (total !== counts.considered) {
    return (
      `counts do not reconcile: considered ${counts.considered} != setups + abstentions + ` +
      `prescreenedOut + errors (${total})`
    );
  }
  return null;
}

export interface DiscoverySetupRunInput {
  createdAt: string;
  /** Comparability key: runs sharing a scopeKey are successive
   *  observations of the same discovery scope (a schedule, a
   *  watchlist universe, an ad-hoc NLQ universe). */
  scopeKey: string;
  /** Where the run came from ("schedule" | "nlq" | "unified" | …). */
  source: string;
  /** Hash of the effective discovery + scanner config for the run. */
  configHash: string;
  counts: DiscoveryRunCounts;
  items: DiscoverySetupItem[];
  userLogin?: string;
}

export interface StoredDiscoverySetupRun extends DiscoverySetupRunInput {
  id: string;
  modelVersion: string;
}

export interface DiscoverySetupStore {
  /** Persist one run and return it stored. Saving prunes
   *  (retention window + row cap, oldest first). Throws when the
   *  run's counts do not reconcile. */
  save(input: DiscoverySetupRunInput): Promise<StoredDiscoverySetupRun>;
  /** Newest-first runs visible to the caller, optionally scoped. */
  list(options?: {
    limit?: number;
    offset?: number;
    scopeKey?: string;
    userLogin?: string;
  }): Promise<StoredDiscoverySetupRun[]>;
  /** The full stored run, or null when unknown/pruned/not visible —
   *  invisibility reads exactly like absence (#103). */
  get(id: string, options?: { userLogin?: string }): Promise<StoredDiscoverySetupRun | null>;
  /** The newest run for a scope — the delta baseline — or null. */
  latestForScope(scopeKey: string, options?: { userLogin?: string }): Promise<StoredDiscoverySetupRun | null>;
  /** Delete rows older than the retention window and rows beyond
   *  the row cap; returns how many rows were deleted. */
  prune(now: Date): Promise<number>;
}

/** The #103 visibility rule, identical to the sibling stores'. */
export function discoverySetupRunVisibleToCaller(
  run: Pick<StoredDiscoverySetupRun, "userLogin">,
  userLogin?: string,
): boolean {
  return run.userLogin === undefined || run.userLogin === null || run.userLogin === userLogin;
}

export interface DiscoverySetupStoreOptions {
  idFactory?: () => string;
  retentionDays?: number;
  maxRows?: number;
}

/** Minimal SQL executor matching the Durable Object SqlStorage
 *  `exec` signature (the same structural shape the sibling stores
 *  declare). */
export interface DiscoverySetupSqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

const TABLE = "mas_discovery_setup_runs";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, ` +
  `scope_key TEXT NOT NULL, user_login TEXT, run_json TEXT NOT NULL)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_discovery_setup_runs_created_at ON ${TABLE} (created_at DESC)`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, created_at, scope_key, user_login, run_json) VALUES (?, ?, ?, ?, ?)`;
// The visibility predicate lives in the list statement itself
// (issue #103), exactly as in the sibling stores.
const LIST_SQL =
  `SELECT run_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) ` +
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
const LIST_SCOPED_SQL =
  `SELECT run_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) AND scope_key = ? ` +
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
const GET_SQL = `SELECT run_json FROM ${TABLE} WHERE id = ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE created_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY created_at DESC, id DESC LIMIT ?)`;

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

function byNewestFirst(a: StoredDiscoverySetupRun, b: StoredDiscoverySetupRun): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function assertReconciled(input: DiscoverySetupRunInput): void {
  const error = validateDiscoveryRunCounts(input.counts, input.items);
  if (error) throw new Error(`discovery run rejected: ${error}`);
}

export class SqlDiscoverySetupStore implements DiscoverySetupStore {
  private ensured = false;
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(
    private readonly sql: DiscoverySetupSqlExecutor,
    options: DiscoverySetupStoreOptions = {},
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_SETUP_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_SETUP_RUN_MAX_ROWS;
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

  async save(input: DiscoverySetupRunInput): Promise<StoredDiscoverySetupRun> {
    assertReconciled(input);
    this.ensure();
    const run: StoredDiscoverySetupRun = {
      ...input,
      id: this.idFactory(),
      modelVersion: DISCOVERY_MODEL_VERSION,
    };
    this.sql.exec(
      INSERT_SQL,
      run.id,
      run.createdAt,
      run.scopeKey,
      run.userLogin ?? null,
      JSON.stringify(run),
    );
    // Retention is enforced on the write path, relative to the
    // run's own timestamp (same discipline as the sibling stores).
    await this.prune(new Date(input.createdAt));
    return run;
  }

  async list(
    options: { limit?: number; offset?: number; scopeKey?: string; userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const rows = (
      options.scopeKey !== undefined
        ? Array.from(this.sql.exec(LIST_SCOPED_SQL, options.userLogin ?? null, options.scopeKey, limit, offset))
        : Array.from(this.sql.exec(LIST_SQL, options.userLogin ?? null, limit, offset))
    ) as Array<{ run_json: string }>;
    return rows.map((r) => JSON.parse(r.run_json) as StoredDiscoverySetupRun);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoverySetupRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ run_json: string }>;
    if (!rows[0]) return null;
    const run = JSON.parse(rows[0].run_json) as StoredDiscoverySetupRun;
    return discoverySetupRunVisibleToCaller(run, options.userLogin) ? run : null;
  }

  async latestForScope(
    scopeKey: string,
    options: { userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun | null> {
    const [latest] = await this.list({ scopeKey, limit: 1, userLogin: options.userLogin });
    return latest ?? null;
  }

  async prune(now: Date): Promise<number> {
    this.ensure();
    const before = this.count();
    this.sql.exec(PRUNE_AGE_SQL, retentionCutoff(now, this.retentionDays));
    this.sql.exec(PRUNE_CAP_SQL, this.maxRows);
    return before - this.count();
  }
}

export class InMemoryDiscoverySetupStore implements DiscoverySetupStore {
  private runs: StoredDiscoverySetupRun[] = [];
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(options: DiscoverySetupStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_SETUP_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_SETUP_RUN_MAX_ROWS;
  }

  async save(input: DiscoverySetupRunInput): Promise<StoredDiscoverySetupRun> {
    assertReconciled(input);
    const run: StoredDiscoverySetupRun = {
      ...input,
      id: this.idFactory(),
      modelVersion: DISCOVERY_MODEL_VERSION,
    };
    this.runs.push(run);
    await this.prune(new Date(input.createdAt));
    return run;
  }

  async list(
    options: { limit?: number; offset?: number; scopeKey?: string; userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return this.runs
      .filter((r) => discoverySetupRunVisibleToCaller(r, options.userLogin))
      .filter((r) => options.scopeKey === undefined || r.scopeKey === options.scopeKey)
      .sort(byNewestFirst)
      .slice(offset, offset + limit);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoverySetupRun | null> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return null;
    return discoverySetupRunVisibleToCaller(run, options.userLogin) ? run : null;
  }

  async latestForScope(
    scopeKey: string,
    options: { userLogin?: string } = {},
  ): Promise<StoredDiscoverySetupRun | null> {
    const [latest] = await this.list({ scopeKey, limit: 1, userLogin: options.userLogin });
    return latest ?? null;
  }

  async prune(now: Date): Promise<number> {
    const cutoff = retentionCutoff(now, this.retentionDays);
    const before = this.runs.length;
    const fresh = this.runs.filter((r) => r.createdAt >= cutoff).sort(byNewestFirst);
    this.runs = fresh.slice(0, this.maxRows);
    return before - this.runs.length;
  }
}
