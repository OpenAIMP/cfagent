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

function fakeEnv(withServiceIdentity = true) {
  const agentFetchCalls: string[] = [];
  const fakeAgent = {
    fetch: async (req: Request) => {
      agentFetchCalls.push(new URL(req.url).pathname);
      return new Response("ok");
    },
  };
  const env = {
    SEARCH_AGENT: { idFromName: () => "shared-instance", get: () => fakeAgent },
    SCHEDULED_AGENT: {
      idFromName: () => "default",
      get: () => ({ onCron: async () => undefined }),
    },
    // #1185: the identity-bearing dispatches require the configured
    // service identity; without it they are skipped (fail closed).
    ...(withServiceIdentity ? { SERVICE_USER_LOGIN: "svc-background" } : {}),
  };
  return { env, agentFetchCalls };
}

describe("worker scheduled() social dispatch (Phase 5b slice 1)", () => {
  it("runs the */30 tick with default env without throwing and without extra agent fetches", async () => {
    const { env, agentFetchCalls } = fakeEnv();
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    await worker.scheduled({ cron: "*/30 * * * *" }, env as never, ctx as never);
    await Promise.all(waited);
    // The four established dispatches ride this tick: research,
    // reflection, strategy-weight adjustment, and (issue #1169
    // S4-4) the weekly corpus sync — plus the ScheduledAgent
    // onCron call (mocked here). Social posting adds no dispatch
    // of its own since Phase 5b slice 1 retired the parallel
    // social tick: posting is a ScheduledAgent goal evaluated
    // inside onCron, not a server.ts block.
    expect(agentFetchCalls.sort()).toEqual([
      "/adaptation/weights/run",
      "/knowledge/corpus-sync",
      "/reflection/run",
      "/research/scheduled-tick",
    ]);
  });

  it("skips the identity-bearing dispatches when no service identity is configured (#1185)", async () => {
    const { env, agentFetchCalls } = fakeEnv(false);
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    await worker.scheduled({ cron: "*/30 * * * *" }, env as never, ctx as never);
    await Promise.all(waited);
    // Fail closed: the ScheduledAgent onCron still runs (it asserts no
    // identity from this handler), but no dispatch carries a fabricated
    // identity — and nothing throws.
    expect(agentFetchCalls).toEqual([]);
  });

  it("runs no social work on crons other than */30", async () => {
    const { env, agentFetchCalls } = fakeEnv();
    const waited: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
    // An unrelated cron hits neither the */30 branch (where onCron
    // runs) nor any dispatch: no agent fetches at all.
    await worker.scheduled({ cron: "0 5 * * *" }, env as never, ctx as never);
    await Promise.all(waited);
    expect(agentFetchCalls).toEqual([]);
  });
});
