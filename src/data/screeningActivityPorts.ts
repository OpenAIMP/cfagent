/**
 * Issue #2356 (#1976 step 4c, ADR 0022 D-I step 4) —
 * screening activity port for the evidence satellites.
 *
 * ADR D-0 ruled this family DO-resident behind a port (audit
 * §3): tenant-scoped by user_login like every mas_* store,
 * read by the same instance's UI feed. This module carries
 * the record types and the port interface ONLY (ADR 0002
 * R1/R2). Adapters: doSqliteScreeningActivityAdapter.ts
 * (production), inMemoryScreeningActivityAdapter.ts (test
 * double). Types moved here from src/services/
 * screeningActivity.ts, now a re-export shim.
 *
 * Recording NEVER throws is part of the contract: a failed
 * activity write returns null (and is logged by the
 * adapter), never allowed to break the work it describes.
 * The unified feed's merge lives in the service shim: it
 * composes this port's entries with the re-selection source
 * (step 4b's family) and this port's promotion read-through
 * rows, each source failing independently.
 */

export const SCREENING_ACTIVITY_TABLE = "mas_screening_activity";

export type ScreeningActivityKind =
  | "discovery_run"
  | "screen_run"
  /** Consolidation C3 (#1277): one entry per stage-chain stage
   *  transition (stage completed / failed / skipped / held, with
   *  the reason in the summary + detail). */
  | "stage"
  | "goal_decision"
  | "reselection"
  | "weights_adjustment"
  | "promotion"
  | "delivery"
  | "schedule_control"
  | "bundle";

export interface ScreeningActivityEntry {
  id: string;
  userLogin: string;
  kind: ScreeningActivityKind;
  summary: string;
  detail: unknown;
  refId: string | null;
  actor: string | null;
  createdAt: string;
}

export interface ScreeningActivityFeedItem {
  id: string;
  at: string;
  kind: ScreeningActivityKind;
  summary: string;
  source: "activity" | "reselection" | "promotion";
  detail?: unknown;
}

export interface RecordScreeningActivityInput {
  userLogin: string;
  kind: ScreeningActivityKind;
  summary: string;
  detail?: unknown;
  refId?: string;
  actor?: string;
  createdAt?: string;
}

/** One challenger-promotion row as the feed consumes it
 *  (read-through to mas_challenger_promotions, step 4b's
 *  table — read-only here, exactly as the legacy feed). */
export interface PromotionFeedRow {
  id: string;
  challenger_id: unknown;
  action: unknown;
  actor: unknown;
  reason: unknown;
  weights_version: unknown;
  created_at: string;
}

/** The screening-activity contract (sync, mirroring the
 *  legacy module's seam). */
export interface ScreeningActivityStore {
  ensureTable(): void;
  /** Append one entry; the entry id, or null when the write
   *  failed or the input was incomplete (never throws). */
  record(input: RecordScreeningActivityInput): string | null;
  /** One tenant's recorded activity, newest first. Never
   *  throws; a broken store reads as empty. */
  list(userLogin: string, limit?: number): ScreeningActivityEntry[];
  /** The promotion read-through rows for the unified feed. */
  listPromotionRows(userLogin: string, limit?: number): PromotionFeedRow[];
}

export interface ScreeningActivitySqlExecutor {
  exec(query: string, ...params: unknown[]): Iterable<unknown>;
}
