/**
 * Issue #29, slice 7: the client engine's cushion / capital-efficiency /
 * POP lenses absorbed into the server scoring engine, and the panel's bias
 * slider expressed as a server request weighting (resolveScoreWeights).
 *
 * Issue #25 addendum: the capital-efficiency maxLoss floor is 1% of
 * per-contract notional (spot-relative), not a flat $100 — pinned by the
 * spot-40 test below, where the two floors genuinely differ.
 */
import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import {
  optimizationBiasFactors,
  recommendOptionStrategies,
  resolveScoreWeights,
  type StrategyRequest,
} from "../src/trading/options/strategyEngine";

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

function request(overrides: Partial<StrategyRequest> = {}): StrategyRequest {
  return {
    symbol: "XYZ",
    thesis: "bullish",
    targetPrice: 110,
    targetDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 1_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread"],
    ...overrides,
  };
}

const weightSum = (w: Record<string, number>) => Object.values(w).reduce((a, b) => a + b, 0);

describe("optimization bias -> server score weights (issue #29)", () => {
  it("ports the client's bias interpolation", () => {
    expect(optimizationBiasFactors(0)).toEqual({ returnWeight: 60, chanceWeight: 10, safetyWeight: 10, capitalWeight: 20 });
    expect(optimizationBiasFactors(100)).toEqual({ returnWeight: 10, chanceWeight: 60, safetyWeight: 25, capitalWeight: 10 });
    expect(optimizationBiasFactors(50)).toEqual({ returnWeight: 35, chanceWeight: 35, safetyWeight: 18, capitalWeight: 15 });
  });

  it("keeps configured weights when no bias is given, and preserves the total when biased", () => {
    const base = resolveScoreWeights(undefined);
    expect(weightSum(base)).toBeCloseTo(1, 6);
    for (const bias of [0, 25, 50, 75, 100]) {
      expect(weightSum(resolveScoreWeights(bias))).toBeCloseTo(1, 6);
    }
  });

  it("tilts return-seeking at bias 0 and chance/safety-seeking at bias 100", () => {
    const returnSeeking = resolveScoreWeights(0);
    const chanceSeeking = resolveScoreWeights(100);
    expect(returnSeeking.targetRewardRisk).toBeGreaterThan(chanceSeeking.targetRewardRisk);
    expect(returnSeeking.capitalEfficiency).toBeGreaterThan(chanceSeeking.capitalEfficiency);
    expect(chanceSeeking.popAlignment).toBeGreaterThan(returnSeeking.popAlignment);
    expect(chanceSeeking.cushion).toBeGreaterThan(returnSeeking.cushion);
    // Server-native factors keep their relative proportions under any bias.
    expect(returnSeeking.liquidity / returnSeeking.thesisAlignment)
      .toBeCloseTo(chanceSeeking.liquidity / chanceSeeking.thesisAlignment, 6);
  });
});

describe("absorbed lenses in candidate scoring (issue #29)", () => {
  it("scores cushion, capital efficiency and POP on every candidate, within 0-100", () => {
    const result = recommendOptionStrategies(makeContracts(), request());
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      const b = candidate.scoreBreakdown;
      for (const key of ["popAlignment", "cushion", "capitalEfficiency"] as const) {
        expect(b[key]).toBeGreaterThanOrEqual(0);
        expect(b[key]).toBeLessThanOrEqual(100);
      }
      expect(weightSum(b.weights)).toBeCloseTo(1, 6);
      // POP lens mirrors the candidate's modeled probability of profit.
      expect(b.popAlignment).toBeCloseTo(candidate.modelImpliedProbabilityOfProfit * 100, 0);
    }
  });

  it("computes cushion from the nearest breakeven distance (client formula)", () => {
    const result = recommendOptionStrategies(makeContracts(), request({ allowedStrategies: ["long_call"] }));
    const candidate = result.candidates[0];
    const cushionPct = Math.min(...candidate.breakevens.map((b) => Math.abs(b - candidate.underlyingPrice)))
      / candidate.underlyingPrice * 100;
    const expected = Math.max(5, Math.min(100, Math.round(cushionPct * 4)));
    expect(candidate.scoreBreakdown.cushion).toBe(expected);
  });

  it("computes capital efficiency against a spot-relative maxLoss floor (issue #25)", () => {
    // Spot-40 chain (same economics as the spot-100 fixture, scaled):
    // narrow debit spreads here carry maxLoss between $40 (1% of the
    // $4,000 per-contract notional) and $100 — exactly the window where
    // the pre-#25 flat $100 floor and the spot-relative floor differ.
    const spot = 40;
    const contracts = [36, 38, 40, 42, 44].flatMap((strike) => {
      const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
      const callMid = Math.max(0.3, Math.max(spot - strike, 0) + timeValue);
      const putMid = Math.max(0.3, Math.max(strike - spot, 0) + timeValue);
      const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
      const base = {
        underlyingSymbol: "XYZ",
        underlyingPrice: spot,
        daysToExpiration: 30,
        expirationDate: expiryDate,
        moneyness: "ATM" as const,
        strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
        spreadPct: 8,
        quoteAgeSeconds: 0,
        quoteTimestamp: new Date(Date.now()).toISOString(),
        quoteFreshness: "FRESH" as const,
        lastPrice: 2.5,
        volume: 1_000,
        openInterest: 2_000,
        gamma: 0.02,
        theta: -0.03,
        vega: 0.12,
        impliedVolatility: 0.3,
        adjustedFlag: false,
        technicalSignal: "Test fixture",
        highlightReason: "Test fixture",
      };
      return [
        { ...base, optionType: "CALL" as const, symbol: `XYZ${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
        { ...base, optionType: "PUT" as const, symbol: `XYZ${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
      ];
    });
    const result = recommendOptionStrategies(contracts, request({
      targetPrice: 42,
      allowedStrategies: ["call_debit_spread"],
    }));
    // (targetPnl between $10 and maxLoss keeps both formulas off their
    // 10/100 clamps, so the floor choice is what the values show.)
    const inWindow = result.candidates.filter(
      (c) => c.maxLoss > spot && c.maxLoss < 100 && c.targetPnl > 10 && c.targetPnl < c.maxLoss,
    );
    expect(inWindow.length).toBeGreaterThan(0);
    for (const candidate of inWindow) {
      const clampLens = (v: number) => Math.max(10, Math.min(100, Math.round(v)));
      const spotFloor = clampLens(candidate.targetPnl / Math.max(candidate.underlyingPrice, candidate.maxLoss) * 100);
      const flatFloor = clampLens(candidate.targetPnl / Math.max(100, candidate.maxLoss) * 100);
      // The fixture must actually discriminate the two formulas…
      expect(spotFloor).not.toBe(flatFloor);
      // …and the engine must use the spot-relative one.
      expect(candidate.scoreBreakdown.capitalEfficiency).toBe(spotFloor);
    }
  });

  it("threads optimizationBias from the request into the reported weights", () => {
    const biased = recommendOptionStrategies(makeContracts(), request({ optimizationBias: 100 }));
    expect(biased.scoreWeights.popAlignment).toBeCloseTo(resolveScoreWeights(100).popAlignment, 6);
    expect(biased.candidates[0].scoreBreakdown.weights.popAlignment)
      .toBeCloseTo(resolveScoreWeights(100).popAlignment, 6);
    const plain = recommendOptionStrategies(makeContracts(), request());
    expect(plain.scoreWeights.thesisAlignment).toBeCloseTo(0.205);
  });
});
