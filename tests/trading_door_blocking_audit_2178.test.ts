/**
 * Issue #2178 (Q7 S2) — trade family, TradingAgent doors.
 * TDD: written before the implementation.
 *
 * Contract: executeApprovedOrder audits the approval decision BEFORE
 * settle and the execution result AFTER settle, both through the
 * blocking helper (a throwing audit store blocks: no settle on a
 * decision-audit throw, no success report on a result-audit throw).
 * decideTradeApproval audits the decision BEFORE delivering the event
 * to the workflow (a throw means the decision never takes effect).
 * Input validation still runs first — invalid calls never audit.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("agents", () => {
  return {
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});

import { TradingPlatformRegistry } from "../src/trading";
import type { Env } from "../src/types";

const env = { SERVICE_USER_LOGIN: "svc-trader" } as Env;

TradingPlatformRegistry.register("faketrade2178" as any, () => ({
  platformId: "faketrade2178",
  name: "Fake Trade 2178",
  getStatus: async () => ({}),
  getQuote: async () => ({}),
  getAccounts: async () => [],
  getPositions: async () => ({ account: {}, positions: [] }),
  previewOrder: async (params: any) => ({ id: "draft-2178", ...params }),
  executeOrder: async (orderId: string, authorizerDid: string, decision: string) => {
    executions.push({ orderId, authorizerDid, decision });
    return { orderId, status: decision === "approved" ? "placed" : "cancelled", authorizerDid };
  },
}) as any);

const executions: any[] = [];

const tradeConfig = {
  enabledProviders: ["faketrade2178"],
  defaultProvider: "faketrade2178",
  enabledServices: ["stock_trading"],
};

function fakeEvents(opts: { throwOn?: string } = {}) {
  const created: any[] = [];
  return {
    created,
    create(record: any) {
      if (opts.throwOn && record.type === opts.throwOn) {
        throw new Error("audit store unavailable");
      }
      created.push(record);
      return record;
    },
  };
}

async function door(events: any) {
  const { TradingAgent } = await import("../src/agents/trading-agent");
  const agent: any = Object.create(TradingAgent.prototype);
  agent.env = env;
  agent.config = () => tradeConfig;
  agent.getOrm = () => ({ events });
  return agent;
}

describe("TradingAgent doors blocking audit (#2178 S2)", () => {
  it("executeApprovedOrder audits decision before settle and result after", async () => {
    const events = fakeEvents();
    const agent = await door(events);
    executions.length = 0;
    const placed: any = await agent.executeApprovedOrder({
      provider: "faketrade2178",
      orderId: "draft-2178",
      userLogin: "alice",
      authorizerDid: "did:web:alice",
      decision: "approved",
    });
    expect(placed.status).toBe("placed");
    expect(executions).toHaveLength(1);
    expect(events.created.map((r: any) => r.type)).toEqual([
      "trade.approval_decision",
      "trade.order_executed",
    ]);
    expect(events.created[0].payload.orderId).toBe("draft-2178");
    expect(events.created[0].payload.authorizerDid).toBe("did:web:alice");
  });

  it("a throwing decision audit blocks settle entirely", async () => {
    const events = fakeEvents({ throwOn: "trade.approval_decision" });
    const agent = await door(events);
    executions.length = 0;
    await expect(
      agent.executeApprovedOrder({
        provider: "faketrade2178",
        orderId: "draft-2178",
        userLogin: "alice",
        authorizerDid: "did:web:alice",
        decision: "approved",
      }),
    ).rejects.toThrowError("audit store unavailable");
    expect(executions).toHaveLength(0);
  });

  it("a throwing result audit never reports success for an unaudited execution", async () => {
    const events = fakeEvents({ throwOn: "trade.order_executed" });
    const agent = await door(events);
    executions.length = 0;
    const err: any = await agent
      .executeApprovedOrder({
        provider: "faketrade2178",
        orderId: "draft-2178",
        userLogin: "alice",
        authorizerDid: "did:web:alice",
        decision: "approved",
      })
      .catch((e: any) => e);
    expect(err.code).toBe("internal_error");
    expect(err.message).toMatch(/draft-2178.*audit/i);
    expect(executions).toHaveLength(1);
  });

  it("decideTradeApproval audits the decision before delivering the event", async () => {
    const events = fakeEvents();
    const agent = await door(events);
    const delivered: any[] = [];
    agent.sendWorkflowEvent = async (...args: any[]) => {
      delivered.push(args);
    };
    const out: any = await agent.decideTradeApproval({
      workflowId: "wf-1",
      authorizerDid: "did:web:alice",
      decision: "approved",
    });
    expect(out.delivered).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(events.created.map((r: any) => r.type)).toEqual(["trade.approval_decision"]);
    expect(events.created[0].payload.workflowId).toBe("wf-1");
  });

  it("a throwing decision audit means the decision never reaches the workflow", async () => {
    const events = fakeEvents({ throwOn: "trade.approval_decision" });
    const agent = await door(events);
    const delivered: any[] = [];
    agent.sendWorkflowEvent = async (...args: any[]) => {
      delivered.push(args);
    };
    await expect(
      agent.decideTradeApproval({
        workflowId: "wf-1",
        authorizerDid: "did:web:alice",
        decision: "approved",
      }),
    ).rejects.toThrowError("audit store unavailable");
    expect(delivered).toHaveLength(0);
  });

  it("input validation still runs before any audit", async () => {
    const events = fakeEvents();
    const agent = await door(events);
    const anon: any = await agent
      .decideTradeApproval({ workflowId: "wf-1", decision: "approved" })
      .catch((e: any) => e);
    expect(anon.code).toBe("invalid_input");
    expect(events.created).toHaveLength(0);
  });
});
