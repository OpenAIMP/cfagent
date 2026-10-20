import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import {
  ALL_STRATEGY_TYPES,
  NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT,
  NO_VIEW_SCORE_COMPONENTS,
  NO_VIEW_SCORE_MODEL,
  recommendNoViewStrategies,
  recommendOptionStrategies,
  resolveNoViewScoreWeights,
  resolveScoreWeights,
  type NoViewStrategyCandidate,
  type NoViewStrategyRequest,
  type StrategyCandidate,
  type StrategyRequest,
} from "../src/trading/options/strategyEngine";
import { validateNoViewRequest, StrategyRiskAgent } from "../src/trading/options/strategyRiskAgent";
import {
  NO_VIEW_ACCEPTANCE_RULES,
  runNoViewAcceptanceRules,
} from "../src/trading/options/strategies/ledger";
import {
  NO_VIEW_PICK_RATIONALE,
  RecommendationAgent,
} from "../src/trading/options/recommendationAgent";

/**
 * Issue #534 (PR-534-A, engine slice) — the no-view mode.
 *
 * Pins: a distinct view-less request type whose validator REJECTS
 * smuggled view fields; a target-free score model (no-view-v1) whose
 * breakdown demonstrably lacks the target-derived components; the
 * acceptance-rule replacements (structure payoff, structure reward/risk,
 * POP floor) with per-symbol abstention; and a best-pick that can never
 * be "recommended" or HIGH confidence. The viewed path's regression is
 * pinned by the existing suite; one shape pin below guards the shared
 * candidate core from the other side.
 */

const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const expiryDate = expiry.toISOString().slice(0, 10);

function makeContracts(): ScreenedOptionContractItem[] {
  const quoteTimestamp = Date.now();
  return [90, 95, 100, 105, 110].flatMap((strike) => {
    const timeValue = Math.max(0.3, 3 - Math.abs(strike - 100) * 0.12);
    const callMid = Math.max(0.3, Math.max(100 - strike, 0) + timeValue);
    const putMid = Math.max(0.3, Math.max(strike - 100, 0) + timeValue);
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (100 - strike) / 40));
    const base = {
      underlyingSymbol: "XYZ",
      underlyingPrice: 100,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: Math.abs(strike - 100),
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(quoteTimestamp).toISOString(),
      quoteFreshness: "FRESH" as const,
      bidSize: 10,
      askSize: 10,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      spreadOi: undefined,
      technicalSignal: "Test fixture",
      highlightReason: "Test fixture",
      volumeOiRatio: 0.5,
    };
    return [
      {
        ...base,
        optionType: "CALL" as const,
        symbol: `XYZ${strike}C`,
        strikePrice: strike,
        bid: callMid - 0.1,
        ask: callMid + 0.1,
        delta,
      },
      {
        ...base,
        optionType: "PUT" as const,
        symbol: `XYZ${strike}P`,
        strikePrice: strike,
        bid: putMid - 0.1,
        ask: putMid + 0.1,
        delta: -delta,
      },
    ];
  });
}

function noViewRequest(overrides: Partial<NoViewStrategyRequest> = {}): NoViewStrategyRequest {
  return {
    symbol: "XYZ",
    maxPlannedLoss: 1_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "long_put", "call_debit_spread", "put_debit_spread", "long_straddle"],
    ...overrides,
  };
}

type ValidatorBody = Partial<NoViewStrategyRequest> & Record<string, unknown>;
const asBody = (body: Record<string, unknown>): ValidatorBody => body as ValidatorBody;

describe("validateNoViewRequest (#534)", () => {
  const valid = { symbol: "XYZ", maxPlannedLoss: 1_000, minRewardRisk: 0.1 };

  it("accepts a minimal constraint set (allowedStrategies and floors default)", () => {
    expect(validateNoViewRequest(asBody(valid))).toBeNull();
  });

  it("accepts a full constraint set", () => {
    expect(validateNoViewRequest(asBody({
      ...valid,
      minProbabilityOfProfit: 0.4,
      riskProfile: "conservative",
      dataMode: "live",
      minDte: 7,
      maxDte: 45,
      minVolume: 10,
      minOpenInterest: 100,
      maxSpreadPct: 20,
      allowedStrategies: ["long_call", "iron_condor"],
      eventPolicy: "warn",
      optimizationBias: 50,
    }))).toBeNull();
  });

  it("rejects a smuggled thesis instead of ignoring it", () => {
    expect(validateNoViewRequest(asBody({ ...valid, thesis: "bullish" }))).not.toBeNull();
  });

  it("rejects a smuggled targetPrice instead of ignoring it", () => {
    expect(validateNoViewRequest(asBody({ ...valid, targetPrice: 110 }))).not.toBeNull();
  });

  it("rejects a smuggled targetDate instead of ignoring it", () => {
    expect(validateNoViewRequest(asBody({ ...valid, targetDate: expiryDate }))).not.toBeNull();
  });

  it("rejects a smuggled expectedIvDirection — the IV assumption is a mode constant, not an input", () => {
    expect(validateNoViewRequest(asBody({ ...valid, expectedIvDirection: "rise" }))).not.toBeNull();
  });

  it("names the contract in its error message", () => {
    expect(validateNoViewRequest(asBody({ ...valid, thesis: "bullish" })))
      .toBe("Invalid no-view strategy request. Supply a symbol, risk cap, reward/risk minimum, and constraints only — no thesis, target price, target date, or IV direction.");
  });

  it("rejects missing or malformed base fields", () => {
    expect(validateNoViewRequest(null)).not.toBeNull();
    expect(validateNoViewRequest(undefined)).not.toBeNull();
    expect(validateNoViewRequest(asBody({ maxPlannedLoss: 1_000, minRewardRisk: 0.1 }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, symbol: "  " }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, maxPlannedLoss: Number.NaN }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, minRewardRisk: "high" }))).not.toBeNull();
  });

  it("rejects an out-of-range probability-of-profit floor", () => {
    expect(validateNoViewRequest(asBody({ ...valid, minProbabilityOfProfit: 0 }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, minProbabilityOfProfit: -0.2 }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, minProbabilityOfProfit: 1.01 }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, minProbabilityOfProfit: 1 }))).toBeNull();
  });

  it("rejects an unknown risk profile, unknown strategies, and an empty strategy list", () => {
    expect(validateNoViewRequest(asBody({ ...valid, riskProfile: "yolo" }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, allowedStrategies: ["not_a_strategy"] }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, allowedStrategies: [] }))).not.toBeNull();
  });

  it("rejects malformed DTE bounds in the viewed validator's style", () => {
    expect(validateNoViewRequest(asBody({ ...valid, minDte: 0 }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, minDte: 30, maxDte: 7 }))).not.toBeNull();
    expect(validateNoViewRequest(asBody({ ...valid, minDte: 7.5 }))).not.toBeNull();
  });
});

describe("resolveNoViewScoreWeights (#534)", () => {
  it("contains exactly the five target-free components — the dropped keys are absent, not zeroed", () => {
    const weights = resolveNoViewScoreWeights();
    expect(Object.keys(weights).sort()).toEqual([...NO_VIEW_SCORE_COMPONENTS].sort());
    for (const dropped of ["thesisAlignment", "targetRewardRisk", "capitalEfficiency", "volatilityAlignment"]) {
      expect(dropped in weights).toBe(false);
    }
  });

  it("renormalizes to the same configured total as the viewed weights", () => {
    const configuredTotal = Object.values(resolveScoreWeights()).reduce((sum, w) => sum + w, 0);
    for (const bias of [undefined, 0, 50, 100]) {
      const total = Object.values(resolveNoViewScoreWeights(bias)).reduce((sum, w) => sum + w, 0);
      expect(total).toBeCloseTo(configuredTotal, 9);
    }
  });

  it("preserves the kept components' proportions from the viewed machinery", () => {
    const viewed = resolveScoreWeights();
    const noView = resolveNoViewScoreWeights();
    expect(noView.popAlignment / noView.liquidity).toBeCloseTo(viewed.popAlignment / viewed.liquidity, 9);
    expect(noView.cushion / noView.freshness).toBeCloseTo(viewed.cushion / viewed.freshness, 9);
    // Every kept weight is scaled UP (the dropped share is redistributed).
    for (const key of NO_VIEW_SCORE_COMPONENTS) expect(noView[key]).toBeGreaterThan(viewed[key]);
  });
});

describe("recommendNoViewStrategies — ranking (#534)", () => {
  it("ranks structures with model stamps and no target fields anywhere", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest());
    expect(result.status).toBe("ranked_candidates");
    expect(result.modelVersion).toBe("no-view-v1");
    expect(result.scoreModel).toBe(NO_VIEW_SCORE_MODEL);
    expect(result.expectedIvDirection).toBe("unchanged");
    expect(Object.keys(result.scoreWeights).sort()).toEqual([...NO_VIEW_SCORE_COMPONENTS].sort());
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.scoreModel).toBe("no-view-v1");
      // Target fields are ABSENT, not zeroed — no target exists.
      expect("targetPnl" in candidate).toBe(false);
      expect("targetRewardRisk" in candidate).toBe(false);
      expect(Object.keys(candidate.scoreBreakdown).sort())
        .toEqual(["cushion", "freshness", "liquidity", "popAlignment", "thetaBurden", "weights"]);
      expect(Object.keys(candidate.scoreBreakdown.weights).sort()).toEqual([...NO_VIEW_SCORE_COMPONENTS].sort());
    }
  });

  it("scores each candidate as exactly the weighted sum of its five components", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest());
    for (const candidate of result.candidates) {
      const recomputed = NO_VIEW_SCORE_COMPONENTS.reduce(
        (sum, key) => sum + candidate.scoreBreakdown[key] * candidate.scoreBreakdown.weights[key], 0);
      // The stored score is rounded to 1dp.
      expect(Math.abs(candidate.score - recomputed)).toBeLessThanOrEqual(0.051);
    }
  });

  it("records structureRewardRisk as maxProfit/maxLoss, from the structure alone", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest());
    const bounded = result.candidates.filter((c) => !c.maxProfitUnbounded);
    expect(bounded.length).toBeGreaterThan(0);
    for (const candidate of bounded) {
      expect(candidate.structureRewardRisk).not.toBeNull();
      expect(Math.abs((candidate.structureRewardRisk ?? 0) - (candidate.maxProfit ?? 0) / candidate.maxLoss))
        .toBeLessThanOrEqual(0.011);
    }
  });

  it("runs every selected definition in ONE pass — bullish, bearish, range-bound and large-move types together", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({
      maxPlannedLoss: 5_000,
      allowedStrategies: ["long_call", "long_put", "call_debit_spread", "put_debit_spread", "iron_condor", "long_straddle"],
    }));
    const types = new Set(result.candidates.map((c) => c.type));
    // A viewed run could never mix these: each belongs to a different thesis.
    expect(types.has("call_debit_spread")).toBe(true); // bullish-only type
    expect(types.has("put_debit_spread")).toBe(true); // bearish-only type
    expect(types.has("iron_condor")).toBe(true); // range_bound-only type
    expect(result.evaluations).toHaveLength(ALL_STRATEGY_TYPES.length);
    expect(result.evaluations.find((e) => e.id === "iron_condor")?.status).toBe("accepted");
  });

  it("defaults the allow-list to the full registry", () => {
    const result = recommendNoViewStrategies(makeContracts(), { symbol: "XYZ", maxPlannedLoss: 5_000, minRewardRisk: 0.1 });
    expect(result.status).toBe("ranked_candidates");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.evaluations).toHaveLength(ALL_STRATEGY_TYPES.length);
    expect(result.evaluations.every((e) => !e.summary.includes("not selected"))).toBe(true);
  });

  it("echoes the caller's constraint set verbatim — defaults are never written back into it", () => {
    const input = noViewRequest();
    const result = recommendNoViewStrategies(makeContracts(), input);
    expect(result.request).toBe(input);
    expect(Object.keys(result.request).sort()).toEqual(Object.keys(input).sort());
    expect(result.request.minProbabilityOfProfit).toBeUndefined();
  });

  it("is deterministic across runs", () => {
    const first = recommendNoViewStrategies(makeContracts(), noViewRequest());
    const second = recommendNoViewStrategies(makeContracts(), noViewRequest());
    expect(first.candidates.map((c) => [c.id, c.score])).toEqual(second.candidates.map((c) => [c.id, c.score]));
  });

  it("anchors detail scenarios at the candidate's own expiry, there being no target date", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest(), 3);
    expect(result.candidates).toHaveLength(3);
    const top = result.candidates[0];
    expect(top.payoffCurve.length).toBeGreaterThanOrEqual(41);
    expect(top.scenarios.length).toBeGreaterThan(0);
    expect(Math.max(...top.scenarios.map((s) => s.daysToExpiry))).toBe(30);
  });

  it("states the mode's honesty terms in its assumptions", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest());
    expect(result.assumptions[0]).toContain("No user view was supplied, derived, or inferred");
    expect(result.assumptions.join(" ")).toContain("no-view-v1");
    expect(result.assumptions.join(" ")).toContain("'unchanged'");
  });

  it("withholds everything under event-risk exclusion, exactly as the viewed path does", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({ eventPolicy: "exclude" }));
    expect(result.status).toBe("no_candidates");
    expect(result.candidates).toHaveLength(0);
    expect(result.excluded).toEqual([
      { reason: "Event-risk exclusion cannot be verified without an event calendar", count: makeContracts().length },
    ]);
  });

  it("rejects malformed numeric input in the engine's throw style", () => {
    expect(() => recommendNoViewStrategies(makeContracts(), noViewRequest({ symbol: " " }))).toThrow("symbol is required");
    expect(() => recommendNoViewStrategies(makeContracts(), noViewRequest({ maxPlannedLoss: 0 }))).toThrow("maxPlannedLoss must be positive");
    expect(() => recommendNoViewStrategies(makeContracts(), noViewRequest({ minProbabilityOfProfit: 0 }))).toThrow("minProbabilityOfProfit");
    expect(() => recommendNoViewStrategies(makeContracts(), noViewRequest({ minProbabilityOfProfit: 1.5 }))).toThrow("minProbabilityOfProfit");
  });
});

describe("no-view acceptance gates (#534)", () => {
  it("keeps the max-planned-loss gate unchanged from the viewed model", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({ maxPlannedLoss: 1 }));
    expect(result.status).toBe("no_candidates");
    expect(result.excluded.some((e) => e.reason.includes("exceeds the max planned loss"))).toBe(true);
  });

  it("enforces the POP floor at its 0.35 default — sub-floor structures are excluded, survivors all clear it", () => {
    expect(NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT).toBe(0.35);
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({ allowedStrategies: ["long_call"] }));
    // Some long calls on this chain sit below the floor and are excluded
    // for exactly that reason...
    expect(result.excluded.some((e) => e.reason.includes("below the minimum probability of profit"))).toBe(true);
    // ...and every survivor demonstrably clears the default floor.
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.modelImpliedProbabilityOfProfit).toBeGreaterThanOrEqual(0.35);
    }
  });

  it("enforces an explicit POP floor", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({ minProbabilityOfProfit: 0.99 }));
    expect(result.status).toBe("no_candidates");
    expect(result.excluded.some((e) => e.reason.includes("below the minimum probability of profit"))).toBe(true);
  });

  it("lets unbounded-profit structures through the reward/risk gate on POP + max-loss alone", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({ minRewardRisk: 50 }));
    expect(result.status).toBe("ranked_candidates");
    expect(result.candidates.length).toBeGreaterThan(0);
    // Every survivor is unbounded (structureRewardRisk null, never Infinity)...
    for (const candidate of result.candidates) {
      expect(candidate.structureRewardRisk).toBeNull();
      expect(candidate.maxProfitUnbounded).toBe(true);
    }
    // ...while bounded structures were rejected by the structure gate.
    expect(result.excluded.some((e) => e.reason.includes("below the minimum structure reward/risk"))).toBe(true);
  });

  it("rejects a structure whose own payoff is non-positive after fees (crossed-quote spread)", () => {
    const crossed = makeContracts().map((c) => (c.symbol === "XYZ90C" ? { ...c, bid: 29.9, ask: 30.1 } : c));
    const result = recommendNoViewStrategies(crossed, {
      symbol: "XYZ",
      maxPlannedLoss: 100_000,
      minRewardRisk: 0.1,
      allowedStrategies: ["call_debit_spread"],
    });
    expect(result.excluded.some((e) => e.reason.includes("has no positive modeled payoff after fees"))).toBe(true);
  });

  it("pins the replacement rule set and its chain order", () => {
    expect(NO_VIEW_ACCEPTANCE_RULES.map((r) => r.id)).toEqual([
      "max-planned-loss",
      "positive-structure-payoff",
      "min-structure-reward-risk",
      "min-pop",
    ]);
  });
});

function fakeNoViewCandidate(overrides: Partial<NoViewStrategyCandidate> = {}): NoViewStrategyCandidate {
  return {
    id: "fake:XYZ100C",
    rank: 1,
    type: "long_call",
    label: "Long Call",
    symbol: "XYZ",
    underlyingPrice: 100,
    expirationDate: expiryDate,
    dataFreshness: "FRESH",
    legs: [],
    netDebit: 100,
    estimatedFees: 1,
    maxProfit: 500,
    maxProfitUnbounded: false,
    maxLoss: 200,
    breakevens: [102],
    modelImpliedProbabilityOfProfit: 0.9,
    netGreeks: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    liquidityScore: 95,
    score: 80,
    scoreBreakdown: {
      popAlignment: 90,
      cushion: 50,
      liquidity: 95,
      thetaBurden: 90,
      freshness: 100,
      weights: resolveNoViewScoreWeights(),
    },
    payoffCurve: [],
    scenarios: [],
    explanations: [],
    warnings: [],
    assumptions: [],
    structureRewardRisk: 2.5,
    scoreModel: "no-view-v1",
    ...overrides,
  };
}

describe("runNoViewAcceptanceRules — gate edges (#534)", () => {
  const request: NoViewStrategyRequest = { symbol: "XYZ", maxPlannedLoss: 1_000, minRewardRisk: 0.5, minProbabilityOfProfit: 0.35 };

  it("passes a qualifying structure", () => {
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate(), request)).toBeNull();
  });

  it("max-planned-loss fires first", () => {
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ maxLoss: 2_000 }), request))
      .toContain("exceeds the max planned loss");
  });

  it("positive-structure-payoff rejects bounded zero/negative payoff but passes unbounded", () => {
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ maxProfit: 0 }), request))
      .toContain("no positive modeled payoff");
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ maxProfit: null, maxProfitUnbounded: true, structureRewardRisk: null }), request))
      .toBeNull();
  });

  it("min-structure-reward-risk compares the structure ratio, and null carries", () => {
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ structureRewardRisk: 0.4 }), request))
      .toContain("below the minimum structure reward/risk");
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ structureRewardRisk: null, maxProfit: null, maxProfitUnbounded: true }), { ...request, minRewardRisk: 99 }))
      .toBeNull();
  });

  it("min-pop applies the request floor, defaulting to 0.35", () => {
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ modelImpliedProbabilityOfProfit: 0.3 }), request))
      .toContain("below the minimum probability of profit");
    const { minProbabilityOfProfit: _omit, ...noFloor } = request;
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ modelImpliedProbabilityOfProfit: 0.34 }), noFloor))
      .toContain("below the minimum probability of profit");
    expect(runNoViewAcceptanceRules(fakeNoViewCandidate({ modelImpliedProbabilityOfProfit: 0.34 }), { ...request, minProbabilityOfProfit: 0.3 }))
      .toBeNull();
  });
});

describe("recommender no-view rank and pick (#534)", () => {
  const agent = new RecommendationAgent();
  const request: NoViewStrategyRequest = { symbol: "XYZ", maxPlannedLoss: 1_000, minRewardRisk: 0.1 };

  it("abstains: an empty candidate set is a no_trade pick with no best", () => {
    const pick = agent.pickBestNoViewTrade([], request);
    expect(pick.status).toBe("no_trade");
    expect(pick.best).toBeUndefined();
    expect(pick.alternatives).toEqual([]);
    expect(pick.confidence).toBe("LOW");
    expect(pick.rationale[0]).toContain("No user view was supplied");
    expect(pick.rationale[0]).toContain("abstains");
  });

  it("abstains end-to-end: a run where nothing qualifies produces no pick", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest({ maxPlannedLoss: 1 }));
    expect(result.status).toBe("no_candidates");
    const pick = agent.pickBestNoViewTrade(result.candidates, request);
    expect(pick.status).toBe("no_trade");
    expect(pick.best).toBeUndefined();
  });

  it("picks research_only with the pinned rationale, never a recommendation", () => {
    const result = recommendNoViewStrategies(makeContracts(), noViewRequest());
    const pick = agent.pickBestNoViewTrade(result.candidates, request);
    expect(pick.status).toBe("research_only");
    expect(pick.best).toBeDefined();
    expect(pick.rationale[0]).toBe("No user view was supplied; this is the best-supported structure under the stated constraints, not a recommendation.");
    expect(pick.rationale[0]).toBe(NO_VIEW_PICK_RATIONALE);
    expect(pick.tradePlan).toHaveLength(pick.best!.candidate.legs.length);
    expect(pick.humanApprovalRequired).toBe(true);
    expect(JSON.stringify(pick.rationale)).not.toContain("Target-date modeled P/L");
  });

  it("caps confidence at MEDIUM where the viewed picker would say HIGH", () => {
    // Two clean, fresh, liquid, high-POP structures with a wide margin:
    // every HIGH condition of the viewed formula is satisfied.
    const strong = fakeNoViewCandidate({ id: "fake:strong", score: 90 });
    const weak = fakeNoViewCandidate({ id: "fake:weak", score: 60 });
    const pick = agent.pickBestNoViewTrade([weak, strong], request);
    expect(pick.status).toBe("research_only");
    expect(pick.confidence).toBe("MEDIUM");
    expect(pick.best?.candidate.id).toBe("fake:strong");

    // The viewed twin of the same data IS a HIGH-confidence recommendation —
    // the cap is a property of the no-view mode, not of the data.
    const viewedTwin = (c: NoViewStrategyCandidate): StrategyCandidate => ({
      ...c,
      targetPnl: 300,
      targetRewardRisk: 1.5,
      scoreBreakdown: {
        thesisAlignment: 80, targetRewardRisk: 80, liquidity: c.liquidityScore, volatilityAlignment: 70,
        thetaBurden: 90, freshness: 100, popAlignment: 90, cushion: 50, capitalEfficiency: 50,
        weights: resolveScoreWeights(),
      },
    });
    const viewedRequest: StrategyRequest = {
      symbol: "XYZ", thesis: "bullish", targetPrice: 110, targetDate: expiryDate,
      expectedIvDirection: "unchanged", maxPlannedLoss: 1_000, minRewardRisk: 0.1,
      allowedStrategies: ["long_call"],
    };
    const viewedPick = agent.pickBestTrade([viewedTwin(weak), viewedTwin(strong)], viewedRequest);
    expect(viewedPick.status).toBe("recommended");
    expect(viewedPick.confidence).toBe("HIGH");
  });

  it("computes the rankNoView rewardRisk component from the structure ratio; unbounded takes the clamped maximum", () => {
    const bounded = fakeNoViewCandidate({ id: "fake:bounded", structureRewardRisk: 2.5 });
    const unbounded = fakeNoViewCandidate({ id: "fake:unbounded", structureRewardRisk: null, maxProfit: null, maxProfitUnbounded: true });
    const ranked = agent.rankNoView([bounded, unbounded], { maxPlannedLoss: 1_000, minRewardRisk: 2 });
    const byId = new Map(ranked.map((r) => [r.candidate.id, r]));
    expect(byId.get("fake:bounded")?.components.rewardRisk).toBeCloseTo(62.5, 6);
    expect(byId.get("fake:unbounded")?.components.rewardRisk).toBe(100);
  });

  it("takes the ranking profile from the constraint set when none is passed", () => {
    const pick = agent.pickBestNoViewTrade([fakeNoViewCandidate()], { ...request, riskProfile: "conservative" });
    expect(pick.riskProfile).toBe("conservative");
  });

  it("is reachable through the Strategy Risk Agent's no-view builder", () => {
    const result = new StrategyRiskAgent().buildNoViewStrategies(makeContracts(), noViewRequest());
    expect(result.status).toBe("ranked_candidates");
    expect(result.candidates.every((c) => c.scoreModel === "no-view-v1")).toBe(true);
  });
});

describe("shared-core shape guard (#534)", () => {
  it("viewed candidates still carry their target fields — the shared core did not leak the omission", () => {
    const viewed = recommendOptionStrategies(makeContracts(), {
      symbol: "XYZ",
      thesis: "bullish",
      targetPrice: 110,
      targetDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 1_000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call", "call_debit_spread"],
    } satisfies StrategyRequest);
    expect(viewed.candidates.length).toBeGreaterThan(0);
    for (const candidate of viewed.candidates) {
      expect(Number.isFinite(candidate.targetPnl)).toBe(true);
      expect(Number.isFinite(candidate.targetRewardRisk)).toBe(true);
      expect(candidate.scoreBreakdown.weights.thesisAlignment).toBeCloseTo(0.205);
    }
  });

  it("grep pin: the no-view engine region never reads a view field or a target", () => {
    const source = readFileSync(new URL("../src/trading/options/strategyEngine.ts", import.meta.url), "utf8");
    const start = source.indexOf("function buildNoViewCandidate");
    expect(start).toBeGreaterThan(-1);
    const region = source.slice(start);
    expect(region).not.toMatch(/targetPrice|targetDate|request\.thesis/);
    // And the no-view request type itself declares no view fields.
    const typeStart = source.indexOf("export interface NoViewStrategyRequest");
    const typeRegion = source.slice(typeStart, source.indexOf("}", typeStart));
    expect(typeRegion).not.toMatch(/thesis|targetPrice|targetDate|expectedIvDirection/);
  });
});
