/**
 * Persistence for scheduled strategy-discovery runs (issue #126, PR-E).
 *
 * Interactive discovery (POST /api/trading/options/strategies) returns
 * its ranking inline and stores nothing, so a discovery that runs on a
 * schedule would vanish the moment it finished. This module is the
 * persistence seam for the scheduled path, mirroring scanRunStore.ts
 * (issue #27) statement-for-statement: same DO-SQLite pattern, same
 * lazy table ensure, same per-user visibility rule (issue #103), same
 * retention discipline.
 *
 * Two input models produce runs. "saved-request" (user decision on
 * issue #126, 2026-10-20): a schedule stores complete StrategyRequests
 * captured from the discovery panel and the task re-runs them verbatim
 * — the store therefore persists the requests themselves next to their
 * outcomes, so a stored run always shows exactly which view produced
 * it. "profile-derived" (issue #533): a schedule stores a symbol set
 * plus a Strategy Profile id; at fire time the service DERIVES each
 * symbol's target from its own live chain (spot ± expected move under
 * the profile's thesis) and persists the constructed requests, the
 * profile reference, and the full derivation per symbol — a derived
 * target is labelled DERIVED on every surface and is never mistaken
 * for a configured view. Symbols whose inputs cannot be derived
 * honestly abstain (outcome status "abstained", reason recorded, no
 * request, no target). "no-view" (issue #534): a schedule stores
 * constraint sets — symbols plus risk/DTE/liquidity constraints, with
 * NO thesis and NO target anywhere; at fire time each symbol's live
 * chain is ranked by the target-free score model (no-view-v1) and the
 * stored constraint set is persisted verbatim next to its outcome,
 * stamped with the mode's declared IV constant. A symbol whose chain
 * loads but where nothing clears the gates is a completed outcome
 * flagged abstained (ranked empty, best pick no_trade) — never a
 * failure and never a manufactured pick.
 *
 * One deliberate trim vs the pipeline's inline response: per-symbol
 * outcomes persist the ranked set, risk reports, screened-out list
 * (capped at 50, like the strategies route), exclusions, best trade,
 * and the snapshot's screen summary + data provenance — but NOT the
 * snapshot's full contract list. Contracts are live market data
 * (re-derivable on demand, and huge next to the ranked set); the
 * ranked candidates carry their own legs and prices.
 */

import type { NoViewStrategyRequest, OptionThesis, StrategyRequest } from "./strategyEngine";
import type { ProfileRef } from "./strategyProfile";
import type { OptionsDataSnapshot } from "./optionsDataAgent";
import type { BestNoViewTradePick, BestTradePick, RankedNoViewStrategy, RankedStrategy } from "./recommendationAgent";
import type { StrategyRiskReport } from "./strategyRiskAgent";
import type { StrategyRecommendationResult } from "./strategyEngine";

/** Days a persisted discovery run is retained. 365 matches the settled
 *  discovery-run retention (user decision 2026-10-13: keep a year of
 *  runs for calibration) and the scan store's window. */
export const DISCOVERY_RUN_RETENTION_DAYS = 365;

/** Hard row cap for the discovery-run table (oldest pruned first). */
export const DISCOVERY_RUN_MAX_ROWS = 1000;

/** Cap on saved requests per run: a schedule re-runs each request
 *  against a live chain fetch, so an unbounded list would let one
 *  schedule arm an unbounded amount of broker work per fire. 25 names
 *  matches the curated-universe scale the scanner works at. */
export const MAX_SAVED_REQUESTS_PER_RUN = 25;

/** How a stored run was triggered. Scheduled fires come through the
 *  OrchestratorAgent callback; the trigger route is a manual fire of
 *  the same task and is recorded distinctly ("manual-trigger"). */
export type DiscoveryRunTrigger = "scheduled" | "manual-trigger";

/** Run-level outcome. "partial" means at least one saved request
 *  completed and at least one failed; "failed" means every request
 *  failed — such a run is surfaced as a task failure (issue #112
 *  contract), and the record exists so the failure is diagnosable,
 *  never as a success. */
export type DiscoveryRunStatus = "completed" | "partial" | "failed";

/** How a stored run's inputs were produced. "saved-request": complete
 *  StrategyRequests captured from the panel, re-run verbatim (issue
 *  #126). "profile-derived": a symbol set + Strategy Profile, targets
 *  derived per symbol at fire time (issue #533). "no-view": constraint
 *  sets only — no thesis, no target, ranked by the target-free score
 *  model (issue #534). Recorded on every run so the three can never
 *  be confused. */
export type DiscoveryInputModel = "saved-request" | "profile-derived" | "no-view";

/**
 * The full derivation of one symbol's target in a profile-derived run
 * (issue #533): everything a reader needs to see HOW the target was
 * produced — it is a derived number, not a user view, and it is shown
 * alongside the target on every surface. `targetPrice` here always
 * equals the constructed request's targetPrice.
 */
export interface DiscoveryTargetDerivation {
  source: "profile-derived";
  /** Spot: the underlying price carried by the symbol's own chain fetch. */
  spot: number;
  spotSource: "chain";
  /** Implied volatility of the most-ATM contract in the profile's DTE window. */
  atmIv: number;
  /** Expected move to the window expiry as a fraction of spot: atmIv × sqrt(windowDays/365). */
  expectedMovePct: number;
  /** Expiry of the contract the expected move was taken from — the derivation window's end. */
  windowExpiry: string;
  windowDays: number;
  /** The resolved scanner-config EM multiple for the profile's thesis. */
  emMultiple: number;
  thesis: OptionThesis;
  /** spot × (1 + emMultiple × expectedMovePct), rounded to 2dp. */
  targetPrice: number;
  profileRef: ProfileRef;
}

/**
 * One symbol's input record in a no-view run (issue #534): the
 * constraint set exactly as armed — stored verbatim so a reader can
 * always see what constrained the run and that no view did — plus the
 * mode's IV assumption. The IV direction is a declared constant of
 * the mode (decision 4 on #534: fixed to "unchanged", never
 * user-settable in v1, since a settable IV lean would be a partial
 * view), stamped here rather than left as a hidden default.
 */
export interface DiscoveryConstraintSet {
  source: "no-view";
  /** The constraint set exactly as stored on the schedule: symbol +
   *  constraints only. The type carries no thesis/target fields. */
  request: NoViewStrategyRequest;
  /** The mode's declared IV constant ("unchanged") at fire time. */
  expectedIvDirection: "unchanged";
}

/** The outcome of running (or attempting) one symbol of a discovery run. */
export interface DiscoverySymbolOutcome {
  symbol: string;
  status: "completed" | "failed" | "abstained";
  /** The request that ran for this symbol: the saved request exactly
   *  as stored (saved-request runs), or the constructed request
   *  (profile-derived runs). ABSENT for abstained outcomes — an
   *  abstention produced no request and no target. */
  request?: StrategyRequest;
  /** Profile-derived runs: how this symbol's target was derived.
   *  Present on completed/failed outcomes, and on abstentions that
   *  got far enough to compute a target before abstaining. */
  derivation?: DiscoveryTargetDerivation;
  /** No-view runs: the constraint set that produced this outcome,
   *  stored verbatim (see DiscoveryConstraintSet). Present on every
   *  no-view outcome — the mode's input record, in place of a view. */
  constraintSet?: DiscoveryConstraintSet;
  /** No-view runs only: TRUE on a completed outcome where the chain
   *  loaded but no structure cleared the stated constraints — an
   *  abstention, recorded with its gate reasons in `excluded`, an
   *  empty ranked set and a no_trade best pick. Never set on failed
   *  outcomes; the profile-derived model's abstentions use the
   *  "abstained" status instead (no chain ever ran there). */
  abstained?: boolean;
  /** Present when status is "completed": mirrors the strategies
   *  route's response shape for this symbol. */
  ranked?: RankedStrategy[];
  /** No-view runs: the ranked structures under the constraint set
   *  (score model no-view-v1), the counterpart of `ranked` for a mode
   *  whose candidates carry no target fields. Empty on a no-view
   *  abstention. */
  rankedNoView?: RankedNoViewStrategy[];
  riskReports?: StrategyRiskReport[];
  screenedOut?: Array<{ id: string; reason: string }>;
  excluded?: StrategyRecommendationResult["excluded"];
  bestTrade?: BestTradePick;
  /** No-view runs: the capped best pick (status research_only or
   *  no_trade, never "recommended"), the counterpart of `bestTrade`. */
  bestNoViewTrade?: BestNoViewTradePick;
  /** Snapshot provenance summary (screen block + data source + any
   *  validation error), without the contract list — see module doc. */
  snapshot?: {
    dataSource: OptionsDataSnapshot["dataSource"];
    screen: OptionsDataSnapshot["screen"];
    validationError?: string;
  };
  /** Consolidation #1236 (feed seam): present when this symbol ran
   *  in snapshot-input mode — which stored artifact fed generate,
   *  its asOf, and whether it was stale against the run's
   *  maxAgeSeconds. Absent on live-loaded symbols. */
  snapshotInput?: {
    artifactId: string;
    asOf: string;
    stale: boolean;
  };
  /** Present when status is "failed" or "abstained": the honest
   *  reason (pipeline throw, snapshot validation error, the recorded
   *  upstream cause, or the abstention reason) — never secret
   *  material. */
  error?: string;
}

/** The listing projection of a stored discovery run. */
export interface DiscoveryRunSummary {
  id: string;
  createdAt: string;
  /** The login that owns the run (issue #103 scoping). Optional
   *  deliberately: an absent login is what makes a run "legacy" under
   *  the visibility rule. Scheduled runs are always saved WITH the
   *  schedule owner's login — identity is never invented here. */
  userLogin?: string;
  trigger: DiscoveryRunTrigger;
  /** The arming schedule's id when the caller supplied one. */
  scheduleId?: string;
  /** How the run's inputs were produced (see DiscoveryInputModel). */
  inputModel: DiscoveryInputModel;
  /** Profile-derived runs: the profile the targets were derived
   *  under, stamped with its version at fire time. */
  profileRef?: ProfileRef;
  status: DiscoveryRunStatus;
  /** Inputs that ran: saved requests (saved-request runs), constructed
   *  requests (profile-derived runs — abstained symbols contribute
   *  none), or constraint sets (no-view runs). */
  requestCount: number;
  /** Completed outcomes that produced a ranked result — no-view
   *  abstentions are completed outcomes but count separately below,
   *  never here. */
  completedCount: number;
  /** Failed outcomes only — abstentions are counted separately. */
  failedCount: number;
  abstainedCount: number;
  /** Every symbol the run attempted (constructed + abstained), in order. */
  symbols: string[];
}

/** A persisted discovery run: summary plus requests and outcomes. */
export interface StoredDiscoveryRun extends DiscoveryRunSummary {
  requests: StrategyRequest[];
  /** No-view runs: the run's constraint sets, verbatim (issue #534).
   *  Absent for the other input models. */
  constraintSets?: DiscoveryConstraintSet[];
  outcomes: DiscoverySymbolOutcome[];
}

/** What a caller hands the store to persist one execution. The store
 *  assigns the id and derives the summary counts from the outcomes. */
export interface DiscoveryRunInput {
  createdAt: string;
  trigger: DiscoveryRunTrigger;
  scheduleId?: string;
  userLogin?: string;
  /** Required — stamped verbatim onto the run. No default: a caller
   *  must name its model so a future model can never be silently
   *  stamped as an existing one. */
  inputModel: DiscoveryInputModel;
  /** Profile-derived runs: the resolved profile reference. */
  profileRef?: ProfileRef;
  requests: StrategyRequest[];
  /** No-view runs: the constraint sets that ran, verbatim (issue
   *  #534). `requests` is empty for this model — no StrategyRequest
   *  exists anywhere in it. */
  constraintSets?: DiscoveryConstraintSet[];
  outcomes: DiscoverySymbolOutcome[];
  status: DiscoveryRunStatus;
}

export interface DiscoveryRunStore {
  /** Persist one execution and return the stored run. Saving also
   *  prunes (retention window + row cap, oldest first). */
  save(input: DiscoveryRunInput): Promise<StoredDiscoveryRun>;
  /** Newest-first summaries (createdAt descending, id descending on
   *  ties), paginated, filtered by the issue #103 visibility rule. */
  list(options?: { limit?: number; offset?: number; userLogin?: string }): Promise<DiscoveryRunSummary[]>;
  /** The full stored run, or null when unknown/pruned/not visible to
   *  the scope — invisibility reads exactly like absence. */
  get(id: string, options?: { userLogin?: string }): Promise<StoredDiscoveryRun | null>;
  /** Delete rows older than the retention window and rows beyond the
   *  row cap; returns how many rows were deleted. */
  prune(now: Date): Promise<number>;
}

/**
 * The per-user visibility rule (issue #103), identical to the scan
 * store's: a run saved WITH a userLogin is visible only to that
 * login; a run saved WITHOUT one is visible to every caller. An
 * unscoped caller sees only unscoped runs.
 */
export function discoveryRunVisibleToCaller(
  summary: Pick<DiscoveryRunSummary, "userLogin">,
  userLogin?: string,
): boolean {
  return summary.userLogin === undefined || summary.userLogin === null || summary.userLogin === userLogin;
}

/**
 * Minimal SQL executor matching the Durable Object SqlStorage `exec`
 * signature (the same structural shape scanRunStore.ts declares).
 */
export interface DiscoverySqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}

export interface DiscoveryRunStoreOptions {
  /** Id factory for new runs. Default: crypto.randomUUID(). */
  idFactory?: () => string;
  /** Retention window override (days). Default DISCOVERY_RUN_RETENTION_DAYS. */
  retentionDays?: number;
  /** Row-cap override. Default DISCOVERY_RUN_MAX_ROWS. */
  maxRows?: number;
}

const TABLE = "mas_discovery_runs";

const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, ` +
  `status TEXT NOT NULL, user_login TEXT, summary_json TEXT NOT NULL, run_json TEXT NOT NULL)`;
const CREATE_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_mas_discovery_runs_created_at ON ${TABLE} (created_at DESC)`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (id, created_at, status, user_login, summary_json, run_json) VALUES (?, ?, ?, ?, ?, ?)`;
// The visibility predicate lives in the list statement itself (issue
// #103), exactly as in the scan store: pagination walks only rows the
// caller may see, and a NULL scope parameter matches only NULL-login
// rows because `user_login = NULL` is never true in SQLite.
const LIST_SQL =
  `SELECT summary_json FROM ${TABLE} WHERE (user_login IS NULL OR user_login = ?) ` +
  `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
const GET_SQL = `SELECT summary_json, run_json FROM ${TABLE} WHERE id = ?`;
const COUNT_SQL = `SELECT COUNT(*) AS count FROM ${TABLE}`;
const PRUNE_AGE_SQL = `DELETE FROM ${TABLE} WHERE created_at < ?`;
const PRUNE_CAP_SQL =
  `DELETE FROM ${TABLE} WHERE id NOT IN (SELECT id FROM ${TABLE} ORDER BY created_at DESC, id DESC LIMIT ?)`;

function summarize(input: DiscoveryRunInput, id: string): DiscoveryRunSummary {
  // An outcome counts as an abstention either by status (the
  // profile-derived model, where no request ever ran) or by the
  // abstained flag on a completed outcome (the no-view model, where
  // the chain loaded and the gates rejected everything). Abstentions
  // never count as completions or failures. Neither marker exists on
  // saved-request outcomes, so their counts are unchanged.
  const isAbstention = (o: DiscoverySymbolOutcome) => o.status === "abstained" || o.abstained === true;
  const completedCount = input.outcomes.filter((o) => o.status === "completed" && !isAbstention(o)).length;
  const abstainedCount = input.outcomes.filter(isAbstention).length;
  return {
    id,
    createdAt: input.createdAt,
    ...(input.userLogin !== undefined ? { userLogin: input.userLogin } : {}),
    trigger: input.trigger,
    ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
    inputModel: input.inputModel,
    ...(input.profileRef !== undefined ? { profileRef: input.profileRef } : {}),
    status: input.status,
    requestCount:
      input.inputModel === "no-view" ? (input.constraintSets?.length ?? 0) : input.requests.length,
    completedCount,
    failedCount: input.outcomes.length - completedCount - abstainedCount,
    abstainedCount,
    // Every attempted symbol, in order: the outcomes are the attempt
    // record (for saved runs their symbols are the requests' own,
    // normalized identically by the service).
    symbols:
      input.outcomes.length > 0
        ? input.outcomes.map((o) => o.symbol)
        : input.requests.map((r) => r.symbol.toUpperCase().trim()),
  };
}

function retentionCutoff(now: Date, retentionDays: number): string {
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
}

/** Newest-first ordering shared by both stores: createdAt descending,
 *  id descending on ties (matches the SQL ORDER BY exactly). */
function byNewestFirst(a: DiscoveryRunSummary, b: DiscoveryRunSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * DiscoveryRunStore over Durable Object SQLite. The table is ensured
 * lazily on first use, mirroring SqlScanRunStore. Unlike the scan
 * table this one is born with its user_login column (it postdates
 * issue #103), so no migration probe is needed.
 */
export class SqlDiscoveryRunStore implements DiscoveryRunStore {
  private ensured = false;
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(
    private readonly sql: DiscoverySqlExecutor,
    options: DiscoveryRunStoreOptions = {},
  ) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_RUN_MAX_ROWS;
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

  async save(input: DiscoveryRunInput): Promise<StoredDiscoveryRun> {
    this.ensure();
    const id = this.idFactory();
    const summary = summarize(input, id);
    const run: StoredDiscoveryRun = {
      ...summary,
      requests: input.requests,
      ...(input.constraintSets !== undefined ? { constraintSets: input.constraintSets } : {}),
      outcomes: input.outcomes,
    };
    this.sql.exec(
      INSERT_SQL,
      id,
      input.createdAt,
      input.status,
      summary.userLogin ?? null,
      JSON.stringify(summary),
      JSON.stringify({
        requests: input.requests,
        ...(input.constraintSets !== undefined ? { constraintSets: input.constraintSets } : {}),
        outcomes: input.outcomes,
      }),
    );
    // Retention is enforced on the write path, relative to the run's
    // own timestamp (same discipline as the scan store).
    await this.prune(new Date(input.createdAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number; userLogin?: string } = {}): Promise<DiscoveryRunSummary[]> {
    this.ensure();
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    const rows = Array.from(this.sql.exec(LIST_SQL, options.userLogin ?? null, limit, offset)) as Array<{
      summary_json: string;
    }>;
    return rows.map((r) => JSON.parse(r.summary_json) as DiscoveryRunSummary);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoveryRun | null> {
    this.ensure();
    const rows = Array.from(this.sql.exec(GET_SQL, id)) as Array<{ summary_json: string; run_json: string }>;
    if (!rows.length) return null;
    const summary = JSON.parse(rows[0].summary_json) as DiscoveryRunSummary;
    // The summary is the scoping authority; an invisible run reads as absent.
    if (!discoveryRunVisibleToCaller(summary, options.userLogin)) return null;
    const body = JSON.parse(rows[0].run_json) as Pick<
      StoredDiscoveryRun,
      "requests" | "outcomes" | "constraintSets"
    >;
    return {
      ...summary,
      requests: body.requests,
      ...(body.constraintSets !== undefined ? { constraintSets: body.constraintSets } : {}),
      outcomes: body.outcomes,
    };
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
 * In-memory DiscoveryRunStore with semantics identical to
 * SqlDiscoveryRunStore — for tests and identity-less contexts.
 */
export class InMemoryDiscoveryRunStore implements DiscoveryRunStore {
  private runs: StoredDiscoveryRun[] = [];
  private readonly idFactory: () => string;
  private readonly retentionDays: number;
  private readonly maxRows: number;

  constructor(options: DiscoveryRunStoreOptions = {}) {
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.retentionDays = options.retentionDays ?? DISCOVERY_RUN_RETENTION_DAYS;
    this.maxRows = options.maxRows ?? DISCOVERY_RUN_MAX_ROWS;
  }

  async save(input: DiscoveryRunInput): Promise<StoredDiscoveryRun> {
    const run: StoredDiscoveryRun = {
      ...summarize(input, this.idFactory()),
      requests: input.requests,
      ...(input.constraintSets !== undefined ? { constraintSets: input.constraintSets } : {}),
      outcomes: input.outcomes,
    };
    this.runs.push(run);
    await this.prune(new Date(input.createdAt));
    return run;
  }

  async list(options: { limit?: number; offset?: number; userLogin?: string } = {}): Promise<DiscoveryRunSummary[]> {
    const limit = options.limit ?? 25;
    const offset = options.offset ?? 0;
    return [...this.runs]
      .filter((r) => discoveryRunVisibleToCaller(r, options.userLogin))
      .sort(byNewestFirst)
      .slice(offset, offset + limit)
      .map(({ requests: _requests, outcomes: _outcomes, ...summary }) => summary);
  }

  async get(id: string, options: { userLogin?: string } = {}): Promise<StoredDiscoveryRun | null> {
    const run = this.runs.find((r) => r.id === id) ?? null;
    if (!run || !discoveryRunVisibleToCaller(run, options.userLogin)) return null;
    return run;
  }

  async prune(now: Date): Promise<number> {
    const cutoff = retentionCutoff(now, this.retentionDays);
    const kept = [...this.runs]
      .sort(byNewestFirst)
      .filter((r) => r.createdAt >= cutoff)
      .slice(0, this.maxRows);
    const deleted = this.runs.length - kept.length;
    this.runs = kept;
    return deleted;
  }
}
