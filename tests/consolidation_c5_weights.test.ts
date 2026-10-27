/**
 * Issue #1361 (epic #1151 slice C5) + #1257 weights unification.
 *
 * - v2 helpers: per-regime read (for the reselection tick) and the
 *   regime-collapsed aggregate (for regime-blind consumers: the GET
 *   evaluation and the candidate replay). The collapse rule is the
 *   mean across the strategy's regimes, documented, deterministic.
 * - Reselection on v2-for-regime weights: the informational weight on
 *   a proposal entry is the run regime's v2 value, not another
 *   regime's, and the proposal shape is unchanged.
 * - /adaptation/weights + /adaptation/weights/run + the candidate
 *   evaluation weights read on v2 ALWAYS (#1257 flip): the
 *   screening.adaptationWeightsV2Routes flag is retired — v1 rows
 *   present in the store are ignored by these routes, and the legacy
 *   flag setting is a no-op. The v1 module itself was deleted by
 *   the retirement PR (#1257).
 * - NOTE (#1257 challenger re-point): the counterfactual-replay
 *   POST /adaptation/candidates/evaluate route this file once pinned
 *   is retired — evaluation is now frozen-set challenger evaluation
 *   (see tests/adaptation_challenger_routes.test.ts). The replay
 *   helpers lived in candidateEvaluation.ts until the retirement PR
 *   (#1257) deleted it.
 */
import { describe, it, expect, vi } from "vitest";
import {
  handleScreenerResearchRoutes,
  type ScreenerResearchRouteContext,
} from "../src/agents/routes/screenerResearch";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import {
  getStrategyWeightsV2Collapsed,
  getStrategyWeightsV2ForRegime,
} from "../src/services/strategyWeightsV2";
import { reselectStrategyBank, buildStrategyRegimeEvidence } from "../src/services/strategyBankReselection";

const NOW = new Date("2026-10-24T12:00:00.000Z");

function seedV2(sql: MockSqlStorage) {
  // MockSqlStorage's INSERT dedupes on the first column (a
  // single-column-PK approximation), while real SQLite enforces the
  // composite (strategy, regime) PK of mas_strategy_weights_v2 — so
  // multi-regime rows for one strategy cannot be seeded through the
  // module's INSERT path in this mock. Rows are written directly to
  // the mock's table (CREATE TABLE is a no-op there, so the helpers'
  // ensure call does not wipe them). The helpers under test read via
  // SELECT, which the mock handles faithfully.
  const tables = (sql as any).tables as Map<string, Array<Record<string, any>>>;
  tables.set("mas_strategy_weights_v2", [
    { strategy: "strat-a", regime: "bull", weight: 1.2, version: 1, updated_at: NOW.toISOString() },
    { strategy: "strat-a", regime: "bear", weight: 1.6, version: 2, updated_at: NOW.toISOString() },
    { strategy: "strat-b", regime: "bull", weight: 2.0, version: 3, updated_at: NOW.toISOString() },
  ]);
}

function routeCtx() {
  const sql = new MockSqlStorage();
  const orm = new DatabaseORM(sql as any);
  const settings = new Map<string, string>();
  const track: any = {
    winRate: 0.5,
    byStrategy: [
      { key: "strat-a", winRate: 0.6, evaluated: 30 },
      { key: "strat-b", winRate: 0.4, evaluated: 10 },
    ],
    ideas: [],
  };
  const agent = {
    getTrackRecord: vi.fn(async () => track),
    getResearchConfig: vi.fn(async () => ({ feePerContract: 0.65, slippagePerContract: 0.02 })),
  };
  const ctx = {
    getScreenerAgent: vi.fn(() => null),
    getScreenerExecutionContext: vi.fn(async () => ({ userLogin: "alice" })),
    getResearchAgent: vi.fn(() => agent),
    runResearchAndPublish: vi.fn(async () => ({ success: true })),
    getOrm: vi.fn(() => orm),
    readSettingRaw: vi.fn((key: string) => settings.get(key) ?? null),
    writeSetting: vi.fn((key: string, value: string) => void settings.set(key, value)),
    env: {},
  } as unknown as ScreenerResearchRouteContext;
  return { ctx, orm, sql, settings, track, agent };
}

function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(ctx: ScreenerResearchRouteContext, method: string, path: string, body?: unknown) {
  const res = await handleScreenerResearchRoutes(req(method, path, body), new URL(`https://agent.internal${path}`), path.split("?")[0], "s1", ctx);
  return { res, data: await res.json() as any };
}

describe("v2 weight reads", () => {
  it("for-regime read returns plain strategy keys for exactly that regime", () => {
    const sql = new MockSqlStorage();
    seedV2(sql);
    expect(getStrategyWeightsV2ForRegime(sql as any, "bull")).toEqual({ "strat-a": 1.2, "strat-b": 2.0 });
    expect(getStrategyWeightsV2ForRegime(sql as any, "bear")).toEqual({ "strat-a": 1.6 });
    expect(getStrategyWeightsV2ForRegime(sql as any, "chop")).toEqual({});
  });

  it("collapsed read is the mean across the strategy's regimes", () => {
    const sql = new MockSqlStorage();
    seedV2(sql);
    const collapsed = getStrategyWeightsV2Collapsed(sql as any);
    expect(collapsed["strat-a"]).toBeCloseTo(1.4, 10);
    expect(collapsed["strat-b"]).toBe(2.0);
  });

  it("reselection on for-regime weights carries the run regime's value", () => {
    const sql = new MockSqlStorage();
    seedV2(sql);
    const evidence = buildStrategyRegimeEvidence(
      Array.from({ length: 12 }, () => ({
        structure: "strat-a", regime: "bull",
        evaluation: { pnlEstimatePerUnit: 10, rMultiple: 1, evaluatedAt: "2026-10-20T00:00:00.000Z" },
      })) as any,
    );
    const proposal = reselectStrategyBank({
      evidence,
      weights: getStrategyWeightsV2ForRegime(sql as any, "bull"),
      regime: "bull",
      overallWinRate: 0.5,
      now: NOW,
    });
    const entry = proposal.activeSet.find((e) => e.strategy === "strat-a");
    expect(entry?.weight).toBe(1.2);
    expect(proposal.governance).toBeDefined();
  });
});

describe("/adaptation/weights on v2 always (#1257 flip)", () => {
  it("v2 weights returned with no flag set", async () => {
    const { ctx, sql } = routeCtx();
    seedV2(sql);
    const { data } = await call(ctx, "GET", "/api/adaptation/weights");
    expect(data.weights["strat-a"]).toBeCloseTo(1.4, 10);
    expect(data.weights["strat-b"]).toBe(2.0);
    expect(data.weightsSource).toBe("v2");
    expect(data.weightsByRegime["strat-a|bull"]).toBe(1.2);
    expect(data.weightsByRegime["strat-a|bear"]).toBe(1.6);
    // (1.4*0.6*30 + 2.0*0.4*10) / (1.4*30 + 2.0*10) = 33.2/62
    expect(data.evaluation.weightedWinRate).toBeCloseTo(33.2 / 62, 10);
  });

  it("the legacy flag setting is ignored: same v2 response with the flag set", async () => {
    const { ctx, sql, settings } = routeCtx();
    seedV2(sql);
    settings.set("screening.adaptationWeightsV2Routes", "1");
    const { data } = await call(ctx, "GET", "/api/adaptation/weights");
    expect(data.weights["strat-a"]).toBeCloseTo(1.4, 10);
    expect(data.weightsSource).toBe("v2");
  });

  it("run: v2 adjustment result with weightsSource v2; second run in the same week skips", async () => {
    const { ctx } = routeCtx();
    const first = await call(ctx, "POST", "/api/adaptation/weights/run", {});
    expect(first.data.success).toBe(true);
    expect(first.data.weightsSource).toBe("v2");
    expect(typeof first.data.considered).toBe("number");
    expect(Array.isArray(first.data.adjusted)).toBe(true);
    expect(Array.isArray(first.data.blocked)).toBe(true);
    const second = await call(ctx, "POST", "/api/adaptation/weights/run", {});
    expect(second.data.skipped).toBe("already ran this week");
    const forced = await call(ctx, "POST", "/api/adaptation/weights/run", { force: true });
    expect(forced.data.skipped).toBeUndefined();
  });

});
