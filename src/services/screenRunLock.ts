/**
 * Issue #1993: atomic run lock for screens.
 *
 * The #828 lock was check-then-act over async KV (`get` → `put` with
 * awaits between), so two truly simultaneous `runScreen` calls on the
 * same ScreenerAgent instance could both pass the check. This module
 * moves the lock into that instance's own SQLite (`ctx.storage.sql`),
 * whose `exec` is synchronous: every function below runs start to
 * finish with no awaits, so check-and-write cannot interleave. One row
 * per user + universe, same scope and 5-minute stale takeover as #828,
 * plus tokenized release (only the holder's token frees the row).
 *
 * The lock is deliberately instance-local, not shared-store: the
 * monolithic scheduled / Trigger-Now path already delegates to
 * `ScreenerAgent.runScreen` on the same per-owner instance
 * (`screener:<login>`), so one instance-local lock covers manual,
 * scheduled, Trigger-Now, and workflow runs alike. The sharded path,
 * which bypasses `runScreen`, gates on this lock via the
 * `isScreenRunning` probe instead of acquiring it (a chain outlives
 * any submission-scoped lease).
 *
 * DEPRECATED (#2361, #1976 step 4e): superseded by the
 * ScreenRunLockPort in src/data/screenRunLockPorts.ts (DO adapter:
 * src/data/doSqliteScreenRunLockAdapter.ts; composition:
 * src/data/createScreenRunLockPorts.ts), and ScreenerAgent consumes
 * the port directly. These functions remain as a deprecated delegate
 * for their existing callers/tests: each one composes the port over
 * the caller's executor and forwards, so the statements — and every
 * behaviour pinned against them — are the adapter's own.
 */

import { DoSqliteScreenRunLock } from "../data/doSqliteScreenRunLockAdapter";
import {
  SCREEN_RUN_LOCK_STALE_MS as PORT_SCREEN_RUN_LOCK_STALE_MS,
  type ScreenRunLockPort,
} from "../data/screenRunLockPorts";
import type { SqlStorage } from "../data/repositoryPorts";

export const SCREEN_RUN_LOCK_STALE_MS = PORT_SCREEN_RUN_LOCK_STALE_MS;

/** Synchronous SQL executor: DO `storage.sql.exec` shape, adapted. */
export type ScreenRunLockSql = (
  sql: string,
  params: unknown[],
) => Array<Record<string, unknown>>;

export interface ScreenRunLockAcquisition {
  acquired: boolean;
  /** Present only when acquired; the release token. */
  token: string | null;
  /** Epoch ms the current holder started; null when no row exists. */
  startedAt: number | null;
  /** True when this acquisition took over a stale row. */
  tookOverStale: boolean;
}

/** Compose the port over a legacy callback executor. */
function portOver(exec: ScreenRunLockSql): ScreenRunLockPort {
  const storage: SqlStorage = {
    exec: (query: string, ...params: unknown[]) => exec(query, params),
  };
  return new DoSqliteScreenRunLock(storage);
}

export function ensureScreenRunLockTable(
  exec: ScreenRunLockSql,
): void {
  portOver(exec).ensureSchema();
}

/**
 * Acquire the lock for one user + universe. Synchronous throughout:
 * callers must pass a synchronous executor (DO `storage.sql`), never
 * an async wrapper, or the atomicity this module exists for is lost.
 */
export function acquireScreenRunLock(
  exec: ScreenRunLockSql,
  userLogin: string,
  universe: string,
  now: number = Date.now(),
): ScreenRunLockAcquisition {
  return portOver(exec).acquire(userLogin, universe, now);
}

/** Release only when the token matches: never frees another run's lock. */
export function releaseScreenRunLock(
  exec: ScreenRunLockSql,
  userLogin: string,
  universe: string,
  token: string | null,
): void {
  portOver(exec).release(userLogin, universe, token);
}

/** Probe for the sharded submission gate: stale rows do not count. */
export function isScreenRunning(
  exec: ScreenRunLockSql,
  userLogin: string,
  universe: string,
  now: number = Date.now(),
): { running: boolean; startedAt: number | null } {
  return portOver(exec).isRunning(userLogin, universe, now);
}
