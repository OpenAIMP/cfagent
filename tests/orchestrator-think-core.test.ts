import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Mock the Think base (api_chat_route idiom): the real module graph
// pulls cloudflare: imports the node loader cannot resolve. The
// shadow class's own methods run for real.
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

import {
  buildOrchestratorSystemPrompt,
  resolveMasMaxSteps,
  resolveShadowMaxSteps,
} from "../src/agents/chatPrompt";
import { OrchestratorThinkAgent } from "../src/agents/orchestrator-think";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import { resolveAiModelName } from "../src/agents/model";
import { EXPECTED_PROMPTS } from "./orchestrator-prompt-fixtures";
import { MockSqlStorage } from "./mock-sql";

/**
 * Issue #668 (Think migration step 3a) — extraction identity + shadow core.
 *
 * R1: the extracted prompt builder reproduces the pre-extraction live
 * template byte-for-byte (fixtures captured from the original source,
 * see orchestrator-prompt-fixtures.ts). R2: the clamp — production
 * resolver verbatim (NaN included), shadow resolver sanitizes.
 * R3/R4: the shadow's model/tools/grounding wiring. R5: inertness.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("#668 R1 — prompt builder byte-identity with the pre-extraction template", () => {
  it("plain route, no contexts", () => {
    expect(
      buildOrchestratorSystemPrompt({
        route: { agent: "search", confidence: 0.92, reason: "test route" },
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    ).toBe(EXPECTED_PROMPTS.plain);
  });

  it("grounded route (memory + vector contexts interpolated)", () => {
    expect(
      buildOrchestratorSystemPrompt({
        route: { agent: "trading", confidence: 1, reason: "Direct execution" },
        memoryContext: '\nActive Persistent Memory (SQLite Session Facts):\n- risk: "conservative"',
        vectorContext: "\nRelevant past outcomes (vector memory, most similar first):\n- prior run summary",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    ).toBe(EXPECTED_PROMPTS.grounded);
  });

  it("auto-research route (job context + conditional instruction)", () => {
    expect(
      buildOrchestratorSystemPrompt({
        route: {
          agent: "trading",
          confidence: 1,
          reason: "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
        },
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: 'AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:\n{"query":"scan","jobId":"job-1","status":"queued"}',
        isAutoOptionsResearchRequest: true,
      })
    ).toBe(EXPECTED_PROMPTS.autoResearch);
  });

  it("the live turn consumes the builder (no inline template remains)", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain('from "./chatPrompt"');
    expect(orch).toContain("buildOrchestratorSystemPrompt({");
    expect(orch).not.toContain("You are the master orchestrator for Multi-Agent Studio (OpenAIMP), an enterprise financial intelligence");
  });
});

describe("#668 R2 — step clamp: production verbatim, shadow sanitized", () => {
  it("production resolver matches today's expression, NaN included", () => {
    expect(resolveMasMaxSteps({})).toBe(6);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "3" })).toBe(3);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "99" })).toBe(10);
    expect(resolveMasMaxSteps({ MAS_MAX_STEPS: "0" })).toBe(1);
    expect(Number.isNaN(resolveMasMaxSteps({ MAS_MAX_STEPS: "abc" }))).toBe(true);
  });

  it("shadow resolver sanitizes only the NaN case", () => {
    expect(resolveShadowMaxSteps({})).toBe(6);
    expect(resolveShadowMaxSteps({ MAS_MAX_STEPS: "3" })).toBe(3);
    expect(resolveShadowMaxSteps({ MAS_MAX_STEPS: "99" })).toBe(10);
    expect(resolveShadowMaxSteps({ MAS_MAX_STEPS: "abc" })).toBe(6);
  });

  it("the live class uses the production resolver", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("resolveMasMaxSteps(this.env)");
    expect(orch).not.toContain("Math.max(1, Math.min(10, Number(this.env.MAS_MAX_STEPS");
  });
});

function makeShadow(env: Record<string, unknown> = { AI: {} }) {
  const sql = new MockSqlStorage();
  const ctx = {
    id: { toString: () => "shadow-session-1" },
    storage: { sql },
  };
  const agent = new OrchestratorThinkAgent(ctx as never, env as never);
  return { agent, sql };
}

describe("#668 R3/R4 — shadow core wiring", () => {
  it("model: constructed arm, same id as today's resolution", () => {
    const { agent } = makeShadow();
    const model = agent.getModel() as unknown as { modelId: string };
    expect(model.modelId).toBe(resolveAiModelName({ AI: {} } as never));
  });

  it("tools: name set equals the live factory's set for the same context shape", () => {
    const { agent } = makeShadow();
    const shadowNames = Object.keys(agent.getTools()).sort();
    const liveNames = Object.keys(
      createAgentMcpTools({
        env: { AI: {} } as never,
        orm: {} as never,
        sessionId: "shadow-session-1",
        requestId: "core-test",
        audit: () => {},
      })
    ).sort();
    expect(shadowNames).toEqual(liveNames);
  });

  it("maxSteps: sanitized bound on the class", () => {
    expect(makeShadow({ AI: {} }).agent.maxSteps).toBe(6);
    expect(makeShadow({ AI: {}, MAS_MAX_STEPS: "99" }).agent.maxSteps).toBe(10);
    expect(makeShadow({ AI: {}, MAS_MAX_STEPS: "abc" }).agent.maxSteps).toBe(6);
  });

  it("grounding: session-memory facts render in the live format; vector empty without bindings", async () => {
    const { agent, sql } = makeShadow();
    (agent as never as { ensureTables(): unknown }).ensureTables();
    sql.exec(
      "INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?)",
      "risk",
      "conservative",
      "2026-10-20T00:00:00.000Z"
    );
    const { memoryContext, vectorContext } = await agent.assembleGrounding("anything");
    expect(memoryContext).toBe(
      '\nActive Persistent Memory (SQLite Session Facts):\n- risk: "conservative"'
    );
    expect(vectorContext).toBe("");
  });

  it("context blocks: a session-memory block is registered via configureContext", async () => {
    const { agent } = makeShadow();
    const blocks = await agent.configureContext();
    const labels = blocks.map((b) => b.label);
    expect(labels).toContain("session-memory");
  });

  it("system prompt fallback comes from the shared builder", () => {
    const { agent } = makeShadow();
    expect(agent.getSystemPrompt()).toContain("You are the master orchestrator");
  });
});

describe("#668 R5 — inertness pins", () => {
  it("the shadow is not exported from src/server.ts and not bound in wrangler", () => {
    expect(read("src/server.ts")).not.toContain("orchestrator-think");
    expect(read("src/server.ts")).not.toContain("OrchestratorThinkAgent");
    expect(read("wrangler.jsonc")).not.toContain("OrchestratorThinkAgent");
  });
});
