import { describe, expect, it } from "vitest";
import { buildStrategyRequest, mapCandidateToDiscovered, sentimentToThesis, type ServerCandidate } from "../src/client/options/serverDiscovery";
import type { ExpirationOption } from "../src/client/options/strategyDiscoveryEngine";

/** Issue #29: the Discovery view is a thin client of the server pipeline. */
const EXPIRATION: ExpirationOption = { date: "2026-11-13", label: "Nov 13", dayLabel: "13", dte: 30 };

const CANDIDATE: ServerCandidate = {
  id: "cand-1",
  type: "call_debit_spread",
  label: "Call Debit Spread",
  expirationDate: "2026-11-13",
  legs: [
    { symbol: "XYZ100C", optionType: "CALL", side: "BUY", quantity: 1, strike: 100, expirationDate: "2026-11-13", daysToExpiration: 30, entryPrice: 3.1, bid: 3.0, ask: 3.2, impliedVolatility: 0.3, delta: 0.52, gamma: 0.03, theta: -0.04, vega: 0.11 },
    { symbol: "XYZ105C", optionType: "CALL", side: "SELL", quantity: 1, strike: 105, expirationDate: "2026-11-13", daysToExpiration: 30, entryPrice: 1.2, bid: 1.1, ask: 1.3, impliedVolatility: 0.3, delta: 0.31, gamma: 0.03, theta: -0.03, vega: 0.08 },
  ],
  netDebit: 190,
  maxProfit: 310,
  maxLoss: 190,
  breakevens: [101.9],
  targetPnl: 120,
  targetRewardRisk: 1.63,
  modelImpliedProbabilityOfProfit: 0.58,
  payoffCurve: [
    { underlyingPrice: 90, pnl: -190 },
    { underlyingPrice: 100, pnl: -190 },
    { underlyingPrice: 105, pnl: 310 },
    { underlyingPrice: 110, pnl: 310 },
  ],
  explanations: ["Call Debit Spread matches the bullish thesis."],
};

describe("server discovery mapping (issue #29)", () => {
  it("maps panel sentiment to server thesis", () => {
    expect(sentimentToThesis("bullish", 110, 100)).toBe("bullish");
    expect(sentimentToThesis("very_bearish", 90, 100)).toBe("bearish");
    expect(sentimentToThesis("neutral", 100, 100)).toBe("range_bound");
    expect(sentimentToThesis("all", 105, 100)).toBe("bullish");
    expect(sentimentToThesis("all", 95, 100)).toBe("bearish");
    expect(sentimentToThesis("all", 100, 100)).toBe("range_bound");
  });

  it("builds a pipeline request from panel inputs", () => {
    const req = buildStrategyRequest({ symbol: "xyz", currentPrice: 100, sentiment: "bullish", targetPrice: 110, budget: 1000, minRewardRisk: 1.5, expiration: EXPIRATION });
    expect(req.symbol).toBe("XYZ");
    expect(req.thesis).toBe("bullish");
    expect(req.maxPlannedLoss).toBe(1000);
    expect(req.minRewardRisk).toBe(1.5);
    expect(req.maxDte).toBe(30);
    expect(req.allowedStrategies).toEqual(["all"]);
  });

  it("maps a server candidate into the panel view model with real-chain values", () => {
    const mapped = mapCandidateToDiscovered({ candidate: CANDIDATE, rank: 1, compositeScore: 87.5 }, "bullish");
    expect(mapped.name).toBe("Call Debit Spread");
    expect(mapped.legs).toHaveLength(2);
    expect(mapped.legs[0].strike).toBe(100);
    expect(mapped.netDebit).toBe(190);
    expect(mapped.maxLoss).toBe(190);
    expect(mapped.maxProfit).toBe(310);
    expect(mapped.chanceOfProfit).toBe(58);
    expect(mapped.rewardRiskRatio).toBe(1.63);
    expect(mapped.returnOnRiskPct).toBeCloseTo((120 / 190) * 100);
    expect(mapped.tag).toBe("#1 Server Ranked");
    expect(mapped.miniPayoffPoints.length).toBeGreaterThan(0);
  });
});
