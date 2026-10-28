/**
 * Issue #828 (kept) + #1993 (rewired): run lock prevents concurrent
 * screens. The #828 cases now exercise the real lock module
 * (src/services/screenRunLock.ts) instead of an inline simulation:
 * the lock lives in synchronous SQLite, so acquire is atomic.
 */
import { describe, it, expect } from "vitest";
import {
  acquireScreenRunLock,
  SCREEN_RUN_LOCK_STALE_MS,
  type ScreenRunLockSql,
} from "../src/services/screenRunLock";

/**
 * Faithful in-memory stand-in for the exact statements the lock
 * module emits: same state machine (insert-if-absent, conditional
 * takeover update, token-matched delete), synchronous like DO
 * `storage.sql.exec`.
 */
export function createFakeLockSql(): {
  exec: ScreenRunLockSql;
  rows: Map<string, { token: string; started_at: number }>;
} {
  const rows = new Map<string, { token: string; started_at: number }>();
  const exec: ScreenRunLockSql = (sql: string, params: unknown[]) => {
    if (sql.includes("CREATE TABLE")) return [];
    if (sql.includes("INSERT INTO screen_run_locks")) {
      const [userLogin, universe, token, startedAt] = params as [string, string, string, number];
      const key = `${userLogin}:${universe}`;
      if (!rows.has(key)) rows.set(key, { token, started_at: startedAt });
      return [];
    }
    if (sql.includes("UPDATE screen_run_locks")) {
      const [token, startedAt, userLogin, universe, oldStartedAt] = params as [string, number, string, string, number];
      const key = `${userLogin}:${universe}`;
      const cur = rows.get(key);
      if (cur && cur.started_at === oldStartedAt) rows.set(key, { token, started_at: startedAt });
      return [];
    }
    if (sql.includes("DELETE FROM screen_run_locks")) {
      const [userLogin, universe, token] = params as [string, string, string];
      const key = `${userLogin}:${universe}`;
      const cur = rows.get(key);
      if (cur && cur.token === token) rows.delete(key);
      return [];
    }
    if (sql.includes("SELECT token, started_at")) {
      const [userLogin, universe] = params as [string, string];
      const cur = rows.get(`${userLogin}:${universe}`);
      return cur ? [{ token: cur.token, started_at: cur.started_at }] : [];
    }
    if (sql.includes("SELECT token FROM")) {
      const [userLogin, universe] = params as [string, string];
      const cur = rows.get(`${userLogin}:${universe}`);
      return cur ? [{ token: cur.token }] : [];
    }
    if (sql.includes("SELECT started_at")) {
      const [userLogin, universe] = params as [string, string];
      const cur = rows.get(`${userLogin}:${universe}`);
      return cur ? [{ started_at: cur.started_at }] : [];
    }
    throw new Error(`Unexpected lock SQL: ${sql}`);
  };
  return { exec, rows };
}

describe("runScreen lock (#828, rewired #1993)", () => {
  it("second concurrent run is rejected", () => {
    const { exec } = createFakeLockSql();
    const first = acquireScreenRunLock(exec, "testuser", "nasdaq100");
    expect(first.acquired).toBe(true);

    const second = acquireScreenRunLock(exec, "testuser", "nasdaq100");
    expect(second.acquired).toBe(false);
    expect(second.startedAt).toBe(first.startedAt);
    expect(Date.now() - (second.startedAt ?? 0)).toBeLessThan(SCREEN_RUN_LOCK_STALE_MS);
  });

  it("stale lock (>5min) is taken over", () => {
    const { exec } = createFakeLockSql();
    const old = acquireScreenRunLock(exec, "testuser", "nasdaq100", Date.now() - 10 * 60 * 1000);
    expect(old.acquired).toBe(true);

    const takeover = acquireScreenRunLock(exec, "testuser", "nasdaq100");
    expect(takeover.acquired).toBe(true);
    expect(takeover.tookOverStale).toBe(true);
  });
});
