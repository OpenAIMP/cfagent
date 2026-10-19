import { describe, it, expect, vi, beforeEach } from "vitest";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (same pattern as
// tests/audit-event-endpoint.test.ts); the route only needs ctx.storage,
// ctx.id and env, all stubbed per-test.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      messages: any[];
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
        this.messages = [];
      }
    },
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { MockSqlStorage } from "./mock-sql";

/**
 * Issue #312 — POST /api/chat was advertised in WorkflowsHub.tsx and
 * mcpEndpointsData.ts ("Multi-Agent Conversation Stream", sample body
 * { messages: [{ role: "user", content: "..." }] }) but no route existed.
 *
 * The route is a thin adapter over the single-owner agentic chat turn
 * (runAgenticChatTurn) — the same judge-routed pipeline the WebSocket chat
 * runs. The HTTP response carries the completed turn as JSON (non-streaming);
 * streaming remains available over the agent WebSocket chat the UI uses.
 *
 * The agentic pipeline itself (judge + Workers AI) is stubbed here; these
 * tests pin the route contract: validation, delegation, shape, and error
 * mapping. They must not execute a second chat implementation.
 */
describe("POST /api/chat (#312) — orchestrator route", () => {
  const SESSION_KEY = "api-chat-route-test";

  const STUB_ROUTE = {
    agent: "search",
    confidence: 0.92,
    reason: "test route",
    needsConfirmation: false,
  };

  function makeAgent() {
    const sql = new MockSqlStorage();
    const ctx = {
      storage: { sql },
      id: { toString: () => SESSION_KEY },
    } as any;
    const agent: any = Object.create(OrchestratorAgent.prototype);
    agent.ctx = ctx;
    agent.env = { APP_ENV: "TEST" } as any;
    agent.messages = [];
    agent.persistMessages = async () => {};
    const turnCalls: any[] = [];
    agent.runAgenticChatTurn = async (opts: any) => {
      turnCalls.push(opts);
      return {
        result: { text: Promise.resolve("stubbed agentic reply") },
        route: STUB_ROUTE,
      };
    };
    return { agent, sql, turnCalls };
  }

  function postChat(agent: any, body: unknown) {
    // In production the Worker strips /api before forwarding, so the DO sees
    // /chat; the handler also accepts the unstripped form.
    return agent.onRequest(
      new Request("https://agent.test/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": "octocat" },
        body: JSON.stringify(body),
      })
    );
  }

  it("accepts the advertised sample payload from mcpEndpointsData.ts", async () => {
    const { agent, turnCalls } = makeAgent();
    const res = await postChat(agent, {
      messages: [{ role: "user", content: "Hello AI Assistant" }],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reply).toBe("stubbed agentic reply");
    expect(json.streaming).toBe(false);
    expect(json.route.agent).toBe("search");
    expect(typeof json.model).toBe("string");
    // The turn went through the single-owner pipeline, not a parallel one.
    expect(turnCalls).toHaveLength(1);
    expect(turnCalls[0].userText).toBe("Hello AI Assistant");
    expect(turnCalls[0].isAutoOptionsResearchRequest).toBe(false);
    expect(turnCalls[0].userLogin).toBe("octocat");
  });

  it("rejects missing/empty messages with 400", async () => {
    const { agent } = makeAgent();
    for (const bad of [{}, { messages: [] }, { messages: [{ role: "user", content: "   " }] }, { messages: [{ role: "assistant", content: "hi" }] }, null]) {
      const res = await postChat(agent, bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/messages/);
    }
  });

  it("does not duplicate a re-sent history tail", async () => {
    const { agent, turnCalls } = makeAgent();
    const body = { messages: [{ role: "user", content: "same question" }] };
    await postChat(agent, body);
    await postChat(agent, body);
    expect(turnCalls).toHaveLength(2);
    // user + assistant per turn, no duplicate user append on the re-send.
    expect(agent.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(agent.messages.filter((m: any) => m.role === "assistant")).toHaveLength(2);
  });

  it("maps pipeline errors to the degraded fallback JSON (same content the WS chat streams)", async () => {
    const { agent } = makeAgent();
    agent.runAgenticChatTurn = async () => {
      throw new Error("boom");
    };
    agent.buildChatErrorFallback = async () => "FALLBACK TEXT";
    const res = await postChat(agent, { messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.reply).toBe("FALLBACK TEXT");
    expect(json.fallback).toBe(true);
  });
});
