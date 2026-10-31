/**
 * Issue #1523 ([AGENTIC] Lane 2, follow-up of #1362/#1517) — real
 * chain.run executor.
 *
 * The executor maps compiled chain legs onto the #1355 shard
 * dispatch: feed/generate/store legs run through the shard runner
 * (real `executeShardJob` in production, a fake runner here), serve
 * legs submit to the async-job rails through a caller-supplied
 * submitter port, and legs with no mapping report their real reason
 * as `unimplemented` — never a fabricated success. Tests use a fake
 * shard runner + fake sql only; no broker, no live scheduler, no
 * queued job is created (the overlay keeps completed shards
 * in-memory, so the fake sql never sees an INSERT).
 */
import { describe, it, expect } from "vitest";

import {
  compileChain,
  compileGoal,
  type CompiledChain,
} from "../src/orchestrate";
import { runChain } from "../src/mcps/openaimp/goalChainCommands";
import {
  createChainLegExecutor,
  isSubmittedLeg,
  LegNotExecutableError,
  type ChainExecutionContext,
  type ChainRuntime,
} from "../src/agentic/chainExecutor";
import { chainRowsFromSql } from "../src/services/shardJobs";

const CHAIN_ID = "chain-exec-test";
const SESSION_ID = "test-session";

function makeRuntime(): { runtime: ChainRuntime; sqlCalls: string[] } {
  const sqlCalls: string[] = [];
  const sql = {
    exec: (query: string, ..._params: unknown[]) => {
      sqlCalls.push(query);
      // Base sql holds no chain rows: every sibling the executor
      // sees must come from its in-memory overlay.
      return [] as Record<string, unknown>[];
    },
  };
  const runtime: ChainRuntime = {
    sql: sql as any,
    env: {},
    orm: {},
    storage: {},
    createETradeService: () => ({}) as any,
    sessionId: SESSION_ID,
  };
  return { runtime, sqlCalls };
}

function makeCtx(over: Partial<ChainExecutionContext> = {}): ChainExecutionContext {
  return {
    chainId: CHAIN_ID,
    userLogin: "test-login",
    universe: "NASDAQ100",
    chainVersion: 1,
    trigger: "manual",
    ...over,
  };
}

interface RunnerCall {
  stage: string;
  key: string;
}

/**
 * Fake shard runner: records dispatch order and proves the overlay
 * works by reading siblings through the deps sql it is handed
 * (the real `chainRowsFromSql`, exactly as `executeShardJob` does).
 * Feed shards return canned datasets; generate/store return canned
 * artifacts keyed by format.
 */
function makeFakeRunner() {
  const calls: RunnerCall[] = [];
  const runner = async (deps: any, payload: any) => {
    const { stage, key } = payload.shard;
    calls.push({ stage, key });
    const rows = chainRowsFromSql(deps.sql, CHAIN_ID, SESSION_ID);
    if (stage === "feed" && key === "etrade") {
      const nasdaq = rows.find(
        (r) => r.stage === "feed" && r.shardKey === "nasdaq" && r.status === "completed",
      );
      if (!nasdaq) throw new Error("etrade shard saw no completed nasdaq sibling row");
      return { quotes: [{ symbol: "AAPL" }] };
    }
    if (stage === "feed" && key === "yahoo") {
      const nasdaq = rows.some(
        (r) => r.stage === "feed" && r.shardKey === "nasdaq" && r.status === "completed",
      );
      const etrade = rows.some(
        (r) => r.stage === "feed" && r.shardKey === "etrade" && r.status === "completed",
      );
      if (!nasdaq || !etrade) throw new Error("yahoo shard saw incomplete feed siblings");
      // Issue #2144: the Yahoo shard returns technicals only — no
      // gap-fill rows, even in the mock.
      return { technicals: [] };
    }
    if (stage === "feed") return { listings: [{ symbol: "AAPL" }] };
    if (stage === "generate" && key === "assemble") {
      return { opportunities: [], allStocks: [], totalScanned: 1, matchedCount: 0, universe: "NASDAQ100", timestamp: "2026-10-25T00:00:00.000Z", provider: "sharded" };
    }
    if (stage === "generate") {
      return { format: key, key: `screener:${key}:abc123`, fileName: `report.${key}` };
    }
    if (stage === "store") {
      const inputs = payload.inputs ?? {};
      return { format: inputs.format, key: inputs.key, reportId: `screener:${CHAIN_ID}:${inputs.format}` };
    }
    throw new Error(`fake runner: unsupported shard ${stage}/${key}`);
  };
  return { calls, runner };
}

function nasdaqChain(): CompiledChain {
  const chain = compileGoal("Create a NASDAQ100 screen and send it to Slack", {
    budgetCents: 5000,
    budgetCapCents: 10000,
  });
  if (!chain) throw new Error("test chain did not compile");
  return chain;
}

describe("chain executor mapping (#1523)", () => {
  it("runs feed shards once in dependency order, deduped across both feed legs, with sibling overlay", async () => {
    const { runtime } = makeRuntime();
    const { calls, runner } = makeFakeRunner();
    const executeLeg = createChainLegExecutor(runtime, makeCtx(), { shardRunner: runner as any });
    const out = await runChain(nasdaqChain(), { executeLeg, budgetCheck: async () => true });
    expect(calls.map((c) => `${c.stage}/${c.key}`)).toEqual([
      "feed/nasdaq",
      "feed/etrade",
      "feed/yahoo",
      "generate/assemble",
      "generate/pdf",
      "generate/xlsx",
      "store/pdf",
      "store/xlsx",
    ]);
    const feedLegs = out.legs.filter((l) => l.stage === "feed");
    expect(feedLegs).toHaveLength(2);
    for (const leg of feedLegs) {
      expect(leg.status).toBe("completed");
      const result = leg.result as any;
      expect(result.chainId).toBe(CHAIN_ID);
      expect(result.chainVersion).toBe(1);
      expect(result.capabilityVersion.id).toBe(leg.capabilityId);
      expect(result.capabilityVersion.status).toBe("shipped");
      expect(result.shardJobIds).toHaveLength(3);
    }
    // Both feed legs report the SAME shard ids (one stage run, not two).
    expect((feedLegs[0].result as any).shardJobIds).toEqual(
      (feedLegs[1].result as any).shardJobIds,
    );
    // Serve + deliver have no inline path here: honest unimplemented.
    const serve = out.legs.find((l) => l.stage === "serve")!;
    expect(serve.status).toBe("unimplemented");
    expect(serve.detail).toMatch(/followup\.report/);
    const deliver = out.legs.find((l) => l.stage === "deliver")!;
    expect(deliver.status).toBe("unimplemented");
    expect(deliver.detail).toMatch(/completion hook/);
    expect(out.ok).toBe(true);
    expect(out.ranAnything).toBe(true);
  });

  it("refuses assembly on a partial feed, naming the blockers, and skips later legs", async () => {
    const { runtime } = makeRuntime();
    const { calls, runner } = makeFakeRunner();
    const chain = compileChain({
      goal: "Generate only",
      steps: [{ capabilityId: "generate-screener-pdf" }],
      budgetCents: 0,
      recurrence: "one-shot",
    });
    if (!chain) throw new Error("generate-only chain did not compile");
    const executeLeg = createChainLegExecutor(runtime, makeCtx(), { shardRunner: runner as any });
    const out = await runChain(chain, { executeLeg });
    expect(out.legs[0].status).toBe("failed");
    expect(out.legs[0].detail).toMatch(/nasdaq/);
    expect(out.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports a capability with no shard mapping as unimplemented with its real reason, without failing the run", async () => {
    const { runtime } = makeRuntime();
    const { runner } = makeFakeRunner();
    const chain = compileChain({
      goal: "Options generate",
      steps: [{ capabilityId: "generate-options-pdf" }],
      budgetCents: 0,
      recurrence: "one-shot",
    });
    if (!chain) throw new Error("options chain did not compile");
    const executeLeg = createChainLegExecutor(runtime, makeCtx(), { shardRunner: runner as any });
    const out = await runChain(chain, { executeLeg });
    expect(out.legs[0].status).toBe("unimplemented");
    expect(out.legs[0].detail).toMatch(/no .* shard/i);
    expect(out.ok).toBe(true);
    expect(out.ranAnything).toBe(false);
    // The typed error itself carries the capability + reason.
    const direct = createChainLegExecutor(runtime, makeCtx(), { shardRunner: runner as any });
    await expect(direct(chain.steps[0])).rejects.toBeInstanceOf(LegNotExecutableError);
  });

  it("submits a serve leg through the submitter port and keeps running later legs", async () => {
    const { runtime } = makeRuntime();
    const { runner } = makeFakeRunner();
    const submitted: any[] = [];
    const executeLeg = createChainLegExecutor(runtime, makeCtx(), {
      shardRunner: runner as any,
      submitJob: async (spec: any) => {
        submitted.push(spec);
        return { jobId: "job_serve_1" };
      },
    });
    const chain = compileChain({
      goal: "Serve then deliver",
      steps: [
        { capabilityId: "serve-report-pdf" },
        { capabilityId: "deliver-slack" },
      ],
      budgetCents: 0,
      recurrence: "one-shot",
      reusesStoredReport: true,
    });
    if (!chain) throw new Error("serve chain did not compile");
    const out = await runChain(chain, { executeLeg });
    expect(out.legs[0].status).toBe("submitted");
    expect((out.legs[0].result as any).jobId).toBe("job_serve_1");
    expect(isSubmittedLeg((out.legs[0] as any).result)).toBe(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].capability).toBe("followup.report");
    expect(out.legs[1].status).toBe("unimplemented");
    expect(out.submittedAnything).toBe(true);
    expect(out.ok).toBe(true);
  });

  it("validation-first refusal still runs nothing, and a budget block still skips everything", async () => {
    const { runtime } = makeRuntime();
    const { calls, runner } = makeFakeRunner();
    const executeLeg = createChainLegExecutor(runtime, makeCtx(), { shardRunner: runner as any });
    const bad = {
      ...(nasdaqChain() as any),
      steps: [{ capabilityId: "feed-dataprovider-news", args: {} }],
    };
    await expect(runChain(bad as any, { executeLeg })).rejects.toThrow(/re-validation/);
    expect(calls).toEqual([]);
    const blocked = await runChain(nasdaqChain(), {
      executeLeg,
      budgetCheck: async () => false,
    });
    expect(blocked.legs[0].status).toBe("blocked");
    expect(blocked.legs.slice(1).every((l) => l.status === "skipped")).toBe(true);
    expect(calls).toEqual([]);
  });
});
