/**
 * Assessment P1 (#143, issue #257): the NLQ execution seam records exactly
 * one mas_events audit row per execution (nlq.executed / nlq.error), and
 * the audit write never carries the raw query text (redaction discipline).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  executeNLQQuery,
  executeNLQQueryAsync,
  type NLQPlan,
  type NLQQueryResult,
} from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

function tablesPlan(): NLQPlan {
  return { domain: "tables", operation: "list", role: "any" };
}

describe("NLQ execution observability (Assessment P1 #143, issue #257)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("obs_session");
  });

  it("writes exactly one nlq.executed audit row per sync execution", () => {
    const result: NLQQueryResult = executeNLQQuery(orm, "obs_session", tablesPlan());
    expect(result.domain).toBe("tables");

    const events = orm.events.findMany({ where: { type: "nlq.executed" } });
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.agent).toBe("nlq");
    expect(ev.sessionId).toBe("obs_session");
    // #2178 S1: stored payload is JSON text — parse the stored form.
    const payload = JSON.parse(ev.payload as unknown as string) as Record<string, unknown>;
    expect(payload.domain).toBe("tables");
    expect(typeof payload.count).toBe("number");
    expect(typeof payload.durationMs).toBe("number");
    // Redaction: the raw query must never be logged.
    expect("query" in payload).toBe(false);
    expect("terms" in payload).toBe(false);
  });

  it("writes exactly one nlq.executed row for the async entry (no double audit)", async () => {
    await executeNLQQueryAsync(orm, "obs_session", tablesPlan(), {} as any);

    const executed = orm.events.findMany({ where: { type: "nlq.executed" } });
    expect(executed).toHaveLength(1);
    const errors = orm.events.findMany({ where: { type: "nlq.error" } });
    expect(errors).toHaveLength(0);
  });

  it("writes an nlq.error row and rethrows when execution throws", () => {
    const boom = new Error("listTables exploded");
    const brokenOrm = {
      listTables: () => {
        throw boom;
      },
      events: orm.events,
    } as unknown as DatabaseORM;

    expect(() => executeNLQQuery(brokenOrm, "obs_session", tablesPlan())).toThrow(boom);

    const events = orm.events.findMany({ where: { type: "nlq.error" } });
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.agent).toBe("nlq");
    // #2178 S1: stored payload is JSON text — parse the stored form.
    const payload = JSON.parse(ev.payload as unknown as string) as Record<string, unknown>;
    expect(payload.error).toContain("listTables exploded");
    expect("query" in payload).toBe(false);
  });

  it("executes normally when no events repository exists (audit is best-effort)", () => {
    const noEventsOrm = { listTables: () => [] } as unknown as DatabaseORM;
    const result = executeNLQQuery(noEventsOrm, "obs_session", tablesPlan());
    expect(result.domain).toBe("tables");
  });
});
