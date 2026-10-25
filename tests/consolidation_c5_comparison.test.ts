/**
 * Issue #1361 (epic #1151 slice C5) — 3-way comparison surfacing.
 *
 * - runProductionComparison runs llm/quant/hybrid over one snapshot
 *   with the panel gate chain; the artifact has no winner field.
 * - Hybrid confinement: the quant arm's order equals the panel
 *   ranking order (same builders + RiskProfileComposite); the LLM
 *   order appears ONLY in the hybrid arm (and the llm arm's own
 *   generation order) — production rankings never see it.
 * - The ledger read-back returns per-arm outcomes for a run id only.
 * - Generation mapping is verified against the snapshot: cited
 *   symbols absent from the snapshot are dropped (never invented),
 *   and prices always come from the snapshot contract, never the
 *   model's text.
 * - Empty snapshots skip both LLM calls and still produce an
 *   all-empty artifact.
 */
import { describe, it, expect, vi } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  buildComparisonPrompt,
  FixedCandidateBuilder,
  listComparisonOutcomes,
  mapGeneratedDetailsToResponse,
  runProductionComparison,
} from "../src/services/comparisonRunner";
import type { KernelSnapshot } from "../src/services/recommendationKernel";
import type { ScreenedOptionContractItem } from "../src/types";
import type { StrategyCandidate, StrategyLeg } from "../src/trading/options/strategyEngine";

function screened(symbol: string, optionType: "CALL" | "PUT", strike: number): ScreenedOptionContractItem {
  return {
    symbol, optionType, strikePrice: strike, bid: 2.0, ask: 2.4, lastPrice: 2.2,
    volume: 1000, openInterest: 5000, impliedVolatility: 0.3,
    underlyingSymbol: "XYZ", underlyingPrice: 200, daysToExpiration: 30,
    expirationDate: "2026-11-22", moneyness: "ATM", strikeDistancePct: 0,
    spreadPct: 0.08, technicalSignal: "", highlightReason: "",
  } as ScreenedOptionContractItem;
}

function snapshot(contracts: ScreenedOptionContractItem[]): KernelSnapshot {
  return {
    symbol: "XYZ", contracts, dataSource: "live", chainProvenance: "live",
    underlyingPrice: 200, screen: { underlyingsScanned: 1, contractsEvaluated: contracts.length, contractsMatched: contracts.length },
    rejections: [],
  } as KernelSnapshot;
}

function leg(partial: Partial<StrategyLeg>): StrategyLeg {
  return {
    symbol: "XYZ", optionType: "CALL", side: "BUY", quantity: 1, strike: 200,
    expirationDate: "2026-11-22", daysToExpiration: 30, entryPrice: 2, bid: 1.8, ask: 2.2,
    impliedVolatility: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.05,
    openInterest: 5_000, volume: 1_000, spreadPct: 0.08,
    quoteTimestamp: "2026-10-24T00:00:00.000Z", quoteFreshness: "FRESH", multiplier: 100,
    ...partial,
  };
}

function engineCandidate(id: string, structure: string, legs: StrategyLeg[]): StrategyCandidate {
  return {
    id, rank: 1, type: structure as any, label: `${id} label`, symbol: "XYZ",
    underlyingPrice: 200, expirationDate: "2026-11-22", dataFreshness: "FRESH",
    legs, netDebit: 2, estimatedFees: 2, maxProfit: null, maxProfitUnbounded: true, maxLoss: 200,
    breakevens: [203], targetPnl: 300, targetRewardRisk: 1, modelImpliedProbabilityOfProfit: 0.45,
    netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 },
    liquidityScore: 80, score: 70, scoreBreakdown: {} as any, payoffCurve: [], scenarios: [],
    explanations: [], warnings: [], assumptions: [],
  } as StrategyCandidate;
}

const REQUEST: any = {
  symbol: "XYZ", thesis: "bullish", targetPrice: 210, targetDate: "2026-11-22",
  expectedIvDirection: "unchanged", maxPlannedLoss: 500, minRewardRisk: 1,
};

function stubDeps(over: Record<string, unknown> = {}) {
  const snap = snapshot([screened("XYZ261122C200", "CALL", 200), screened("XYZ261122C210", "CALL", 210)]);
  const quant = [
    engineCandidate("cand-a", "bull_call_spread", [leg({}), leg({ side: "SELL", strike: 210, symbol: "XYZ261122C210" })]),
    engineCandidate("cand-b", "long_call", [leg({})]),
  ];
  return {
    snapshot: snap,
    request: REQUEST,
    question: "What bullish XYZ strategies look best?",
    riskProfile: "balanced" as const,
    buildFn: vi.fn(async () => ({ candidates: quant })),
    rankFn: vi.fn((candidates: StrategyCandidate[]) =>
      candidates.map((c, i) => ({ candidate: c, rank: i + 1, compositeScore: 100 - i * 10, components: {} as any }))),
    screenFn: vi.fn((candidates: StrategyCandidate[]) => ({ matched: candidates, rejected: [] })),
    env: {},
    ledgerSql: new MockSqlStorage() as any,
    generateDetailsFn: vi.fn(async () => ({
      answer: "a", contractSymbols: ["XYZ261122C200"],
      contractDetails: [{
        symbol: "XYZ261122C200", expiration: "2026-11-22",
        contract: { optionType: "CALL", strikePrice: 200, symbol: "XYZ261122C200", bid: 2.0, ask: 2.4, impliedVolatility: 0.3, volume: 1000, openInterest: 5000 },
      }],
    })),
    rankWithLlmFn: vi.fn(async () => ({ model: "stub", ranked: [{ candidateId: "cand-b" }, { candidateId: "cand-a" }] })),
    ...over,
  };
}

describe("comparison generation mapping (pure)", () => {
  it("maps cited symbols to snapshot contracts with snapshot prices; drops absent symbols", () => {
    const snap = snapshot([screened("XYZ261122C200", "CALL", 200)]);
    const out = mapGeneratedDetailsToResponse(
      { answer: "a", contractSymbols: ["XYZ261122C200", "FAKE123"] },
      snap,
    );
    expect(out.response.contractDetails).toHaveLength(1);
    expect(out.response.contractDetails![0]).toMatchObject({
      symbol: "XYZ261122C200", expiration: "2026-11-22",
      contract: { optionType: "CALL", strikePrice: 200, bid: 2.0, ask: 2.4 },
    });
    expect(out.droppedCount).toBe(1);
    expect(out.citedCount).toBe(2);
  });

  it("unparseable generation output yields zero details, not invented ones", () => {
    const out = mapGeneratedDetailsToResponse(null, snapshot([]));
    expect(out.response.contractDetails).toEqual([]);
    expect(out.droppedCount).toBe(0);
  });

  it("prompt includes the question and caps contracts at 200", () => {
    const contracts = Array.from({ length: 201 }, (_, i) => screened(`XYZ261122C${200 + i}`, "CALL", 200 + i));
    const prompt = buildComparisonPrompt("q?", snapshot(contracts));
    expect(prompt).toContain("q?");
    expect(prompt).toContain("XYZ261122C200");
    expect(prompt).not.toContain("XYZ261122C400");
  });
});

describe("FixedCandidateBuilder", () => {
  it("returns the pre-generated list unchanged", async () => {
    const b = new FixedCandidateBuilder([]);
    expect(b.id).toBe("fixed-candidates");
    expect(await b.build({ snapshot: snapshot([]), request: {} })).toEqual([]);
  });
});

describe("runProductionComparison", () => {
  it("runs three arms over the panel gates with no winner; hybrid order is LLM-only", async () => {
    const deps = stubDeps();
    const { artifact } = await runProductionComparison(deps as any);
    expect(JSON.stringify(artifact)).not.toContain('"winner"');
    expect(artifact.arms.quant.ranked.map((c) => c.id)).toEqual(["cand-a", "cand-b"]);
    expect(artifact.arms.hybrid.ranked.map((c) => c.id)).toEqual(["cand-b", "cand-a"]);
    expect(artifact.arms.llm.attrition.generated).toBe(1);
    expect(artifact.arms.llm.ranked[0].provenance).toBe("llm");
    expect(artifact.stats.armRankedCounts.quant).toBe(2);
  });

  it("writes per-arm ledger rows readable back by run id only", async () => {
    const deps = stubDeps();
    const { artifact } = await runProductionComparison(deps as any);
    const rows = listComparisonOutcomes(deps.ledgerSql, artifact.runId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.run_id === artifact.runId)).toBe(true);
    expect(new Set(rows.map((r) => r.arm))).toEqual(new Set(["llm", "quant", "hybrid"]));
    expect(listComparisonOutcomes(deps.ledgerSql, "no-such-run")).toEqual([]);
  });

  it("empty snapshots skip both LLM calls and produce all-empty arms", async () => {
    const deps = stubDeps({ snapshot: snapshot([]), buildFn: vi.fn(async () => ({ candidates: [] })) });
    const { artifact } = await runProductionComparison(deps as any);
    expect(deps.generateDetailsFn).not.toHaveBeenCalled();
    expect(deps.rankWithLlmFn).not.toHaveBeenCalled();
    expect(artifact.stats.armRankedCounts).toEqual({ llm: 0, quant: 0, hybrid: 0 });
  });
});
