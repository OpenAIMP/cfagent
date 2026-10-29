/**
 * Issue #2280 (slice 1): EXPLAIN QUERY PLAN pins for the framework alarm
 * queue. The agents SDK's `cf_agents_jobs` table has no index on `time`,
 * so every alarm scans it; the three indexes from
 * `ensureFrameworkQueueIndexes` must turn each of the four alarm statements
 * from a scan into a bounded seek. The test runs the exact SDK statements
 * against a real SQLite table (node:sqlite, the slice0 pattern) with the
 * exact SDK schema, so a plan regression fails here instead of in prod.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  ensureFrameworkQueueIndexes,
  FRAMEWORK_QUEUE_INDEXES,
} from "../src/services/frameworkQueueIndexes";

/** Eager SqlStorage adapter over node:sqlite (DDL runs at exec time). */
function makeSql(db: DatabaseSync): SqlStorage {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|EXPLAIN|PRAGMA|WITH)\b/i.test(query)) {
        return stmt.all(...(args as any[])) as unknown[];
      }
      stmt.run(...(args as any[]));
      return [];
    },
  };
}

/** Exact agents SDK 0.24.0 `cf_agents_jobs` schema (WITHOUT ROWID). */
const CREATE_TABLE = `CREATE TABLE cf_agents_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  capability TEXT NOT NULL,
  fn TEXT NOT NULL,
  time INTEGER NOT NULL,
  payload TEXT,
  retry_options TEXT,
  singleflight INTEGER NOT NULL DEFAULT 0,
  hung_timeout_seconds INTEGER,
  exclusive INTEGER NOT NULL DEFAULT 0,
  recovery_loop INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  execution_started_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) WITHOUT ROWID`;

const NOW = 1761740000000;

function seedQueue(db: DatabaseSync, rows = 200): void {
  db.exec(CREATE_TABLE);
  const insert = db.prepare(
    "INSERT INTO cf_agents_jobs (id, capability, fn, time, singleflight, exclusive, running) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < rows; i++) {
    // Typical state: nothing exclusive, nothing running, most jobs future.
    insert.run(`job-${i}`, "cap", "fn", NOW + (i < 5 ? -1000 : i * 60000), 0, 0, 0);
  }
}

function plan(db: DatabaseSync, sql: string, ...params: unknown[]): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(" | ");
}

const DUE = "SELECT * FROM cf_agents_jobs WHERE time <= ? ORDER BY time ASC";
const MIN_EXCLUSIVE = "SELECT MIN(time) AS time FROM cf_agents_jobs WHERE exclusive = 1";
const MIN_READY =
  "SELECT MIN(time) AS time FROM cf_agents_jobs WHERE singleflight = 0 OR running = 0 OR coalesce(execution_started_at, 0) + coalesce(hung_timeout_seconds, 86400) * 1000 <= ?";
const MIN_HUNG =
  "SELECT MIN(coalesce(execution_started_at, 0) + coalesce(hung_timeout_seconds, 86400) * 1000) AS recheck FROM cf_agents_jobs WHERE singleflight = 1 AND running = 1 AND coalesce(execution_started_at, 0) + coalesce(hung_timeout_seconds, 86400) * 1000 > ?";

describe("framework queue indexes (#2280)", () => {
  it("pins the pre-index disease: due() scans, no alarm statement uses a queue index", () => {
    const db = new DatabaseSync(":memory:");
    seedQueue(db);
    expect(plan(db, DUE, NOW)).toContain("SCAN");
    // MIN_EXCLUSIVE takes no parameters; the other two take the now bound.
    expect(plan(db, MIN_EXCLUSIVE)).not.toContain("idx_cf_agents_jobs");
    expect(plan(db, MIN_READY, NOW)).not.toContain("idx_cf_agents_jobs");
    expect(plan(db, MIN_HUNG, NOW)).not.toContain("idx_cf_agents_jobs");
  });

  it("creates the three indexes and turns every alarm statement into a bounded seek", () => {
    const db = new DatabaseSync(":memory:");
    seedQueue(db);
    ensureFrameworkQueueIndexes(makeSql(db));
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_cf_agents_jobs%'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(names.sort()).toEqual(FRAMEWORK_QUEUE_INDEXES.map((index) => index.name).sort());
    expect(plan(db, DUE, NOW)).toContain("USING INDEX idx_cf_agents_jobs_time (time<?)");
    expect(plan(db, MIN_EXCLUSIVE)).toContain(
      "USING COVERING INDEX idx_cf_agents_jobs_exclusive_time (exclusive=?)",
    );
    expect(plan(db, MIN_READY, NOW)).toContain("USING INDEX idx_cf_agents_jobs_time");
    expect(plan(db, MIN_HUNG, NOW)).toContain(
      "USING COVERING INDEX idx_cf_agents_jobs_singleflight_running (singleflight=? AND running=?)",
    );
  });

  it("is idempotent: a second run adds nothing and throws nothing", () => {
    const db = new DatabaseSync(":memory:");
    seedQueue(db);
    const sql = makeSql(db);
    ensureFrameworkQueueIndexes(sql);
    expect(() => ensureFrameworkQueueIndexes(sql)).not.toThrow();
    const count = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_cf_agents_jobs%'").get() as { n: number }).n;
    expect(count).toBe(3);
  });

  it("throws when the framework table does not exist yet (the onStart caller catches this)", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => ensureFrameworkQueueIndexes(makeSql(db))).toThrow();
  });
});
