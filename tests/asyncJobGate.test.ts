/**
 * Issue #2280 (slice 2): EXPLAIN QUERY PLAN pins for the already-running
 * gate. The old `NOT IN` query scans `mas_async_jobs` on every 30-minute tick,
 * and — the trap this test pins — a `(status, created_at)` index alone
 * does NOT fix it: `NOT IN` still plans SCAN. Only the positive `IN` list
 * plus that index seeks. Runs the exact statements against a real SQLite
 * table (node:sqlite, the slice0 pattern) with the real table shape.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  ACTIVE_JOB_PAYLOADS_SQL,
  ensureAsyncJobGateIndexes,
  hasActiveChain,
} from "../src/services/asyncJobGate";

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

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS mas_async_jobs (
  job_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  response_status INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
)`;

const OLD_SQL =
  "SELECT payload_json FROM mas_async_jobs WHERE status NOT IN ('completed', 'failed')";

const TARGET = { userLogin: "dhmprstw@gmail.com", universe: "NASDAQ100" };

function seed(db: DatabaseSync): void {
  db.exec(CREATE_TABLE);
  db.exec("CREATE INDEX IF NOT EXISTS idx_mas_async_jobs_session_created ON mas_async_jobs(session_id, created_at DESC)");
  const insert = db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const chain = (userLogin: string, universe: string) =>
    JSON.stringify({ chain: { userLogin, universe } });
  const rows: Array<[string, string]> = [];
  for (let i = 0; i < 500; i++) rows.push(["completed", chain("other", "SP100")]);
  for (let i = 0; i < 200; i++) rows.push(["failed", chain("other", "SP100")]);
  for (let i = 0; i < 40; i++) rows.push(["queued", chain("other", "SP100")]);
  for (let i = 0; i < 10; i++) rows.push(["running", chain("other", "NASDAQ100")]);
  rows.push(["queued", chain(TARGET.userLogin, TARGET.universe)]);
  rows.push(["running", "not-json{{{"]);
  rows.push(["queued", JSON.stringify({ noChain: true })]);
  rows.forEach(([status, payload], i) => {
    insert.run(`job-${i}`, `sess-${i % 50}`, "cap", "d", status, payload, "2026-10-29T00:00:00Z", "2026-10-29T00:00:00Z");
  });
}

function plan(db: DatabaseSync, sql: string): string {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join(" | ");
}

function payloads(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ payload_json: string }>).map((row) => row.payload_json);
}

describe("async job gate (#2280 slice 2)", () => {
  it("pins the NOT IN trap: the old query scans even with the new index present", () => {
    const db = new DatabaseSync(":memory:");
    seed(db);
    ensureAsyncJobGateIndexes(makeSql(db));
    expect(plan(db, OLD_SQL)).toContain("SCAN");
  });

  it("turns the gate into bounded seeks on the new index", () => {
    const db = new DatabaseSync(":memory:");
    seed(db);
    ensureAsyncJobGateIndexes(makeSql(db));
    expect(plan(db, ACTIVE_JOB_PAYLOADS_SQL)).toContain(
      "USING INDEX idx_mas_async_jobs_status_created (status=?)",
    );
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mas_async_jobs_status_created'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(names).toEqual(["idx_mas_async_jobs_status_created"]);
  });

  it("is idempotent: a second run adds nothing and throws nothing", () => {
    const db = new DatabaseSync(":memory:");
    seed(db);
    const sql = makeSql(db);
    ensureAsyncJobGateIndexes(sql);
    expect(() => ensureAsyncJobGateIndexes(sql)).not.toThrow();
    const count = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_mas_async_jobs_status_created'").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it("returns exactly the old query's rows on the closed status domain", () => {
    const db = new DatabaseSync(":memory:");
    seed(db);
    ensureAsyncJobGateIndexes(makeSql(db));
    expect(payloads(db, ACTIVE_JOB_PAYLOADS_SQL).sort()).toEqual(payloads(db, OLD_SQL).sort());
  });

  it("matches only the target chain, ignoring bad payloads and other chains", () => {
    const db = new DatabaseSync(":memory:");
    seed(db);
    const rows = payloads(db, ACTIVE_JOB_PAYLOADS_SQL).map((payload_json) => ({ payload_json }));
    expect(hasActiveChain(rows, TARGET.userLogin, TARGET.universe)).toBe(true);
    expect(hasActiveChain(rows, "OpenAIMP", TARGET.universe)).toBe(false);
    expect(hasActiveChain(rows, TARGET.userLogin, "SP100")).toBe(false);
    expect(hasActiveChain([], TARGET.userLogin, TARGET.universe)).toBe(false);
    expect(hasActiveChain([{ payload_json: "not-json{{{ " }], TARGET.userLogin, TARGET.universe)).toBe(false);
    expect(hasActiveChain([{ payload_json: JSON.stringify({ noChain: true }) }], TARGET.userLogin, TARGET.universe)).toBe(false);
  });
});
