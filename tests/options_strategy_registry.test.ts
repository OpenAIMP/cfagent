import { describe, expect, it } from "vitest";
import type { ScreenedOptionContractItem } from "../src/types";
import { recommendOptionStrategies, type OptionThesis, type StrategyRequest } from "../src/trading/options/strategyEngine";
import { REQUESTED_STRATEGY_NAMES, defaultRegistry } from "../src/trading/options/strategies/catalog";
import { StrategyRegistry } from "../src/trading/options/strategies/registry";
import { createTemplateStrategy } from "../src/trading/options/strategies/template";

function expiryIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function makeChain(days: number): ScreenedOptionContractItem[] {
  const expirationDate = expiryIn(days);
  const now = new Date().toISOString();
  return [80, 85, 90, 95, 100, 105, 110, 115, 120].flatMap((strike) => {
    const timeValue = Math.max(0.4, (2 + days / 60) - Math.abs(strike - 100) * 0.1);
    const base = {
      underlyingSymbol: "XYZ",
      underlyingPrice: 100,
      daysToExpiration: days,
      expirationDate,
      moneyness: "ATM" as const,
      strikeDistancePct: Math.abs(strike - 100),
      spreadPct: 6,
      quoteAgeSeconds: 0,
      quoteTimestamp: now,
      quoteFreshness: "FRESH" as const,
      bidSize: 10,
      askSize: 10,
      lastPrice: 2,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      timeStamp: Date.now(),
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
      validationStatus: "PASS_CONFIRMED" as const,
      volumeOiRatio: 0.5,
    };
    const callMid = Math.max(100 - strike, 0) + timeValue;
    const putMid = Math.max(strike - 100, 0) + timeValue;
    const delta = Math.max(0.1, Math.min(0.9, 0.5 + (100 - strike) / 40));
    return [
      { ...base, optionType: "CALL" as const, symbol: `XYZ${days}${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `XYZ${days}${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

const chain = [...makeChain(30), ...makeChain(60), ...makeChain(400)];

function request(thesis: OptionThesis, overrides: Partial<StrategyRequest> = {}): StrategyRequest {
  return {
    symbol: "XYZ",
    thesis,
    targetPrice: thesis === "bearish" ? 90 : thesis === "range_bound" ? 100 : 110,
    targetDate: expiryIn(20),
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 100_000,
    minRewardRisk: 0,
    allowedStrategies: ["all"],
    ...overrides,
  };
}

describe("pluggable strategy registry", () => {
  it("resolves every requested strategy name to at least one registered strategy", () => {
    const unresolved = REQUESTED_STRATEGY_NAMES.filter((name) => defaultRegistry.resolve(name).length === 0);
    expect(unresolved).toEqual([]);
  });

  it("accepts custom strategies without touching the engine (Registry + Factory)", () => {
    const registry = new StrategyRegistry();
    registry.register(createTemplateStrategy({
      id: "custom_one",
      label: "Custom One",
      category: "single",
      description: "test",
      aliases: ["My Custom"],
      theses: ["bullish"],
      specs: [{ strikes: 1, legs: [{ type: "CALL", side: "BUY", k: 0 }] }],
    }));
    expect(registry.resolve("my custom")).toEqual(["custom_one"]);
    expect(registry.resolveMany(["all"]).ids).toEqual(["custom_one"]);
    expect(() => registry.register(registry.get("custom_one")!)).toThrow();
  });

  it("evaluates every registered strategy and records a reason for each", () => {
    for (const thesis of ["bullish", "bearish", "range_bound", "large_move"] as const) {
      const result = recommendOptionStrategies(chain, request(thesis));
      expect(result.evaluations).toHaveLength(defaultRegistry.ids().length);
      expect(result.evaluations.every((entry) => entry.summary.length > 0)).toBe(true);
      expect(result.nameLedger).toHaveLength(REQUESTED_STRATEGY_NAMES.length);
      expect(result.nameLedger.some((entry) => entry.status === "unresolved")).toBe(false);
      expect(result.candidates.length).toBeGreaterThan(0);
    }
  });

  it("builds range-bound structures with defined risk and rejects unlimited-risk ones with a reason", () => {
    const result = recommendOptionStrategies(chain, request("range_bound"));
    const byId = new Map(result.evaluations.map((entry) => [entry.id, entry]));
    expect(byId.get("iron_condor")?.status).toBe("accepted");
    expect(byId.get("long_call_butterfly")?.status).toBe("accepted");
    expect(byId.get("iron_butterfly")?.status).toBe("accepted");
    expect(byId.get("short_straddle")?.status).toBe("rejected");
    expect(byId.get("short_straddle")?.summary).toContain("unlimited loss");
    expect(byId.get("covered_strangle")?.status).toBe("accepted");
    for (const candidate of result.candidates) expect(Number.isFinite(candidate.maxLoss)).toBe(true);
  });

  it("evaluates multi-expiry strategies using the earliest expiry as the horizon", () => {
    const result = recommendOptionStrategies(chain, request("range_bound"));
    const calendar = result.candidates.find((candidate) => candidate.type === "call_calendar");
    expect(calendar).toBeDefined();
    expect(new Set(calendar!.legs.map((leg) => leg.expirationDate)).size).toBe(2);
    expect(calendar!.maxProfit).not.toBeNull();
    const evaluation = result.evaluations.find((entry) => entry.id === "leaps_call");
    expect(evaluation?.status === "skipped").toBe(true);
  });

  it("supports stock-leg strategies with a hypothetical share count and flags them", () => {
    const result = recommendOptionStrategies(chain, request("bullish", { allowedStrategies: ["Covered Call", "Collar", "Married Put"] }));
    const types = new Set(result.candidates.map((candidate) => candidate.type));
    expect(types.has("covered_call") || types.has("protective_collar") || types.has("protective_put")).toBe(true);
    const withStock = result.candidates.find((candidate) => candidate.legs.some((leg) => leg.optionType === "STOCK"));
    expect(withStock?.warnings.some((warning) => warning.includes("hypothetical shares"))).toBe(true);
  });

  it("rejects locked-payoff arbitrage structures and explains why", () => {
    const result = recommendOptionStrategies(chain, request("bullish", { allowedStrategies: ["Box Spread", "Conversion"] }));
    const box = result.evaluations.find((entry) => entry.id === "box_spread");
    expect(box?.status).toBe("rejected");
    expect(box?.summary).toMatch(/locked payoff|riskless/);
  });

  it("marks strategies that conflict with the thesis as skipped", () => {
    const result = recommendOptionStrategies(chain, request("bullish", { allowedStrategies: ["Iron Condor"] }));
    const condor = result.evaluations.find((entry) => entry.id === "iron_condor");
    expect(condor?.status).toBe("skipped");
    expect(condor?.summary).toContain("thesis");
  });

  it("maps contradictory strategy names to their real structure", () => {
    const result = recommendOptionStrategies(chain, request("bullish", { allowedStrategies: ["Bull Call Credit Spread"] }));
    const entry = result.nameLedger.find((item) => item.name === "Bull Call Credit Spread");
    expect(entry?.resolvesTo).toEqual(["Call Credit Spread"]);
    expect(entry?.note).toContain("Contradictory");
  });
});
