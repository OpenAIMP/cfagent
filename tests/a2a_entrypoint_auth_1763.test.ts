/**
 * Issue #1763 (parent #1717, scan row F-25) — A2A invocation auth
 * VERIFIED FROM THE ENTRYPOINT.
 *
 * The pre-existing tests in tests/trading_agent.test.ts ("A2A edge
 * auth (#291 A5)") call handleA2A directly, bypassing src/server.ts
 * dispatch — so they never proved the WORKER entrypoint enforces
 * auth. The scan row was right that entrypoint verification was
 * missing, and the docs/catalog claims ("not verified", "no edge
 * auth") were stale in the other direction: src/a2a/index.ts has
 * enforced Bearer A2A_API_TOKEN (timing-safe, fail-closed 503 when
 * unset, 401 before agent resolution) since #291 A5.
 *
 * These tests go through the worker's default fetch export — the
 * real handleFetch dispatch (server.ts branch: /a2a/* →
 * handleA2A) — with a fake TRADING_AGENT stub, and assert the stub
 * is NEVER reached without a valid token.
 */
import { describe, it, expect, vi } from "vitest";

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
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import worker from "../src/server";

function makeEnv(extra: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  return {
    calls,
    env: {
      ...extra,
      TRADING_AGENT: {
        idFromName: (name: string) => ({ name }),
        get: () => ({
          handleA2A: async (body: unknown, origin: string) => {
            calls.push([body, origin]);
            return { text: "ok", data: { ok: true } };
          },
        }),
      },
    } as any,
  };
}

const post = (path: string, token?: string) =>
  new Request(`https://agent.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "message/send", params: {} }),
  });

describe("A2A invocation auth from the worker entrypoint (#1763, F-25)", () => {
  it("fails closed with 503 when no A2A token is configured; stub never reached", async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(post("/a2a/trading", "anything"), env);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("rejects missing and wrong tokens with 401 before agent resolution; stub never reached", async () => {
    const { env, calls } = makeEnv({ A2A_API_TOKEN: "s3cret" });
    expect((await worker.fetch(post("/a2a/trading"), env)).status).toBe(401);
    expect((await worker.fetch(post("/a2a/trading", "wr0ng"), env)).status).toBe(401);
    // Even for an unknown agent — auth precedes routing disclosure.
    expect((await worker.fetch(post("/a2a/nope", "wr0ng"), env)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("dispatches with the correct token; discovery stays public", async () => {
    const { env, calls } = makeEnv({ A2A_API_TOKEN: "s3cret" });
    const res = await worker.fetch(post("/a2a/trading", "s3cret"), env);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const cardRes = await worker.fetch(
      new Request("https://agent.test/a2a/trading/agent-card.json"),
      makeEnv({}).env,
    );
    expect(cardRes.status).toBe(200);
  });
});
