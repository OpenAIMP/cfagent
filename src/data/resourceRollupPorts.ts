/**
 * Issue #2362 (#1976 step 4f) — the resource rollup store
 * port (the #1819 ScheduledAgent goals' D1 store).
 *
 * The three tables' DDL authority is migration 0022
 * (src/data/migrationRunner.ts); before this slice the
 * telemetry module self-created them at runtime (step-4
 * audit R-8). `ensureSchema()` remains an explicit port
 * operation carrying the same DDL (idempotent; a no-op where
 * the runner has applied 0022), because the goal paths call
 * it deliberately at goal start.
 *
 * DECLARED ERROR DIRECTION (the port contract, previously
 * the legacy module's prose): unlike the per-op record path
 * (which never throws), every operation here THROWS on store
 * failure — including reads and writes made before
 * `ensureSchema()` against a store missing the tables. A
 * failing goal must stay due and surface a tick error, not
 * silently certify an empty rollup. No operation
 * self-ensures implicitly; characterization pins this.
 */
import type { DailyRollupRow } from "../telemetry/resourceRollup";

export interface AlertState {
  budget: string;
  day: string;
  alerted_at: number;
  delivered: number;
  note: string | null;
}

export interface ResourceRollupStorePort {
  /** Create the three rollup tables (idempotent). */
  ensureSchema(): Promise<void>;
  /** Replace-write one day's rollup rows (idempotent re-run). */
  writeDailyRollup(day: string, rows: readonly DailyRollupRow[]): Promise<void>;
  /** One day's rows, ordered by ns, op, caller, trigger. */
  readDailyRollup(day: string): Promise<DailyRollupRow[]>;
  /** Latest day with any rollup row, or null before the first. */
  latestCompletedRollupDay(): Promise<string | null>;
  getAlertState(budget: string, day: string): Promise<AlertState | null>;
  markAlerted(
    budget: string,
    day: string,
    delivered: boolean,
    note: string | null,
  ): Promise<void>;
  writeComparisonReport(day: string, report: unknown): Promise<void>;
  readComparisonReport(day: string): Promise<unknown | null>;
}
