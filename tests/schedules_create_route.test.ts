import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (the same pattern as
// tests/browser_and_slack_agents.test.ts); the scheduling methods the route
// uses are stubbed per-test on the instance, which is exactly the surface
// issue #111 governs.
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

import { OrchestratorAgent, CREATABLE_SCHEDULE_CALLBACKS } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

/**
 * Issue #111 — POST /api/schedules/create must never fabricate success.
 *
 * Before #111 every mode branch fell back to a fabricated
 * `sched_mock_<ts>` id and returned success when the Agents SDK scheduling
 * method was missing, and any callback string was accepted, so the public
 * route could arm internal-only callbacks. These tests pin the honest
 * behaviour: an allow-list of user-creatable callbacks (HTTP 400 for
 * anything else), HTTP 503 {success:false, error} when scheduling is
 * unavailable or throws, and real SDK ids on success.
 */
describe("POST /api/schedules/create (#111)", () => {
  let scheduleCalls: any[];
  let scheduleEveryCalls: any[];

  function makeAgent(withSdk: boolean) {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => "schedules-create-route-test" },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    agent.env = { APP_ENV: "TEST" } as any;
    if (withSdk) {
      agent.schedule = async (when: any, callback: string, payload: any, options: any) => {
        scheduleCalls.push([when, callback, payload, options]);
        return { id: `real-schedule-${scheduleCalls.length}`, callback, payload };
      };
      agent.scheduleEvery = async (intervalSeconds: number, callback: string, payload: any) => {
        scheduleEveryCalls.push([intervalSeconds, callback, payload]);
        return { id: `real-interval-${scheduleEveryCalls.length}`, callback, payload };
      };
    }
    return agent;
  }

  async function postCreate(agent: any, body: Record<string, unknown>) {
    const res = await agent.onRequest(
      new Request("https://agent.test/api/schedules/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  beforeEach(() => {
    scheduleCalls = [];
    scheduleEveryCalls = [];
  });

  it("exports exactly the five user-creatable callbacks as the allow-list", () => {
    expect([...CREATABLE_SCHEDULE_CALLBACKS].sort()).toEqual(
      [
        "autoRenewETradeTokens",
        "autonomousMarketScreen",
        "autonomousOptionsAnalysis",
        "collectIvHistory",
        "sendScheduledReminder",
      ].sort()
    );
    // Internal-only callbacks are armed by the agent itself, never via the route.
    expect(CREATABLE_SCHEDULE_CALLBACKS as readonly string[]).not.toContain("executeAsyncJob");
    expect(CREATABLE_SCHEDULE_CALLBACKS as readonly string[]).not.toContain("expireStaleOrderDraft");
  });

  it("rejects an unknown callback with 400 and creates no schedule", async () => {
    const agent = makeAgent(true);
    const { status, body } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 3 * * *",
      callback: "someMadeUpCallback",
      payload: {},
    });
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("someMadeUpCallback");
    expect(body.error).toContain("not allowed");
    expect(scheduleCalls).toHaveLength(0);
    expect(scheduleEveryCalls).toHaveLength(0);
  });

  it.each(["executeAsyncJob", "expireStaleOrderDraft"])(
    "rejects the internal-only callback %s with 400 and creates no schedule",
    async (callback) => {
      const agent = makeAgent(true);
      const { status, body } = await postCreate(agent, {
        scheduleType: "interval",
        intervalSeconds: 300,
        callback,
        payload: {},
      });
      expect(status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain(callback);
      expect(scheduleCalls).toHaveLength(0);
      expect(scheduleEveryCalls).toHaveLength(0);
    }
  );

  it("accepts collectIvHistory on a cron and returns the SDK's real schedule id", async () => {
    const agent = makeAgent(true);
    const payload = { userLogin: "default_trader" };
    const { status, body } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "15 22 * * 1-5",
      callback: "collectIvHistory",
      payload,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.schedule.id).toBe("real-schedule-1");
    expect(JSON.stringify(body)).not.toContain("sched_mock_");
    // Cron keeps the idempotent-by-default option (#111 preserves this).
    expect(scheduleCalls).toEqual([["15 22 * * 1-5", "collectIvHistory", payload, { idempotent: true }]]);
  });

  it("accepts autonomousOptionsAnalysis on an interval via scheduleEvery", async () => {
    const agent = makeAgent(true);
    const payload = { symbols: ["NVDA"], thesis: "bullish" };
    const { status, body } = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 3600,
      callback: "autonomousOptionsAnalysis",
      payload,
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.schedule.id).toBe("real-interval-1");
    expect(scheduleEveryCalls).toEqual([[3600, "autonomousOptionsAnalysis", payload]]);
    expect(scheduleCalls).toHaveLength(0);
  });

  it("accepts the remaining allow-listed callbacks across the delayed and scheduled modes", async () => {
    const agent = makeAgent(true);

    const delayed = await postCreate(agent, {
      delayInSeconds: 900,
      callback: "sendScheduledReminder",
      payload: { message: "check the scan" },
    });
    expect(delayed.status).toBe(200);
    expect(delayed.body.success).toBe(true);
    expect(scheduleCalls[0][0]).toBe(900);
    expect(scheduleCalls[0][1]).toBe("sendScheduledReminder");

    const date = "2026-10-20T14:00:00.000Z";
    const scheduled = await postCreate(agent, {
      scheduleType: "scheduled",
      date,
      callback: "autoRenewETradeTokens",
      payload: {},
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.success).toBe(true);
    expect(scheduleCalls[1][0]).toBeInstanceOf(Date);
    expect((scheduleCalls[1][0] as Date).toISOString()).toBe(date);
    expect(scheduleCalls[1][1]).toBe("autoRenewETradeTokens");

    const screen = await postCreate(agent, {
      scheduleType: "interval",
      intervalSeconds: 300,
      callback: "autonomousMarketScreen",
      payload: { sector: "Technology", maxItems: 5 },
    });
    expect(screen.status).toBe(200);
    expect(screen.body.success).toBe(true);
    expect(scheduleEveryCalls).toEqual([[300, "autonomousMarketScreen", { sector: "Technology", maxItems: 5 }]]);
  });

  it("preserves the cron idempotent opt-out (body.idempotent === false)", async () => {
    const agent = makeAgent(true);
    const { status } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 3 * * *",
      callback: "autoRenewETradeTokens",
      payload: {},
      idempotent: false,
    });
    expect(status).toBe(200);
    expect(scheduleCalls[0][3]).toEqual({ idempotent: false });
  });

  it.each([
    ["interval", { scheduleType: "interval", intervalSeconds: 3600 }],
    ["cron", { scheduleType: "cron", cron: "0 3 * * *" }],
    ["scheduled", { scheduleType: "scheduled", date: "2026-10-20T14:00:00.000Z" }],
    ["delayed", { delayInSeconds: 60 }],
  ])(
    "returns an honest 503 with no fabricated id when the SDK method is unavailable (%s mode)",
    async (_mode, fields) => {
      const agent = makeAgent(false); // no schedule / scheduleEvery on the agent
      const { status, body } = await postCreate(agent, {
        ...fields,
        callback: "collectIvHistory",
        payload: { userLogin: "default_trader" },
      });
      expect(status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.error).toContain("Scheduling unavailable");
      expect(body.schedule).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("sched_mock_");
    }
  );

  it("returns an honest 503 when the SDK scheduling call throws", async () => {
    const agent = makeAgent(true);
    agent.schedule = async () => {
      throw new Error("durable object storage exploded");
    };
    const { status, body } = await postCreate(agent, {
      scheduleType: "cron",
      cron: "0 3 * * *",
      callback: "collectIvHistory",
      payload: {},
    });
    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toContain("durable object storage exploded");
    expect(JSON.stringify(body)).not.toContain("sched_mock_");
  });

  it("pins the source: no fabricated sched_mock_ id remains anywhere in src/", () => {
    const source = readFileSync("src/agents/orchestrator.ts", "utf8");
    expect(source).not.toContain("sched_mock_");
  });
});
