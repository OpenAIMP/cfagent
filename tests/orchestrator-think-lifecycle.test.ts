import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Mock the Think base (api_chat_route idiom): the real module graph
// pulls cloudflare: imports the node loader cannot resolve. The mock
// runTurn drives the shadow's real beforeTurn and returns a stubbed
// TurnResult — the provider boundary is stubbed, the lifecycle is not.
// The mock Agent schedule surface records calls instead of running
// Durable Object alarms.
vi.mock("@cloudflare/think", () => ({
  Think: class MockThink {
    ctx: any;
    env: any;
    maxSteps = 0;
    __turnConfig: any = undefined;
    __stubReply = "Stub assistant reply.";
    __failTurn = false;
    __scheduled: Array<unknown[]> = [];
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async schedule(...args: unknown[]) {
      this.__scheduled.push(args);
      return { id: "schedule-1" };
    }
    async scheduleEvery(..._args: unknown[]) {
      return { id: "schedule-every-1" };
    }
    async cancelSchedule(..._args: unknown[]) {
      return true;
    }
    async listSchedules() {
      return [];
    }
    async runTurn(_opts: unknown) {
      const self = this as any;
      if (typeof self.beforeTurn === "function") {
        self.__turnConfig = await self.beforeTurn({
          system: "",
          messages: [],
          tools: {},
          model: {},
          continuation: false,
        });
      }
      if (self.__failTurn) throw new Error("stub provider failure");
      return {
        message: {
          id: "assistant-msg-1",
          role: "assistant",
          parts: [{ type: "text", text: self.__stubReply }],
        },
        continuation: false,
      };
    }
  },
}));

// judge.evaluate / judge.route's model arm must stay hermetic: the
// golden corpus never leaves the deterministic fast-path, and
// evaluate lands on its documented default when the model throws.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(async () => {
      throw new Error("generateText disabled in lifecycle tests");
    }),
  };
});

import { OrchestratorThinkAgent } from "../src/agents/orchestrator-think";
import { LLMJudge } from "../src/agents/judge";
import {
  buildOrchestratorSystemPrompt,
  resolveMasMaxSteps,
} from "../src/agents/chatPrompt";
import { buildChatErrorFallback } from "../src/agents/chatErrorFallback";
import { resolveAiModelName } from "../src/agents/model";
import { MockSqlStorage } from "./mock-sql";
import judgeGolden from "./fixtures/judge-golden.json";

/**
 * Issue #669 (Think migration step 3b) — shadow turn lifecycle parity.
 *
 * R1: route parity, fixture-for-fixture over the judge golden corpus
 * (tests/fixtures/judge-golden.json — every entry is decided by the
 * deterministic fast-path inside LLMJudge.route, so the comparison is
 * hermetic) plus the synthetic auto-research route.
 * R2: the driver returns the route adapter's turn shape.
 * R3: side-effect parity — the mas_messages rows and mas_events audit
 * events the live turn writes (recordMessage in onChatMessage +
 * onFinish; route.decided / response.evaluated audits), asserted
 * against the shadow's own store after equivalent turns.
 * R4: bounds — live clamp vs the shadow's applied TurnConfig.maxSteps
 * per env variant, plus prompt byte-identity per fixture.
 * R5: the error path uses the shared buildChatErrorFallback
 * extraction; a failing turn produces the deterministic fallback.
 */

// MockSqlStorage returns plain arrays from exec(); the live executor's
// claim gate reads rowsWritten off the cursor. This subclass reports
// it for the claim UPDATE by observing the post-update row state.
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

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function makeShadow(env: Record<string, unknown> = { AI: {} }) {
  const sql = new ClaimAwareSql();
  const ctx = {
    id: { toString: () => "shadow-session-1" },
    storage: { sql },
  };
  const agent = new OrchestratorThinkAgent(ctx as never, env as never) as any;
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

describe("#669 R1 — route parity, fixture-for-fixture", () => {
  it("shadow route equals the live judge's route for every golden entry", async () => {
    const failures: string[] = [];
    for (const entry of GOLDEN) {
      const recent = (entry.recentMessages ?? []) as Array<{ role?: string; content: string }>;
      const live = await new LLMJudge({} as never).route(entry.text, recent);
      const { agent } = makeShadow();
      const out = await agent.runShadowChatTurn({
        userText: entry.text,
        recentTurns: recent,
        userLogin: "parity-tester",
        isAutoOptionsResearchRequest: false,
      });
      const r = out.route;
      if (
        r.agent !== live.agent ||
        r.confidence !== live.confidence ||
        r.reason !== live.reason ||
        r.needsConfirmation !== live.needsConfirmation
      ) {
        failures.push(
          `${entry.id}: shadow ${JSON.stringify(r)} != live ${JSON.stringify(live)}`
        );
      }
      if (r.agent !== entry.expectedIntent) {
        failures.push(`${entry.id}: agent ${r.agent} != golden ${entry.expectedIntent}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("synthetic auto-research route + NLQ pre-dispatch + tool suppression", async () => {
    const { agent, sql } = makeShadow();
    const out = await agent.runShadowChatTurn({
      userText: "scan for oversold large caps",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: true,
      sourceTab: "E*TRADE · Auto Options Research",
    });
    expect(out.route).toEqual({
      agent: "trading",
      confidence: 1,
      reason:
        "Source-tagged Auto Options Research request; executing its options NLQ workflow directly",
      needsConfirmation: false,
    });

    const jobs = Array.from(
      sql.exec("SELECT capability, status FROM mas_async_jobs")
    ) as Array<{ capability: string; status: string }>;
    expect(jobs).toEqual([{ capability: "nlq.execute", status: "queued" }]);

    const events = readEvents(sql);
    const executed = events.find((e) => e.type === "options_research.chat_query_executed");
    expect(executed?.agent).toBe("nlq");
    expect(executed?.payload.query).toBe("scan for oversold large caps");
    expect(executed?.payload.status).toBe("queued");

    // TurnConfig: tools suppressed (activeTools empty), prompt carries
    // the submitted-job context block.
    expect(agent.__turnConfig.activeTools).toEqual([]);
    expect(agent.__turnConfig.instructions).toContain("AUTO_OPTIONS_RESEARCH_JOB_SUBMITTED:");
  });
});

describe("#669 R2 — turn shape parity with the route adapter", () => {
  it("driver returns {reply, route{...}, model, streaming:false}", async () => {
    const env = { AI: {} };
    const { agent } = makeShadow(env);
    const out = await agent.runShadowChatTurn({
      userText: "hello there",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(Object.keys(out).sort()).toEqual(["model", "reply", "route", "streaming"]);
    expect(Object.keys(out.route).sort()).toEqual([
      "agent",
      "confidence",
      "needsConfirmation",
      "reason",
    ]);
    expect(out.reply).toBe("Stub assistant reply.");
    expect(out.model).toBe(resolveAiModelName(env as never));
    expect(out.streaming).toBe(false);
  });
});

describe("#669 R3 — side-effect parity (mas_messages + audit events)", () => {
  it("a completed turn writes the live turn's rows and audits", async () => {
    const { agent, sql } = makeShadow();
    const out = await agent.runShadowChatTurn({
      userText: "remember that my risk tolerance is conservative",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: false,
    });

    const messages = readMessages(sql);
    expect(messages).toEqual([
      {
        role: "user",
        content: "remember that my risk tolerance is conservative",
        agent: "orchestrator",
      },
      { role: "assistant", content: "Stub assistant reply.", agent: out.route.agent },
    ]);

    const events = readEvents(sql);
    const decided = events.find((e) => e.type === "route.decided");
    expect(decided?.agent).toBe("judge");
    expect(decided?.payload).toEqual({
      route: out.route.agent,
      confidence: out.route.confidence,
      reason: out.route.reason,
      needsConfirmation: out.route.needsConfirmation,
    });

    // judge.evaluate lands on its documented default under the stubbed
    // model boundary (score 75, grounded/safe, skip issue) — the same
    // default the live turn audits when the judge is unavailable.
    const evaluated = events.find((e) => e.type === "response.evaluated");
    expect(evaluated?.agent).toBe("judge");
    expect(evaluated?.payload).toEqual({
      score: 75,
      grounded: true,
      safe: true,
      issues: ["Automated evaluation skipped due to judge timeout or rate limit"],
    });
  });
});

describe("#669 R4 — bounds: equivalent or tighter, never averaged", () => {
  it("applied TurnConfig.maxSteps equals the live clamp for numeric env", async () => {
    for (const env of [{ AI: {} }, { AI: {}, MAS_MAX_STEPS: "3" }, { AI: {}, MAS_MAX_STEPS: "99" }, { AI: {}, MAS_MAX_STEPS: "0" }]) {
      const { agent } = makeShadow(env);
      await agent.runShadowChatTurn({
        userText: "hello there",
        recentTurns: [],
        userLogin: "parity-tester",
        isAutoOptionsResearchRequest: false,
      });
      expect(agent.__turnConfig.maxSteps).toBe(resolveMasMaxSteps(env as never));
    }
  });

  it("the one enumerated difference: non-numeric MAS_MAX_STEPS (live NaN, shadow 6)", async () => {
    const env = { AI: {}, MAS_MAX_STEPS: "abc" };
    expect(Number.isNaN(resolveMasMaxSteps(env as never))).toBe(true);
    const { agent } = makeShadow(env);
    await agent.runShadowChatTurn({
      userText: "hello there",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(agent.__turnConfig.maxSteps).toBe(6);
  });

  it("prompt byte-identity per fixture (same builder, same grounding inputs)", async () => {
    const { agent } = makeShadow();
    const out = await agent.runShadowChatTurn({
      userText: "hello there",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(agent.__turnConfig.instructions).toBe(
      buildOrchestratorSystemPrompt({
        route: out.route,
        memoryContext: "",
        vectorContext: "",
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    );
  });

  it("grounded prompt: seeded session memory flows into the turn prompt identically", async () => {
    const { agent, sql } = makeShadow();
    sql.exec(
      "INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?)",
      "risk",
      "conservative",
      "2026-10-20T00:00:00.000Z"
    );
    const out = await agent.runShadowChatTurn({
      userText: "hello there",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: false,
    });
    const { memoryContext, vectorContext } = await agent.assembleGrounding("hello there");
    expect(agent.__turnConfig.instructions).toBe(
      buildOrchestratorSystemPrompt({
        route: out.route,
        memoryContext,
        vectorContext,
        optionsResearchContext: "",
        isAutoOptionsResearchRequest: false,
      })
    );
  });
});

describe("#669 R5 — error path: shared fallback extraction", () => {
  it("the fallback lives in one shared module consumed by both classes", () => {
    const orch = read("src/agents/orchestrator.ts");
    expect(orch).toContain('from "./chatErrorFallback"');
    expect(orch).toContain("buildChatErrorFallback(this.chatErrorFallbackContext()");
    const shadow = read("src/agents/orchestrator-think.ts");
    expect(shadow).toContain('from "./chatErrorFallback"');
    expect(typeof buildChatErrorFallback).toBe("function");
  });

  it("a failing turn produces the deterministic fallback and records it", async () => {
    const { agent, sql } = makeShadow();
    agent.__failTurn = true;
    const out = await agent.runShadowChatTurn({
      userText: "",
      recentTurns: [],
      userLogin: "parity-tester",
      isAutoOptionsResearchRequest: false,
    });
    expect(out.reply).toContain("**Diagnosis:**");
    expect(out.streaming).toBe(false);
    const messages = readMessages(sql);
    expect(messages).toEqual([
      { role: "assistant", content: out.reply, agent: "orchestrator" },
    ]);
  });
});

describe("#669 submitJob wiring — the shadow has an execution path", () => {
  it("tool context now carries submitJob; submit + execute a task.draft job end-to-end", async () => {
    const { agent, sql } = makeShadow();
    const context = agent.toolContext();
    expect(typeof context.submitJob).toBe("function");

    const submitted = await agent.submitAsyncJob({
      capability: "task.draft",
      payload: { title: "Follow up" },
    });
    expect(submitted.status).toBe("queued");
    expect(submitted.statusUrl).toBe(`/api/jobs/${submitted.jobId}`);
    expect(agent.__scheduled.some((a: unknown[]) => a[1] === "executeAsyncJob")).toBe(true);

    let rows = Array.from(sql.exec("SELECT status FROM mas_async_jobs")) as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "queued" }]);
    expect(readEvents(sql).some((e) => e.type === "async_job.queued")).toBe(true);

    await agent.executeAsyncJob({ jobId: submitted.jobId });
    rows = Array.from(sql.exec("SELECT status FROM mas_async_jobs")) as Array<{ status: string }>;
    expect(rows).toEqual([{ status: "completed" }]);
    const job = agent.getAsyncJob(submitted.jobId);
    expect((job?.result as { status?: string })?.status).toBe("draft");
    expect(readEvents(sql).some((e) => e.type === "async_job.completed")).toBe(true);
  });

  it("http.request jobs fail explicitly in the shadow (routed surface is step 4)", async () => {
    const { agent, sql } = makeShadow();
    const submitted = await agent.submitAsyncJob({
      capability: "http.request",
      payload: { pathAndQuery: "/api/chat", method: "POST", headers: {}, body: "{}" },
    });
    await agent.executeAsyncJob({ jobId: submitted.jobId });
    const rows = Array.from(sql.exec("SELECT status, error FROM mas_async_jobs")) as Array<{
      status: string;
      error: string;
    }>;
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toContain("step 4");
  });
});

describe("#669 beforeTurn without a driver stash (framework-driven turn)", () => {
  it("derives the turn from ctx.messages and still returns a full TurnConfig", async () => {
    const { agent } = makeShadow();
    const config = await agent.beforeTurn({
      system: "",
      messages: [{ role: "user", content: "hello there" }],
      tools: {},
      model: {},
      continuation: false,
    });
    expect(config.maxSteps).toBe(6);
    expect(config.instructions).toContain("You are the master orchestrator");
  });
});
