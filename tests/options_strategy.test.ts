import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import { recommendOptionStrategies, type StrategyRequest } from "../src/trading/options/strategyEngine";

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
      validationStatus: "PASS_CONFIRMED" as const,
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

describe("Options strategy and recommendation engine", () => {
  it("calculates conservative long-call risk, breakeven, Greeks, and scenario data", () => {
    const result = recommendOptionStrategies(makeContracts(), request({ allowedStrategies: ["long_call"] }));
    const candidate = result.candidates[0];

    expect(result.status).toBe("ranked_candidates");
    expect(candidate.type).toBe("long_call");
    expect(candidate.legs[0].entryPrice).toBe(candidate.legs[0].ask);
    expect(candidate.maxLoss).toBeGreaterThan(0);
    expect(candidate.maxProfitUnbounded).toBe(true);
    expect(candidate.breakevens).toHaveLength(1);
    expect(candidate.netGreeks.delta).toBeGreaterThan(0);
    expect(candidate.payoffCurve.length).toBe(41);
    expect(candidate.scenarios.length).toBeGreaterThan(25);
    expect(candidate.modelImpliedProbabilityOfProfit).toBeGreaterThanOrEqual(0);
    expect(candidate.modelImpliedProbabilityOfProfit).toBeLessThanOrEqual(1);
    expect(candidate.scoreBreakdown.weights.thesisAlignment).toBeCloseTo(0.30);
  });

  it("generates same-expiration defined-risk debit spreads and ranks them deterministically", () => {
    const input = makeContracts();
    const constraints = request({ allowedStrategies: ["call_debit_spread"] });
    const first = recommendOptionStrategies(input, constraints);
    const second = recommendOptionStrategies(input, constraints);

    expect(first.candidates.length).toBeGreaterThan(0);
    expect(first.candidates.every((candidate) => candidate.legs.length === 2)).toBe(true);
    expect(first.candidates.every((candidate) => candidate.legs.every((leg) => leg.expirationDate === expiryDate))).toBe(true);
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(second.candidates.map((candidate) => candidate.id));
    expect(first.candidates.map((candidate) => candidate.score)).toEqual(second.candidates.map((candidate) => candidate.score));
  });

  it("enforces the declared max-loss constraint and explains exclusions", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ allowedStrategies: ["long_call"], maxPlannedLoss: 1 })
    );

    expect(result.status).toBe("no_candidates");
    expect(result.excluded.some((entry) => entry.reason.includes("max planned loss"))).toBe(true);
  });

  it("returns stale-quote research candidates with a freshness score penalty and warning", () => {
    const staleContracts = makeContracts().map((contract) => ({
      ...contract,
      quoteFreshness: "STALE" as const,
      quoteAgeSeconds: 14_971,
    }));
    const result = recommendOptionStrategies(
      staleContracts,
      request({ allowedStrategies: ["long_call"] })
    );
    const candidate = result.candidates[0];

    expect(candidate?.dataFreshness).toBe("STALE");
    expect(candidate?.scoreBreakdown.freshness).toBe(25);
    expect(candidate?.warnings.some((warning) => warning.includes("Stale quote data"))).toBe(true);
  });

  it("builds a same-expiration iron condor with finite defined risk", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({
        thesis: "range_bound",
        targetPrice: 100,
        targetDate: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        expectedIvDirection: "fall",
        allowedStrategies: ["iron_condor"],
        minRewardRisk: 0,
      })
    );
    const candidate = result.candidates[0];

    expect(candidate?.type).toBe("iron_condor");
    expect(candidate?.legs).toHaveLength(4);
    expect(candidate?.maxProfitUnbounded).toBe(false);
    expect(candidate?.maxProfit).not.toBeNull();
    expect(Number.isFinite(candidate?.maxLoss)).toBe(true);
    expect(candidate?.legs.every((leg) => leg.expirationDate === expiryDate)).toBe(true);
  });

  it("withholds recommendations when event data is required but unavailable", () => {
    const result = recommendOptionStrategies(
      makeContracts(),
      request({ eventPolicy: "exclude" })
    );

    expect(result.candidates).toHaveLength(0);
    expect(result.excluded[0].reason).toContain("event calendar");
  });
});