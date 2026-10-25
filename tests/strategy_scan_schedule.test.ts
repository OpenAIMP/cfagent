/**
 * Issue #275 — the hourly full-catalog strategy scan is armed once per
 * authenticated user (cron 35 * * * *, staggered off the equity-screen
 * minutes), following the ensureStaleSweepSchedule pattern. It must
 * never double-arm, and it must respect a scan the user paused in the
 * Schedules tab (#273's paused store).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

import { OrchestratorAgent, STRATEGY_SCAN_CRON } from "../src/agents/orchestrator";
import { SqlPausedScheduleStore } from "../src/services/scheduleManagement";
import { MockSqlStorage } from "./mock-sql";

let scheduleCalls: any[];
let existing: any[];
let audits: any[];
let sql: MockSqlStorage;
let agent: any;

beforeEach(() => {
  scheduleCalls = [];
  existing = [];
  audits = [];
  sql = new MockSqlStorage();
  agent = Object.create(OrchestratorAgent.prototype);
  agent.ctx = { storage: { sql }, id: { toString: () => "strategy-scan-test" } };
  agent.env = {};
  agent.listSchedules = async () => existing;
  agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
    scheduleCalls.push([when, callback, payload, options]);
    return { id: "scan-1", callback, payload };
  };
  agent.audit = (type: string, agentName: string, payload: any) => {
    audits.push([type, agentName, payload]);
  };
});

describe("ensureStrategyScanSchedule (#275)", () => {
  it("the scan cron is hourly and staggered off the :05 equity-screen minute", () => {
    expect(STRATEGY_SCAN_CRON).toBe("35 * * * *");
  });

  it("arms the hourly full-catalog scan for an authenticated user", async () => {
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
    const [when, callback, payload] = scheduleCalls[0];
    expect(when).toBe("35 * * * *");
    expect(callback).toBe("autonomousOptionsAnalysis");
    // No allowedStrategies restriction: the full strategy catalog.
    // Consolidation C3 (#1277): the payload is now the shared
    // builder's record (buildSchedulePayload) — it adds the
    // creation-default maxItems stamp (the UNIVERSES NASDAQ100
    // default the options service applied itself at run time when
    // maxItems was absent, so the armed run is unchanged).
    expect(payload).toEqual({
      userLogin: "venus",
      environment: "PROD",
      universe: "NASDAQ100",
      maxItems: 100,
      trigger: "scheduled",
    });
    expect(payload.allowedStrategies).toBeUndefined();
    expect(audits.some(([t]) => t === "schedule.created")).toBe(true);
  });

  it("does not double-arm when the user already has a scan schedule", async () => {
    existing = [
      { id: "x", callback: "autonomousOptionsAnalysis", payload: { userLogin: "venus" } },
    ];
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
  });

  it("arms for a different user even when someone else's scan exists", async () => {
    existing = [
      { id: "x", callback: "autonomousOptionsAnalysis", payload: { userLogin: "someone-else" } },
    ];
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
  });

  it("respects a paused scan (#273): a paused record blocks re-arming", async () => {
    const store = new SqlPausedScheduleStore(sql as any);
    store.save({
      id: "paused-scan",
      callback: "autonomousOptionsAnalysis",
      payload: { userLogin: "venus", environment: "PROD", universe: "NASDAQ100", trigger: "scheduled" },
      type: "cron",
      cron: "35 * * * *",
      pausedAt: "2026-10-20T16:00:00.000Z",
    });
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(0);
  });

  it("an unrelated paused job does not block arming", async () => {
    const store = new SqlPausedScheduleStore(sql as any);
    store.save({
      id: "paused-screen",
      callback: "autonomousMarketScreen",
      payload: { userLogin: "venus", universe: "SP500" },
      type: "cron",
      cron: "5 * * * *",
      pausedAt: "2026-10-20T16:00:00.000Z",
    });
    await agent.ensureStrategyScanSchedule({ userLogin: "venus", environment: "PROD" });
    expect(scheduleCalls).toHaveLength(1);
  });
});
