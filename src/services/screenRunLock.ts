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
 */

export const SCREEN_RUN_LOCK_STALE_MS = 5 * 60 * 1000;

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

export function ensureScreenRunLockTable(
  exec: ScreenRunLockSql,
): void {
  exec(
    `CREATE TABLE IF NOT EXISTS screen_run_locks (
      user_login TEXT NOT NULL,
      universe TEXT NOT NULL,
      token TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (user_login, universe)
    )`,
    [],
  );
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
  ensureScreenRunLockTable(exec);
  const token = crypto.randomUUID();
  exec(
    `INSERT INTO screen_run_locks (user_login, universe, token, started_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_login, universe) DO NOTHING`,
    [userLogin, universe, token, now],
  );
  let rows = exec(
    `SELECT token, started_at FROM screen_run_locks
     WHERE user_login = ? AND universe = ?`,
    [userLogin, universe],
  );
  if (rows[0]?.token === token) {
    return { acquired: true, token, startedAt: now, tookOverStale: false };
  }
  const startedAt = Number(rows[0]?.started_at);
  if (Number.isFinite(startedAt) && now - startedAt > SCREEN_RUN_LOCK_STALE_MS) {
    // Compare-and-swap on the observed started_at: a competing
    // takeover winner changes the row first, and this update then
    // affects zero rows, so only one contender ever wins.
    exec(
      `UPDATE screen_run_locks SET token = ?, started_at = ?
       WHERE user_login = ? AND universe = ? AND started_at = ?`,
      [token, now, userLogin, universe, startedAt],
    );
    rows = exec(
      `SELECT token FROM screen_run_locks
       WHERE user_login = ? AND universe = ?`,
      [userLogin, universe],
    );
    if (rows[0]?.token === token) {
      return { acquired: true, token, startedAt: now, tookOverStale: true };
    }
  }
  return {
    acquired: false,
    token: null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    tookOverStale: false,
  };
}

/** Release only when the token matches: never frees another run's lock. */
export function releaseScreenRunLock(
  exec: ScreenRunLockSql,
  userLogin: string,
  universe: string,
  token: string | null,
): void {
  if (!token) return;
  exec(
    `DELETE FROM screen_run_locks
     WHERE user_login = ? AND universe = ? AND token = ?`,
    [userLogin, universe, token],
  );
}

/** Probe for the sharded submission gate: stale rows do not count. */
export function isScreenRunning(
  exec: ScreenRunLockSql,
  userLogin: string,
  universe: string,
  now: number = Date.now(),
): { running: boolean; startedAt: number | null } {
  ensureScreenRunLockTable(exec);
  const rows = exec(
    `SELECT started_at FROM screen_run_locks
     WHERE user_login = ? AND universe = ?`,
    [userLogin, universe],
  );
  if (!rows[0]) return { running: false, startedAt: null };
  const startedAt = Number(rows[0].started_at);
  if (Number.isFinite(startedAt) && now - startedAt <= SCREEN_RUN_LOCK_STALE_MS) {
    return { running: true, startedAt };
  }
  return { running: false, startedAt };
}
