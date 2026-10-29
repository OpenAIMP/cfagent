import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM, verifyStoredAuditChain } from "../src/orm";
import { ensureAuditChainColumns } from "../src/orm/schema";
import type { AuditEvent } from "../src/types";

function makeOrm() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql);
  return { sql, orm };
}

function event(id: string, type: string, payload: Record<string, unknown>): AuditEvent {
  return {
    id,
    sessionId: "sess-1",
    type,
    agent: "orchestrator",
    payload,
    createdAt: new Date().toISOString(),
  };
}

describe("audit chain store (issue #2178 S1)", () => {
  it("migration adds the chain columns to a pre-chain table", () => {
    const { sql } = makeOrm();
    const before = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{ name: string }>;
    expect(before.map((c) => c.name)).not.toContain("previous_event_hash");
    expect(before.map((c) => c.name)).not.toContain("event_hash");
    ensureAuditChainColumns(sql);
    const after = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{ name: string }>;
    expect(after.map((c) => c.name)).toContain("previous_event_hash");
    expect(after.map((c) => c.name)).toContain("event_hash");
    // Idempotent: a second run adds nothing.
    ensureAuditChainColumns(sql);
    const again = Array.from(sql.exec(`PRAGMA table_info(mas_events)`)) as Array<{ name: string }>;
    expect(again.filter((c) => c.name === "event_hash")).toHaveLength(1);
  });

  it("chained inserts link and verify", () => {
    const { orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    orm.events.create(event("a3", "followup.schedule_failed", { jobId: "j1" }));
    const rows = orm.events.findMany({});
    expect(rows).toHaveLength(3);
    expect(rows[0].previousEventHash).toBeNull();
    expect(rows[0].eventHash).toBeTruthy();
    expect(rows[1].previousEventHash).toBe(rows[0].eventHash);
    expect(rows[2].previousEventHash).toBe(rows[1].eventHash);
    expect(verifyStoredAuditChain(orm)).toBe(true);
  });

  it("record payloads are stored as JSON text, not [object Object]", () => {
    const { orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1", principalKind: "session" }));
    const stored = orm.events.findById("a1")!;
    const raw = Array.from(
      (orm as unknown as { sql: { exec: (q: string, ...a: unknown[]) => Iterable<unknown> } }).sql.exec(
        `SELECT payload FROM mas_events WHERE id = ?`,
        "a1",
      ),
    ) as Array<{ payload: unknown }>;
    expect(typeof raw[0].payload).toBe("string");
    expect(raw[0].payload).toContain("j1");
    expect(raw[0].payload).not.toContain("[object Object]");
    expect(stored.payload).toBe(raw[0].payload);
  });

  it("pre-chain rows are a genesis boundary, not a failure", () => {
    const { sql, orm } = makeOrm();
    // A pre-chain row, written the old way (no chain columns).
    sql.exec(
      `INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      "old-1",
      "sess-1",
      "legacy.event",
      "orchestrator",
      JSON.stringify({ legacy: true }),
      new Date().toISOString(),
    );
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    expect(verifyStoredAuditChain(orm)).toBe(true);
  });

  it("a bypass writer after chaining started fails verification", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    sql.exec(
      `INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      "bypass-1",
      "sess-1",
      "bypass.event",
      "orchestrator",
      JSON.stringify({ bypass: true }),
      new Date().toISOString(),
    );
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    expect(verifyStoredAuditChain(orm)).toBe(false);
  });

  it("a tampered payload fails verification", () => {
    const { sql, orm } = makeOrm();
    orm.events.create(event("a1", "goal_screen.workflow_submitted", { jobId: "j1" }));
    orm.events.create(event("a2", "goal_screen.run_failed", { jobId: "j1" }));
    sql.exec(`UPDATE mas_events SET payload = ? WHERE id = ?`, JSON.stringify({ jobId: "tampered" }), "a1");
    expect(verifyStoredAuditChain(orm)).toBe(false);
  });
});
