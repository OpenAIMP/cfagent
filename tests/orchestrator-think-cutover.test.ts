import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// @cloudflare/think is aliased to tests/stubs/cloudflareThink.ts by
// vite.config (the real module graph pulls cloudflare: imports the
// node loader cannot resolve). The stub drives the class's real
// beforeTurn/onChatResponse hooks and returns a stubbed TurnResult —
// the provider boundary is stubbed, the lifecycle is not.
// @cloudflare/ai-chat is mocked because the orchestrator's routes
// graph reaches BrowserAgent/SlackAgent, which extend AIChatAgent.
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
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      throw new Error("generateText disabled in cutover tests");
    }),
  };
});

import { OrchestratorAgent } from "../src/agents/orchestrator";
import { LLMJudge } from "../src/agents/judge";
import {
  buildOrchestratorSystemPrompt,
  resolveMasMaxSteps,
  resolveShadowMaxSteps,
} from "../src/agents/chatPrompt";
import { createAgentMcpTools } from "../src/agents/mcpAdapter";
import { resolveAiModelName } from "../src/agents/model";
import { EXPECTED_PROMPTS } from "./orchestrator-prompt-fixtures";
import { MockSqlStorage } from "./mock-sql";
import judgeGolden from "./fixtures/judge-golden.json";

/**
 * Issue #686 (Think migration step 4 — CUTOVER).
 *
 * The production OrchestratorAgent is Think-based under its stable
 * identity. This suite carries forward the step-3a/3b evidence pins
 * (prompt byte-identity, clamp, route parity, turn shape, side
 * effects, bounds) re-pointed at the real class, and adds the
 * cutover-specific pins: R1 identity stability, R6 legacy lift,
 * R5 onChatError format.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// MockSqlStorage returns plain arrays from exec(); the job claim
// gate reads rowsWritten off the cursor (see the 3b suite).
class ClaimAwareSql extends MockSqlStorage {
  exec(query: string, ...args: unknown[]): any {
    const result = super.exec(query, ...args) as any;
    if (/^\s*UPDATE\s+mas_async_jobs\s+SET\s+status = 'running'/i.test(query)) {
      const rows = Array.from(
        super.exec("SELECT job_id, status FROM mas_async_jobs WHERE job_id = ?", args[2])
      ) as Array<{ status?: string }>;
      result.rowsWritten = rows.length > 0 && rows[0].status === "running" ? 1 : 0;
    }
    return result;
  }
}

function makeAgent(env: Record<string, unknown> = { AI: {} }) {
  const sql = new ClaimAwareSql();
  const ctx = {
    id: { toString: () => "cutover-session-1" },
    storage: { sql },
  };
  const agent = new OrchestratorAgent(ctx as never, env as never) as any;
  return { agent, sql };
}

function readMessages(sql: MockSqlStorage) {
  return Array.from(sql.exec("SELECT role, content, agent FROM mas_messages")) as Array<{
    role: string;
    content: string;
    agent: string;
  }>;
}

function readEvents(sql: MockSqlStorage) {
  return (
    Array.from(sql.exec("SELECT type, agent, payload FROM mas_events")) as Array<{
      type: string;
      agent: string;
      payload: string;
    }>
  ).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
}

describe("#686 R1 — identity stability under the cutover", () => {
  it("the production class extends Think; the shadow file is gone", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("extends Think<Env>");
    expect(orch).toContain('from "@cloudflare/think"');
    expect(orch).not.toContain("@cloudflare/ai-chat");
    expect(fs.existsSync(path.join(ROOT, "src/agents/orchestrator-think.ts"))).toBe(false);
  });

  it("server export alias and wrangler binding/migrations are unchanged", () => {
    expect(read("src/server.ts")).toContain(
      'export { OrchestratorAgent as SearchAgent } from "./agents/orchestrator"'
    );
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toContain('{ "name": "SEARCH_AGENT", "class_name": "SearchAgent" }');
    expect(wrangler).toContain('{ "tag": "v1", "new_sqlite_classes": ["SearchAgent"] }');
    expect(wrangler).not.toContain('"tag": "v7"');
  });

  it("the routes ctx bag exposes Think session accessors, not AIChatAgent ones", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain("getMessages: () => this.getMessages()");
    expect(orch).not.toContain("this.messages");
    const routes = read("src/agents/routes/mcpChatNlq.ts");
    expect(routes).not.toContain("setMessages");
    expect(routes).not.toContain("persistMessages");
  });
});

describe("#686 carried-forward 3a pins — prompt builder byte-identity + clamp", () => {
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

  it("grounded + auto-research fixtures still match the pre-extraction template", () => {
    expect(
      buildOrchestratorSystemPrompt({
        route: { agent: "trading", confidence: 1, reason: "Direct execution" },
        memoryContext: '\nActive Persistent Memory (SQLite Session Facts):\n- risk: "conservative"',
        vectorContext: "\nRelevant past outcomes (vector memory, most similar first):\n- prior run summary",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    ).toBe(EXPECTED_PROMPTS.grounded);
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

  it("R8: the sanitized clamp is now the production resolver for the class", () => {
    expect(makeAgent({ AI: {} }).agent.maxSteps).toBe(6);
    expect(makeAgent({ AI: {}, MAS_MAX_STEPS: "99" }).agent.maxSteps).toBe(10);
    // The deliberate delta: non-numeric no longer propagates NaN.
    expect(Number.isNaN(resolveMasMaxSteps({ MAS_MAX_STEPS: "abc" } as never))).toBe(true);
    expect(makeAgent({ AI: {}, MAS_MAX_STEPS: "abc" }).agent.maxSteps).toBe(resolveShadowMaxSteps({ MAS_MAX_STEPS: "abc" } as never));
    expect(makeAgent({ AI: {}, MAS_MAX_STEPS: "abc" }).agent.maxSteps).toBe(6);
  });
});

describe("#686 Think surface on the production class", () => {
  it("model: constructed arm, same id as today's resolution", () => {
    const { agent } = makeAgent();
    expect((agent.getModel() as { modelId: string }).modelId).toBe(
      resolveAiModelName({ AI: {} } as never)
    );
  });

  it("tools: name set equals the live factory's set", () => {
    const { agent } = makeAgent();
    const classNames = Object.keys(agent.getTools()).sort();
    const factoryNames = Object.keys(
      createAgentMcpTools({
        env: { AI: {} } as never,
        orm: {} as never,
        sessionId: "cutover-session-1",
        requestId: "cutover-test",
        audit: () => {},
      })
    ).sort();
    expect(classNames).toEqual(factoryNames);
  });

  it("system prompt fallback comes from the shared builder; memory block registered", async () => {
    const { agent } = makeAgent();
    expect(agent.getSystemPrompt()).toContain("You are the master orchestrator");
    const blocks = await agent.configureContext();
    expect(blocks.map((b: any) => b.label)).toContain("session-memory");
  });
});

const GOLDEN = (
  judgeGolden as {
    entries: Array<{
      id: string;
      text: string;
      expectedIntent: string;
      expectedConfidence: number;
      expectedNeedsConfirmation: boolean;
      recentMessages?: Array<{ role: string; content: string }>;
    }>;
  }
).entries;

describe("#686 R2/R3/R4 — the production turn, through runAgenticChatTurn", () => {
  it("route parity across the golden corpus, now on the real class", async () => {
    const failures: string[] = [];
    for (const entry of GOLDEN) {
      const recent = (entry.recentMessages ?? []) as Array<{ role?: string; content: string }>;
      const live = await new LLMJudge({} as never).route(entry.text, recent);
      const { agent } = makeAgent();
      const { route } = await agent.runAgenticChatTurn({
        userText: entry.text,
        recentTurns: recent,
        userLogin: "cutover-tester",
        isAutoOptionsResearchRequest: false,
      });
      if (
        route.agent !== live.agent ||
        route.confidence !== live.confidence ||
        route.reason !== live.reason ||
        route.needsConfirmation !== live.needsConfirmation
      ) {
        failures.push(`${entry.id}: class route != live judge route`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("turn result keeps the adapter contract {result:{text}, route}", async () => {
    const { agent } = makeAgent();
    const { result, route } = await agent.runAgenticChatTurn({
      userText: "hello there",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(await result.text).toBe("Stub assistant reply.");
    expect(Object.keys(route).sort()).toEqual(["agent", "confidence", "needsConfirmation", "reason"]);
  });

  it("side effects land exactly once: user + assistant rows, route.decided + response.evaluated", async () => {
    const { agent, sql } = makeAgent();
    const { route } = await agent.runAgenticChatTurn({
      userText: "remember that my risk tolerance is conservative",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(readMessages(sql)).toEqual([
      {
        role: "user",
        content: "remember that my risk tolerance is conservative",
        agent: "orchestrator",
      },
      { role: "assistant", content: "Stub assistant reply.", agent: route.agent },
    ]);
    const events = readEvents(sql);
    const decided = events.find((e) => e.type === "route.decided");
    expect(decided?.payload).toEqual({
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });
    const evaluated = events.find((e) => e.type === "response.evaluated");
    expect(evaluated?.payload).toEqual({
      score: 75,
      grounded: true,
      safe: true,
      issues: ["Automated evaluation skipped due to judge timeout or rate limit"],
    });
  });

  it("re-send of the history tail: no duplicate session user message, no duplicate user record", async () => {
    const { agent, sql } = makeAgent();
    const opts = {
      userText: "same question",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: false,
    };
    await agent.runAgenticChatTurn(opts);
    await agent.runAgenticChatTurn(opts);
    const session = await agent.getMessages();
    expect(session.filter((m: any) => m.role === "user")).toHaveLength(1);
    expect(session.filter((m: any) => m.role === "assistant")).toHaveLength(2);
    expect(readMessages(sql).filter((m) => m.role === "user")).toHaveLength(1);
    expect(readMessages(sql).filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("auto-research: synthetic route, pre-dispatch, suppression in the applied TurnConfig", async () => {
    const { agent, sql } = makeAgent();
    const { route } = await agent.runAgenticChatTurn({
      userText: "scan for oversold large caps",
      recentTurns: [],
      userLogin: "cutover-tester",
      isAutoOptionsResearchRequest: true,
      sourceTab: "E*TRADE · Auto Options Research",
    });
    expect(route).toEqual({
      agent: "trading",
      confidence: 1,
      reason:
        "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
      needsConfirmation: false,
    });
    const jobs = Array.from(sql.exec("SELECT capability, status FROM mas_async_jobs")) as Array<{
      capability: string;
      status: string;
    }>;
    expect(jobs).toEqual([{ capability: "nlq.execute", status: "queued" }]);
    expect(agent.__turnConfig.activeTools).toEqual([]);
    expect(agent.__turnConfig.maxSteps).toBe(6);
    const marker = "AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:\n";
    const at = agent.__turnConfig.instructions.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const jobLine = agent.__turnConfig.instructions.slice(at + marker.length).split("\n")[0];
    expect(agent.__turnConfig.instructions).toBe(
      buildOrchestratorSystemPrompt({
        route,
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: `${marker}${jobLine}`,
        isAutoOptionsResearchRequest: true,
      })
    );
  });
});

describe("#686 R5 — onChatError carries the live stream-error format", () => {
  it("formats [code] title: message + remediation steps", () => {
    const { agent } = makeAgent();
    const out = agent.onChatError(new Error("provider exploded"));
    expect(typeof out).toBe("string");
    expect(out as string).toMatch(/^\[[A-Z_]+\] /);
    expect(out as string).toContain("Remediation:");
  });
});

describe("#686 R6 — legacy session transform-migration (residual lift)", () => {
  it("imports a residual cf_ai_chat_agent_messages table by id and drops it on a clean lift", async () => {
    const { agent, sql } = makeAgent();
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at TEXT NOT NULL)"
    );
    const m1 = { id: "legacy-1", role: "user", parts: [{ type: "text", text: "old question" }] };
    const m2 = { id: "legacy-2", role: "assistant", parts: [{ type: "text", text: "old answer" }] };
    sql.exec(
      "INSERT INTO cf_ai_chat_agent_messages (id, message, created_at) VALUES (?, ?, ?)",
      "legacy-1",
      JSON.stringify(m1),
      "2026-01-01T00:00:00.000Z"
    );
    sql.exec(
      "INSERT INTO cf_ai_chat_agent_messages (id, message, created_at) VALUES (?, ?, ?)",
      "legacy-2",
      JSON.stringify(m2),
      "2026-01-01T00:01:00.000Z"
    );

    await agent.liftLegacyChatMessages();

    const messages = await agent.getMessages();
    expect(messages.map((m: any) => m.id)).toEqual(["legacy-1", "legacy-2"]);
    const stillThere = Array.from(
      sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'")
    );
    expect(stillThere).toEqual([]);
  });

  it("is a no-op when no legacy table exists", async () => {
    const { agent } = makeAgent();
    await agent.liftLegacyChatMessages();
    expect(await agent.getMessages()).toEqual([]);
  });
});
