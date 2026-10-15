/**
 * Issue #38 (G5): cross-surface risk consistency.
 * Same candidate + same snapshot must yield the same headline risk metrics
 * on the server engine and the client surfaces. Before the fix, the client
 * POP used a different model (0/1/2-breakeven special cases, a hardcoded
 * 0.5 for 3+ breakevens, default rate 0.045, no dividend) and the client
 * risk engine carried its own flat IV/rate literals.
 */
import { describe, it, expect } from "vitest";
import { impliedProbabilityOfProfit, type StrategyLeg } from "../src/trading/options/strategyEngine";
import { calculateProbabilityOfProfit, blackScholes } from "../src/client/options/blackScholes";
import { blackScholesGreeks, probabilityOfProfit, RISK_MATH } from "../src/shared/riskMath";
import { computeRiskProfile } from "../src/client/options/riskManagementEngine";
import { getStrategyEngineConfig } from "../src/config/etapiConfig";

const SPOT = 100;
const DTE = 30;
const IV = 0.3;
const RATE = RISK_MATH.riskFreeRate;
const DIV = RISK_MATH.dividendYield;

function leg(partial: Partial<StrategyLeg>): StrategyLeg {
  return {
    symbol: "ACME",
    optionType: "CALL",
    side: "BUY",
    quantity: 1,
    strike: 100,
    expirationDate: "2026-11-14",
    daysToExpiration: DTE,
    entryPrice: 1,
    bid: 0.9,
    ask: 1.1,
    impliedVolatility: IV,
    delta: 0.5,
    gamma: 0.02,
    theta: -0.03,
    vega: 0.1,
    openInterest: 1000,
    multiplier: 100,
    ...partial,
  } as StrategyLeg;
}

describe("POP: server engine vs client surface", () => {
  it("agree on a long call (1 breakeven)", () => {
    const legs = [leg({ strike: 105, entryPrice: 3 })];
    const server = impliedProbabilityOfProfit(legs, [108], SPOT, 0, RATE, DIV);
    const client = calculateProbabilityOfProfit(SPOT, [108], { lowProfit: false, highProfit: true }, DTE / 365, IV, RATE, DIV);
    expect(client).toBeCloseTo(server, 9);
    expect(server).toBeGreaterThan(0);
    expect(server).toBeLessThan(1);
  });

  it("agree on an iron condor (2 breakevens)", () => {
    const legs = [
      leg({ optionType: "PUT", side: "SELL", strike: 95, entryPrice: 1.0 }),
      leg({ optionType: "PUT", side: "BUY", strike: 90, entryPrice: 0.4 }),
      leg({ optionType: "CALL", side: "SELL", strike: 105, entryPrice: 1.0 }),
      leg({ optionType: "CALL", side: "BUY", strike: 110, entryPrice: 0.4 }),
    ];
    const server = impliedProbabilityOfProfit(legs, [93.8, 106.2], SPOT, 0, RATE, DIV);
    const client = calculateProbabilityOfProfit(SPOT, [93.8, 106.2], { lowProfit: false, highProfit: false }, DTE / 365, IV, RATE, DIV);
    expect(client).toBeCloseTo(server, 9);
  });

  it("no longer returns the hardcoded 0.5 for 3+ breakevens, and matches the shared integrator", () => {
    const breakevens = [92, 104, 118];
    const client = calculateProbabilityOfProfit(SPOT, breakevens, { lowProfit: false, highProfit: true }, DTE / 365, IV, RATE, DIV);
    const shared = probabilityOfProfit({
      spot: SPOT,
      dteDays: DTE,
      volatility: IV,
      rate: RATE,
      dividend: DIV,
      breakevens,
      isProfitAt: (s) => (s > 92 && s < 104) || s > 118,
    });
    expect(client).toBeCloseTo(shared, 9);
    expect(client).not.toBe(0.5);
  });
});

describe("Black-Scholes: one implementation", () => {
  it("client blackScholes is the shared implementation, price and Greeks", () => {
    const client = blackScholes(100, 105, DTE / 365, IV, RATE, DIV, "CALL");
    const shared = blackScholesGreeks(100, 105, DTE / 365, IV, RATE, DIV, "CALL");
    expect(client).toEqual(shared);
    expect(client.price).toBeGreaterThan(1);
    expect(client.price).toBeLessThan(2.5);
    const put = blackScholes(100, 95, DTE / 365, IV, RATE, DIV, "PUT");
    expect(put.delta).toBeLessThan(0);
    expect(put.price).toBeGreaterThan(0);
  });
});

describe("constants: single source", () => {
  it("engine config default rate IS the shared constant", () => {
    expect(getStrategyEngineConfig().riskFreeRate).toBe(RISK_MATH.riskFreeRate);
  });

  it("client POP default rate is the shared constant (was 0.045)", () => {
    const withDefault = calculateProbabilityOfProfit(SPOT, [108], { lowProfit: false, highProfit: true }, DTE / 365, IV);
    const withShared = calculateProbabilityOfProfit(SPOT, [108], { lowProfit: false, highProfit: true }, DTE / 365, IV, RISK_MATH.riskFreeRate, RISK_MATH.dividendYield);
    expect(withDefault).toBe(withShared);
  });
});

describe("client risk anatomy consumes the same POP", () => {
  it("computes POP from legs via the shared method and labels it computed", () => {
    const profile = computeRiskProfile({
      title: "Long Call",
      underlyingSymbol: "ACME",
      underlyingPrice: SPOT,
      strategyType: "Long Call",
      dte: DTE,
      quantity: 1,
      breakevens: [108],
      legs: [
        { optionType: "CALL", side: "BUY", strike: 105, quantity: 1, entryPrice: 3, impliedVolatility: IV },
      ],
    });
    const server = impliedProbabilityOfProfit([leg({ strike: 105, entryPrice: 3 })], [108], SPOT, 0, RATE, DIV);
    expect(profile.anatomy.popSource).toBe("computed");
    expect(profile.anatomy.probabilityOfProfit).toBeCloseTo(server * 100, 0);
    expect(profile.anatomy.greeksSource).toBe("estimated"); // leg Greeks absent -> BS estimate, labeled
  });

  it("labels the leg-less placeholder POP as estimated, never engine-grade", () => {
    const profile = computeRiskProfile({
      title: "Bull Call Spread (flow print)",
      underlyingSymbol: "ACME",
      underlyingPrice: SPOT,
      strategyType: "Bull Call Spread",
      dte: DTE,
    });
    expect(profile.anatomy.popSource).toBe("estimated");
    expect(profile.anatomy.greeksSource).toBe("heuristic");
  });

  it("passes a provided (server) POP through untouched", () => {
    const profile = computeRiskProfile({
      title: "Long Call",
      underlyingSymbol: "ACME",
      underlyingPrice: SPOT,
      strategyType: "Long Call",
      dte: DTE,
      chanceOfProfit: 42.5,
      legs: [{ optionType: "CALL", side: "BUY", strike: 105, quantity: 1, entryPrice: 3, impliedVolatility: IV, delta: 0.4, gamma: 0.02, theta: -0.03, vega: 0.1 }],
      breakevens: [108],
    });
    expect(profile.anatomy.popSource).toBe("provided");
    expect(profile.anatomy.probabilityOfProfit).toBe(42.5);
    expect(profile.anatomy.greeksSource).toBe("legs");
  });
});
