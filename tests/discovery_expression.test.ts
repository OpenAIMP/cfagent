import { describe, expect, it } from "vitest";

import {
  getDiscoveryConfig,
  getOpportunityScannerConfig,
} from "../src/config/etapiConfig";
import type { YahooDailyBar } from "../src/trading/yahooHistory";
import {
  characterizeName,
  type NameCharacterization,
} from "../src/trading/options/discoverySignals";
import type { InferredThesis } from "../src/trading/options/discoveryInference";
import {
  buildDiscoveryRequest,
  expressDiscoverySetup,
  resolveDiscoveryFitGate,
  rollupBestPerType,
  type DiscoveryRiskCaps,
} from "../src/trading/options/discoveryExpression";
import type { PipelineResult } from "../src/trading/options/index";
import type {
  BestTradePick,
  RankedStrategy,
} from "../src/trading/options/recommendationAgent";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";

/**
 * Issue #14 slice 3 — expression: inference -> StrategyRequest ->
 * pipeline -> fit gate + best-per-type roll-up.
 *
 * The request builder mirrors the profile-derivation honesty rules
 * (#533): the target is spot x (1 + multiple x EM) with the EM from
 * the name's own chain; a missing EM or a non-positive target
 * abstains, and risk caps are always caller-supplied, never invented.
 * The pipeline is stubbed with canned results — the logic under test
 * is the builder, the gate composition, and the roll-up.
 */

const DCFG = getDiscoveryConfig();
const SCFG = getOpportunityScannerConfig();
const CAPS: DiscoveryRiskCaps = { maxPlannedLoss: 500, minRewardRisk: 1.5 };

function characterizationAt(spot: number): NameCharacterization {
  const bars: YahooDailyBar[] = Array.from({ length: 60 }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    open: spot,
    high: spot * 1.005,
    low: spot * 0.995,
    close: spot,
    volume: 1_000_000,
  }));
  return characterizeName({ symbol: "ACME", bars, ivStats: null, chain: null }, DCFG);
}

function inference(overrides: Partial<InferredThesis>): InferredThesis {
  return {
    inferred: true,
    ruleId: "trend-up",
    thesis: "bullish",
    targetEmMultiple: 0.6,
    expectedIvDirection: "unchanged",
    dteWindow: { minDte: 21, maxDte: 60 },
    confidence: "MEDIUM",
    firedSignals: ["TREND_UP", "LIQUIDITY_OK"],
    rationale: "fixture",
    ...overrides,
  };
}

const EM = { pct: 0.086, atmIv: 0.3, windowExpiry: "2026-11-20", windowDays: 30 };

describe("buildDiscoveryRequest", () => {
  it("builds a bullish request with the EM-unit target and inference fields", () => {
    const r = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: EM,
      caps: CAPS,
    });
    expect(r.built).toBe(true);
    if (!r.built) return;
    expect(r.request.symbol).toBe("ACME");
    expect(r.request.thesis).toBe("bullish");
    expect(r.request.targetPrice).toBe(105.16);
    expect(r.request.targetDate).toBe("2026-11-20");
    expect(r.request.minDte).toBe(21);
    expect(r.request.maxDte).toBe(60);
    expect(r.request.maxPlannedLoss).toBe(500);
    expect(r.request.minRewardRisk).toBe(1.5);
    expect(r.request.allowedStrategies).toEqual(["all"]);
  });

  it("range_bound targets the spot itself (multiple 0)", () => {
    const r = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({ thesis: "range_bound", targetEmMultiple: 0, ruleId: "range-pinned", dteWindow: { minDte: 30, maxDte: 60 } }),
      expectedMove: EM,
      caps: CAPS,
    });
    expect(r.built).toBe(true);
    if (!r.built) return;
    expect(r.request.targetPrice).toBe(100);
  });

  it("bearish targets below spot", () => {
    const r = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({ thesis: "bearish", targetEmMultiple: -0.6, ruleId: "trend-down" }),
      expectedMove: EM,
      caps: CAPS,
    });
    expect(r.built).toBe(true);
    if (!r.built) return;
    expect(r.request.targetPrice).toBe(94.84);
  });

  it("abstains when no expected move can be derived", () => {
    const r = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: null,
      caps: CAPS,
    });
    expect(r.built).toBe(false);
    if (r.built) return;
    expect(r.reason.toLowerCase()).toContain("expected move");
  });

  it("abstains when the computed target is not positive", () => {
    const r = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({ thesis: "bearish", targetEmMultiple: -0.6, ruleId: "trend-down" }),
      expectedMove: { ...EM, pct: 2.0 },
      caps: CAPS,
    });
    expect(r.built).toBe(false);
  });

  it("passes an event policy through from the caps, and omits it otherwise", () => {
    const withPolicy = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: EM,
      caps: { ...CAPS, eventPolicy: "exclude" },
    });
    expect(withPolicy.built).toBe(true);
    if (withPolicy.built) expect(withPolicy.request.eventPolicy).toBe("exclude");
    const without = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: EM,
      caps: CAPS,
    });
    expect(without.built).toBe(true);
    if (without.built) expect(without.request.eventPolicy).toBeUndefined();
  });
});

describe("resolveDiscoveryFitGate", () => {
  it("uses the discovery composite floor (spec: 50) over the scanner gate", () => {
    expect(DCFG.compositeFloor).toBe(50);
    const gate = resolveDiscoveryFitGate(SCFG, DCFG);
    expect(gate.minCompositeScore).toBe(50);
    expect(gate.minProbabilityOfProfit).toBe(SCFG.fitGate.minProbabilityOfProfit);
    expect(gate.requireFresh).toBe(SCFG.fitGate.requireFresh);
    expect(gate.minConfidence).toBe(SCFG.fitGate.minConfidence);
  });
});

function rankedFixture(type: string, compositeScore: number, id: string): RankedStrategy {
  const candidate = {
    id,
    type,
    label: `${type} ${id}`,
    symbol: "ACME",
    expirationDate: "2026-11-20",
    dataFreshness: "FRESH",
    modelImpliedProbabilityOfProfit: 0.42,
  } as unknown as StrategyCandidate;
  return {
    candidate,
    rank: 0,
    compositeScore,
    components: { engineScore: 0, probability: 0, rewardRisk: 0, capitalSafety: 0, liquidity: 0 },
  };
}

function pickFixture(best: RankedStrategy | undefined, overrides: Partial<BestTradePick> = {}): BestTradePick {
  return {
    status: best ? "recommended" : "no_trade",
    riskProfile: "balanced",
    confidence: "MEDIUM",
    best,
    alternatives: [],
    rationale: best ? [] : ["No qualifying strategy"],
    blockers: [],
    humanApprovalRequired: true,
    disclaimer: "fixture",
    ...overrides,
  };
}

function pipelineResult(ranked: RankedStrategy[], pick: BestTradePick): PipelineResult {
  return {
    snapshot: {},
    strategies: {},
    screenedOut: [],
    ranked,
    riskReports: [],
    bestTrade: pick,
  } as unknown as PipelineResult;
}

describe("rollupBestPerType", () => {
  it("keeps the highest-composite candidate per strategy type, sorted desc", () => {
    const rollup = rollupBestPerType([
      rankedFixture("bull_call_spread", 61, "a"),
      rankedFixture("long_call", 72, "b"),
      rankedFixture("bull_call_spread", 78, "c"),
      rankedFixture("iron_condor", 55, "d"),
    ]);
    expect(rollup.map((r) => [r.type, r.candidateId, r.compositeScore])).toEqual([
      ["bull_call_spread", "c", 78],
      ["long_call", "b", 72],
      ["iron_condor", "d", 55],
    ]);
  });

  it("is empty when nothing ranked", () => {
    expect(rollupBestPerType([])).toEqual([]);
  });
});

describe("expressDiscoverySetup", () => {
  it("runs the pipeline, passes a clearing pick at the discovery floor, and rolls up", async () => {
    const ranked = [rankedFixture("long_call", 72, "b"), rankedFixture("bull_call_spread", 78, "c")];
    const pick = pickFixture(rankedFixture("long_call", 52, "best"));
    const pipeline = { run: async () => pipelineResult(ranked, pick) };
    const built = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: EM,
      caps: CAPS,
    });
    expect(built.built).toBe(true);
    if (!built.built) return;
    const expr = await expressDiscoverySetup(pipeline, built.request, resolveDiscoveryFitGate(SCFG, DCFG));
    // Composite 52 clears the discovery floor 50 (it would fail the
    // scanner's stricter 55) — this is the floor the spec settles.
    expect(expr.gate.bucket).toBe("fit");
    expect(expr.rollup).toHaveLength(2);
    expect(expr.rankedCount).toBe(2);
    expect(expr.request).toBe(built.request);
  });

  it("marks a sub-floor pick borderline with the composite reason", async () => {
    const pick = pickFixture(rankedFixture("long_call", 44, "weak"));
    const pipeline = { run: async () => pipelineResult([], pick) };
    const built = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: EM,
      caps: CAPS,
    });
    if (!built.built) throw new Error("expected build");
    const expr = await expressDiscoverySetup(pipeline, built.request, resolveDiscoveryFitGate(SCFG, DCFG));
    expect(expr.gate.bucket).toBe("borderline");
    expect(expr.gate.reasons.join(" ")).toContain("composite");
  });

  it("reports no_fit when the pipeline finds no trade", async () => {
    const pipeline = { run: async () => pipelineResult([], pickFixture(undefined)) };
    const built = buildDiscoveryRequest({
      characterization: characterizationAt(100),
      inference: inference({}),
      expectedMove: EM,
      caps: CAPS,
    });
    if (!built.built) throw new Error("expected build");
    const expr = await expressDiscoverySetup(pipeline, built.request, resolveDiscoveryFitGate(SCFG, DCFG));
    expect(expr.gate.bucket).toBe("no_fit");
    expect(expr.rollup).toEqual([]);
  });
});
