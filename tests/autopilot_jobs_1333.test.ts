/**
 * Issue #1333: GET /autopilot/jobs serves the job-outcome sink —
 * the feed Autopilot Control renders, newest first, labeled by
 * origin. Seeded here through the same recordJobOutcome sink the
 * producers write, so the endpoint test pins the contract, not a
 * fixture shape.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { handleAutopilotRoutes } from "../src/agents/routes/autopilot";
import { recordJobOutcome } from "../src/services/jobOutcomes";

describe("GET /autopilot/jobs (#1333)", () => {
  it("returns recorded outcomes newest first", async () => {
    const sql = new MockSqlStorage();
    recordJobOutcome(sql, {
      id: "auth-fail",
      kind: "options",
      trigger: "scheduled",
      status: "failed",
      codedError: "[FAILURE_AUTH_NO_SESSION] E*TRADE connection missing",
      origin: "job-tree",
      createdAt: "2026-10-24T04:58:00.000Z",
    });
    recordJobOutcome(sql, {
      id: "goal-zero",
      kind: "goal",
      trigger: "manual",
      status: "completed",
      scanned: 6604,
      matched: 0,
      origin: "job-tree",
      createdAt: "2026-10-24T10:36:00.000Z",
    });
    const ctx = {
      ensureTables: () => sql,
      audit: () => {},
      getAutopilotState: () => ({}),
      writeAutopilotState: (p: any) => p,
      evaluateAndRecordAutopilotVerdict: async () => ({}),
    } as any;
    const res = await handleAutopilotRoutes(
      new Request("https://agent.internal/api/autopilot/jobs", { method: "GET" }),
      new URL("https://agent.internal/api/autopilot/jobs"),
      "/api/autopilot/jobs",
      "s",
      ctx
    );
    expect(res).not.toBeNull();
    const data = (await res!.json()) as any;
    expect(data.count).toBe(2);
    expect(data.jobs[0].id).toBe("goal-zero");
    expect(data.jobs[1].codedError).toContain("[FAILURE_AUTH_NO_SESSION]");
  });

  it("honors the limit parameter", async () => {
    const sql = new MockSqlStorage();
    for (let i = 0; i < 3; i++) {
      recordJobOutcome(sql, {
        id: `job-${i}`,
        kind: "stock",
        trigger: "scheduled",
        status: "completed",
        origin: "job-tree",
        createdAt: `2026-10-24T0${i}:00:00.000Z`,
      });
    }
    const ctx = { ensureTables: () => sql, audit: () => {} } as any;
    const res = await handleAutopilotRoutes(
      new Request("https://agent.internal/api/autopilot/jobs?limit=2", { method: "GET" }),
      new URL("https://agent.internal/api/autopilot/jobs?limit=2"),
      "/api/autopilot/jobs",
      "s",
      ctx
    );
    const data = (await res!.json()) as any;
    expect(data.jobs).toHaveLength(2);
  });
});
