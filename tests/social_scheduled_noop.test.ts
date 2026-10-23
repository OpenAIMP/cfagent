import { describe, it, expect, vi } from "vitest";

// Same pattern as tests/api_me_internal_user_id.test.ts: src/server.ts
// re-exports agent classes whose real module graph pulls in
// `cloudflare:` protocol imports the node test loader cannot resolve.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: unknown) => cls };
});

import worker from "../src/server";

function fakeEnv() {
  const agentFetchCalls: string[] = [];
  const fakeAgent = {
    fetch: async (req: Request) => {
      agentFetchCalls.push(new URL(req.url).pathname);
      return new Response("ok");
    },
  };
  const env = {
    SEARCH_AGENT: { idFromName: () => "default_trader", get: () => fakeAgent },
    SCHEDULED_AGENT: {
      idFromName: () => "default",
      get: () => ({ onCron: async () => undefined }),
    },
  };
  return { env, agentFetchCalls };
}

describe("worker scheduled() social tick no-op (Phase 5a)", () => {
  it("runs the */30 tick with default env without throwing and without extra agent fetches", async () => {
    const { env, agentFetchCalls } = fakeEnv();
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    await worker.scheduled({ cron: "*/30 * * * *" }, env as never, ctx as never);
    await Promise.all(waited);
    // The three established dispatches ride this tick: research,
    // reflection, and strategy-weight adjustment. The social tick
    // makes no agent.fetch call of its own: with default env
    // (SOCIAL_POSTING_ENABLED unset) it stops at postingDisabled,
    // and its briefProvider returns null, so it can never build
    // drafts or posts in this phase.
    expect(agentFetchCalls.sort()).toEqual([
      "/adaptation/weights/run",
      "/reflection/run",
      "/research/scheduled-tick",
    ]);
  });

  it("runs no social work on crons other than */30", async () => {
    const { env, agentFetchCalls } = fakeEnv();
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    // An unrelated cron hits neither the */30 branch (where the
    // social tick rides) nor any dispatch: no agent fetches at all.
    await worker.scheduled({ cron: "0 5 * * *" }, env as never, ctx as never);
    await Promise.all(waited);
    expect(agentFetchCalls).toEqual([]);
  });
});
