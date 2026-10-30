/**
 * Issue #2361 (#1976 step 4e) — the DO-SQLite implementation
 * of the screener's run-lock port: the statements from
 * src/services/screenRunLock.ts, moved into the data layer
 * statement-for-statement, plus the table's DDL (its ONE home
 * now). The lock's #1993 design note (why instance-local,
 * why synchronous) lives on the port in screenRunLockPorts.ts.
 */
import {
  SCREEN_RUN_LOCK_STALE_MS,
  type ScreenRunLockAcquisition,
  type ScreenRunLockPort,
  type ScreenRunLockSqlExecutor,
} from "./screenRunLockPorts";

type Row = Record<string, unknown>;

export class DoSqliteScreenRunLock implements ScreenRunLockPort {
  constructor(private readonly sql: ScreenRunLockSqlExecutor) {}

  ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS screen_run_locks (
      user_login TEXT NOT NULL,
      universe TEXT NOT NULL,
      token TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      PRIMARY KEY (user_login, universe)
    )`);
  }

  acquire(
    userLogin: string,
    universe: string,
    now: number = Date.now()
  ): ScreenRunLockAcquisition {
    this.ensureSchema();
    const token = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO screen_run_locks (user_login, universe, token, started_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_login, universe) DO NOTHING`,
      userLogin,
      universe,
      token,
      now
    );
    let rows = Array.from(
      this.sql.exec(
        `SELECT token, started_at FROM screen_run_locks
     WHERE user_login = ? AND universe = ?`,
        userLogin,
        universe
      )
    ) as Row[];
    if (rows[0]?.token === token) {
      return { acquired: true, token, startedAt: now, tookOverStale: false };
    }
    const startedAt = Number(rows[0]?.started_at);
    if (Number.isFinite(startedAt) && now - startedAt > SCREEN_RUN_LOCK_STALE_MS) {
      // Compare-and-swap on the observed started_at: a competing
      // takeover winner changes the row first, and this update then
      // affects zero rows, so only one contender ever wins.
      this.sql.exec(
        `UPDATE screen_run_locks SET token = ?, started_at = ?
       WHERE user_login = ? AND universe = ? AND started_at = ?`,
        token,
        now,
        userLogin,
        universe,
        startedAt
      );
      rows = Array.from(
        this.sql.exec(
          `SELECT token FROM screen_run_locks
       WHERE user_login = ? AND universe = ?`,
          userLogin,
          universe
        )
      ) as Row[];
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

  release(userLogin: string, universe: string, token: string | null): void {
    if (!token) return;
    this.sql.exec(
      `DELETE FROM screen_run_locks
     WHERE user_login = ? AND universe = ? AND token = ?`,
      userLogin,
      universe,
      token
    );
  }

  isRunning(
    userLogin: string,
    universe: string,
    now: number = Date.now()
  ): { running: boolean; startedAt: number | null } {
    this.ensureSchema();
    const rows = Array.from(
      this.sql.exec(
        `SELECT started_at FROM screen_run_locks
     WHERE user_login = ? AND universe = ?`,
        userLogin,
        universe
      )
    ) as Row[];
    if (!rows[0]) return { running: false, startedAt: null };
    const startedAt = Number(rows[0].started_at);
    if (Number.isFinite(startedAt) && now - startedAt <= SCREEN_RUN_LOCK_STALE_MS) {
      return { running: true, startedAt };
    }
    return { running: false, startedAt };
  }
}
