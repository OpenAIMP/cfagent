/**
 * Issue #1548 ([AGENTIC] Slice 0, data foundation layer) — the
 * ScheduledAgent tick consults HaltRead.
 *
 * The governed predicate stays the decision-maker: the layer
 * supplies a fact (halted or not), never a new predicate. Tests use
 * fakes/shims only — no live scheduled job is created.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ScheduledAgent } from "../src/agents/scheduled-agent";
import { compileGoal } from "../src/orchestrate";
import { InMemoryGovernanceAdapter } from "../src/data/inMemoryGovernanceAdapter";

function makeCtx() {
  const store = new Map<string, unknown>();
  return {
    store,
    ctx: {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => void store.set(k, v),
      },
    },
  };
}

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    PAYMENTS_AGENT: {
      idFromName: () => "payments-default",
      get: () => ({
        budgetCheck: async () => ({ allowed: true }),
      }),
    },
    ...extra,
  } as any;
}

/** Cron due in the current UTC hour, so isDue passes regardless of when the test runs. */
function dueCron() {
  const now = new Date();
  return `0 ${now.getUTCHours()} * * *`;
}

async function materializedAgent(id: string) {
  const { ctx, store } = makeCtx();
  const agent = new (ScheduledAgent as any)(ctx, makeEnv());
  const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
    budgetCents: 5000,
    budgetCapCents: 10000,
  });
  if (!chain) throw new Error("test chain did not compile");
  const record = await agent.synthesizeSchedule(chain, {
    id,
    cron: dueCron(),
  });
  await agent.approveSynthesizedSchedule(id);
  const goal = await agent.materializeSynthesizedSchedule(id);
  return { agent, store, goal, record };
}

describe("tick consults HaltRead (#1548)", () => {
  it("a halted mirror blocks the tick with a halted reason", async () => {
    const { agent, store, goal } = await materializedAgent("synth-halt-mirror");
    const reader = new InMemoryGovernanceAdapter();
    await reader.recordHalt({
      eventId: "halt-1",
      tenantId: "primary",
      scope: "global",
      scopeId: null,
      state: "halted",
      setBy: "tester",
      setAtMs: 1000,
      reason: "test halt",
      version: 1,
      provenance: "test",
    });
    store.set("goals", [goal]);
    const tick = await agent.onCron({ haltReader: reader });
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors.join(" ")).toMatch(/halted/);
  });

  it("a clear mirror fires exactly as before", async () => {
    const { agent, store, goal } = await materializedAgent("synth-clear-mirror");
    const reader = new InMemoryGovernanceAdapter();
    await reader.recordHalt({
      eventId: "clear-1",
      tenantId: "primary",
      scope: "global",
      scopeId: null,
      state: "clear",
      setBy: "tester",
      setAtMs: 1000,
      reason: "test clear",
      version: 1,
      provenance: "test",
    });
    store.set("goals", [goal]);
    const tick = await agent.onCron({ haltReader: reader });
    expect(tick.jobsCreated).toBe(1);
  });

  it("a failing mirror fails closed: the tick refuses to fire", async () => {
    const { agent, store, goal } = await materializedAgent("synth-fail-mirror");
    const failingReader = {
      async isHalted() {
        throw new Error("mirror down");
      },
      async latestHalt() {
        throw new Error("mirror down");
      },
    };
    store.set("goals", [goal]);
    const tick = await agent.onCron({ haltReader: failingReader as any });
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors.join(" ")).toMatch(/halted/);
  });

  it("an explicit halted flag still wins over a clear mirror", async () => {
    const { agent, store, goal } = await materializedAgent("synth-flag-wins");
    const reader = new InMemoryGovernanceAdapter();
    store.set("goals", [goal]);
    const tick = await agent.onCron({ halted: true, haltReader: reader });
    expect(tick.jobsCreated).toBe(0);
    expect(tick.errors.join(" ")).toMatch(/halted/);
  });
});
