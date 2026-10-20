import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The Think base pulls the agents SDK module graph (cloudflare:
// imports the node loader cannot resolve) — mock it with a plain base
// class, the api_chat_route.test.ts idiom. The harness's own methods
// (getModel / getTools / maxSteps) run for real.
vi.mock("@cloudflare/think", () => ({
  Think: class MockThink {
    ctx: any;
    env: any;
    maxSteps = 0;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ThinkOrchestratorHarness, resolveMasMaxSteps, stubMcpContext, legacyRowToSessionMessage } from "./think-orchestrator-harness";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import { createMAS } from "../src/agents/mas";
import { McpToolFactory } from "../src/mcp/commands";
import { getWorkersAIModel, resolveAiModelName } from "../src/agents/model";
import { REST_APIS_CATALOG } from "../src/client/mcpEndpointsData";

/**
 * Issue #658 (Think migration step 2) — parity harness.
 *
 * R1 mapping (chat contract, per assertion): the POST /api/chat
 * contract ({reply, route{...}, model, streaming:false}) is produced
 * by the route adapter above the agent class and is pinned
 * behaviorally by api_chat_contract / api_chat_route against the live
 * class; it does not change with the base class. This suite pins the
 * catalog surface (below) plus everything the base-class swap DOES
 * touch: R2 tool surface, R4 model arm, R5 step bound, R3 session
 * format. Full DO-runtime behavior is step 3 (shadow).
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function makeHarness(env: Record<string, unknown> = {}) {
  return new ThinkOrchestratorHarness({ storage: { sql: { exec: () => [] } } }, env as never);
}

describe("#658 R1 — the preserved contract surface", () => {
  it("the api_chat catalog contract is the surface the migration must preserve", () => {
    const apiChat = REST_APIS_CATALOG.find((e) => e.id === "api_chat")!;
    expect(Object.keys(apiChat.sampleResponse || {}).sort()).toEqual([
      "model",
      "reply",
      "route",
      "streaming",
    ]);
    expect(apiChat.sampleResponse!.streaming).toBe(false);
  });
});

describe("#658 R2 — tool surface parity (createAgentMcpTools)", () => {
  const env = { AI: {} };
  const liveNames = Object.keys(createAgentMcpTools(stubMcpContext(env as never))).sort();

  it("the harness getTools() returns exactly the manual loop's tool names", () => {
    const harnessNames = Object.keys(makeHarness(env).getTools()).sort();
    expect(harnessNames).toEqual(liveNames);
  });

  it("every canonical McpToolFactory command is present by name", () => {
    const canonical = McpToolFactory.getAllTools().map((c) => c.name);
    expect(canonical.length).toBeGreaterThan(0);
    for (const name of canonical) expect(liveNames).toContain(name);
  });

  it("the documented aliases and adapter-added tools are present", () => {
    for (const name of [
      "searchKnowledge",
      "queryPlatformKnowledge",
      "getPlatformCapabilities",
      "draftPayment",
      "confirmDraft",
      "createTaskDraft",
      "rememberFact",
      "recallFacts",
      "compare_stock_valuations",
      "compareValuations",
      "compareStocks",
    ]) {
      expect(liveNames).toContain(name);
    }
  });

  it("the MAS six (spike correction, quantified): createMAS names are a subset of the live set", () => {
    const mas = createMAS({
      env: {} as never,
      sessionId: "parity",
      requestId: "parity",
      sql: { exec: () => [] as unknown[] },
      audit: () => {},
    });
    const masNames = Object.keys(mas).sort();
    expect(masNames).toEqual([
      "confirmDraft",
      "createTaskDraft",
      "draftPayment",
      "recallFacts",
      "rememberFact",
      "searchKnowledge",
    ]);
    for (const name of masNames) expect(liveNames).toContain(name);
  });
});

describe("#658 R4 — model arm (constructed)", () => {
  it("the harness model resolves to the same model id as today's construction", () => {
    const env = { AI: {} } as never;
    const harnessModel = makeHarness(env as unknown as Record<string, unknown>).getModel() as unknown as { modelId: string };
    const todayModel = getWorkersAIModel(env) as unknown as { modelId: string };
    expect(harnessModel.modelId).toBe(todayModel.modelId);
    expect(harnessModel.modelId).toBe(resolveAiModelName(env));
  });

  it("an env AI_MODEL override flows through identically", () => {
    const env = { AI: {}, AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as never;
    const harnessModel = makeHarness(env as unknown as Record<string, unknown>).getModel() as unknown as { modelId: string };
    expect(harnessModel.modelId).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });
});

describe("#658 R5 — step bound parity", () => {
  it("resolves today's clamp for representative env values", () => {
    expect(resolveMasMaxSteps({})).toBe(6);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "3" } as never)).toBe(3);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "99" } as never)).toBe(10);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "0" } as never)).toBe(1);
  });

  it("documents today's NaN edge instead of fixing it (step-3 note)", () => {
    // Number("abc") is NaN; today's expression propagates it into
    // stepCountIs(NaN). Recorded as-is — behavior changes are out of
    // step-2 scope.
    expect(Number.isNaN(resolveMasMaxSteps({ MAS_MAX_STEPS: "abc" } as never))).toBe(true);
  });

  it("the harness carries the resolved bound on Think's maxSteps", () => {
    expect(makeHarness({}).maxSteps).toBe(6);
    expect(makeHarness({ MAS_MAX_STEPS: "3" }).maxSteps).toBe(3);
    expect(makeHarness({ MAS_MAX_STEPS: "99" }).maxSteps).toBe(10);
  });

  it("Think's type surface exposes the bound (class property + per-turn override)", () => {
    const dist = fs.readdirSync(path.join(ROOT, "node_modules/@cloudflare/think/dist"));
    const dts = dist.filter((f) => f.endsWith(".d.ts")).map((f) => read(`node_modules/@cloudflare/think/dist/${f}`)).join("\n");
    expect(dts).toContain("maxSteps");
    expect(dts).toContain("TurnConfig");
  });
});

describe("#658 R3 — session format: legacy rows transform mechanically", () => {
  const userRow = {
    id: "row-1",
    message: JSON.stringify({
      id: "msg-1",
      role: "user",
      parts: [{ type: "text", text: "Show me NVDA calls" }],
    }),
    created_at: "2026-10-01T12:00:00.000Z",
  };
  const assistantRow = {
    id: "row-2",
    message: JSON.stringify({
      id: "msg-2",
      role: "assistant",
      parts: [
        { type: "text", text: "Running the query." },
        {
          type: "tool-execute_nlq",
          toolCallId: "tc-1",
          state: "output-available",
          input: { query: "SELECT * FROM mas_trades" },
          output: { rows: 3 },
        },
      ],
      metadata: { agent: "search" },
    }),
    created_at: "2026-10-01T12:00:05.000Z",
  };

  it("maps the envelope (id, role, createdAt from the row)", () => {
    const out = legacyRowToSessionMessage(userRow);
    expect(out.id).toBe("msg-1");
    expect(out.role).toBe("user");
    expect(out.createdAt).toBe("2026-10-01T12:00:00.000Z");
  });

  it("carries parts through unchanged, including tool parts", () => {
    const out = legacyRowToSessionMessage(assistantRow);
    expect(out.parts).toEqual(JSON.parse(assistantRow.message).parts);
    expect(out.metadata).toEqual({ agent: "search" });
  });

  it("the current stack already migrates legacy rows into the SDK session store", () => {
    const aiChat = read("node_modules/@cloudflare/ai-chat/dist/index.js");
    expect(aiChat).toContain("cf_ai_chat_agent_messages");
    expect(aiChat).toContain("_migrateLegacyMessages");
  });

  it("the SDK SessionMessage is documented as UIMessage-compatible", () => {
    const dist = fs.readdirSync(path.join(ROOT, "node_modules/agents/dist"));
    const dts = dist
      .filter((f) => f.endsWith(".d.ts"))
      .map((f) => read(`node_modules/agents/dist/${f}`))
      .join("\n");
    expect(dts).toContain("interface SessionMessage");
    expect(dts).toMatch(/UIMessage[\s\S]{0,120}structurally compatible|structurally compatible[\s\S]{0,120}UIMessage/);
  });
});
