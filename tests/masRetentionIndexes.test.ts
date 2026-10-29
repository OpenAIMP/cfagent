/**
 * Issue #2280 (slice 3): EXPLAIN QUERY PLAN pins for the nightly retention
 * batches. Without an index on created_at, each 500-row batch walks the whole
 * table (SCAN), and a 10-batch run scans it up to 10 times. With the
 * (created_at, id) covering indexes the same statements plan bounded index
 * walks with no table lookups. Runs the exact statements against real SQLite
 * tables (node:sqlite, the slice 1/2 pattern) with the real table shapes
 * from src/orm/schema.ts.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SqlStorage } from "../src/orm";
import {
  MAS_EVENTS_RETENTION_SQL,
  MAS_MESSAGES_RETENTION_SQL,
  ensureMasRetentionIndexes,
} from "../src/services/masRetentionIndexes";

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

const CREATE_MESSAGES = `CREATE TABLE IF NOT EXISTS mas_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL
)`;

const CREATE_EVENTS = `CREATE TABLE IF NOT EXISTS mas_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  agent TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT
)`;

function seed(db: DatabaseSync): void {
  for (let i = 0; i < 50; i++) {
    const ts = `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
    db.prepare(
      "INSERT INTO mas_messages (id, session_id, role, content, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`m${i}`, "s", "user", "hi", "a", ts);
    db.prepare(
      "INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(`e${i}`, "s", "t", "a", "{}", ts);
  }
}

function plan(db: DatabaseSync, sql: string): string {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all("2026-06-01T00:00:00.000Z", 500) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

describe("masRetentionIndexes (issue #2280 slice 3)", () => {
  it("retention batches SCAN both tables without the indexes (baseline pin)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(CREATE_MESSAGES);
    db.exec(CREATE_EVENTS);
    seed(db);
    expect(plan(db, MAS_MESSAGES_RETENTION_SQL)).toContain("SCAN");
    expect(plan(db, MAS_EVENTS_RETENTION_SQL)).toContain("SCAN");
  });

  it("retention batches SEARCH the covering indexes after ensureMasRetentionIndexes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(CREATE_MESSAGES);
    db.exec(CREATE_EVENTS);
    seed(db);
    ensureMasRetentionIndexes(makeSql(db));
    const messagesPlan = plan(db, MAS_MESSAGES_RETENTION_SQL);
    const eventsPlan = plan(db, MAS_EVENTS_RETENTION_SQL);
    expect(messagesPlan).toContain("SEARCH mas_messages USING COVERING INDEX idx_mas_messages_created");
    expect(messagesPlan).not.toContain("SCAN");
    expect(eventsPlan).toContain("SEARCH mas_events USING COVERING INDEX idx_mas_events_created");
    expect(eventsPlan).not.toContain("SCAN");
  });

  it("ensureMasRetentionIndexes is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(CREATE_MESSAGES);
    db.exec(CREATE_EVENTS);
    const sql = makeSql(db);
    ensureMasRetentionIndexes(sql);
    ensureMasRetentionIndexes(sql);
    expect(plan(db, MAS_MESSAGES_RETENTION_SQL)).toContain(
      "USING COVERING INDEX idx_mas_messages_created",
    );
  });

  it("the indexed queries still return the same aged ids in order", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(CREATE_MESSAGES);
    db.exec(CREATE_EVENTS);
    seed(db);
    ensureMasRetentionIndexes(makeSql(db));
    const rows = db
      .prepare(MAS_MESSAGES_RETENTION_SQL)
      .all("2026-01-10T00:00:00.000Z", 500) as Array<{ id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.id.startsWith("m"))).toBe(true);
  });
});
