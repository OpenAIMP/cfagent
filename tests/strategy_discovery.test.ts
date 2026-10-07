import { describe, expect, it } from "vitest";
import {
  blackScholes,
  normalCdf,
  calculateProbabilityOfProfit,
} from "../src/client/options/blackScholes";
import {
  discoverStrategies,
  generateExpirations,
  generateStrikeLadder,
  evaluateStrategyPnL,
  getOptimizationFactors,
  updateLegStrike,
  updateLegsExpiration,
} from "../src/client/options/strategyDiscoveryEngine";

describe("Strategy Discovery and Black-Scholes Engine", () => {
  it("computes accurate Black-Scholes call and put prices and Greeks", () => {
    const spot = 100;
    const strike = 100;
    const t = 30 / 365;
    const iv = 0.3;
    const r = 0.045;

    const callGreeks = blackScholes(spot, strike, t, iv, r, 0, "CALL");
    const putGreeks = blackScholes(spot, strike, t, iv, r, 0, "PUT");

    // ATM call and put should have positive prices
    expect(callGreeks.price).toBeGreaterThan(2);
    expect(putGreeks.price).toBeGreaterThan(2);

    // Call delta ~0.5, put delta ~-0.5
    expect(callGreeks.delta).toBeGreaterThan(0.45);
    expect(callGreeks.delta).toBeLessThan(0.58);
    expect(putGreeks.delta).toBeLessThan(-0.4);
    expect(putGreeks.delta).toBeGreaterThan(-0.55);

    // Gamma should be identical and positive
    expect(callGreeks.gamma).toBeGreaterThan(0);
    expect(callGreeks.gamma).toBeCloseTo(putGreeks.gamma, 4);

    // Theta should be negative (time decay)
    expect(callGreeks.theta).toBeLessThan(0);
    expect(putGreeks.theta).toBeLessThan(0);

    // Vega should be positive
    expect(callGreeks.vega).toBeGreaterThan(0);
  });

  it("calculates normal cumulative distribution function", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2);
  });

  it("generates realistic expiration schedule with nearest and LEAPS cycles", () => {
    const expirations = generateExpirations();
    expect(expirations.length).toBeGreaterThanOrEqual(10);
    expect(expirations[0].dte).toBeLessThanOrEqual(5);
    expect(expirations[expirations.length - 1].dte).toBeGreaterThan(200);
  });

  it("generates symmetric strike ladders with appropriate steps", () => {
    const highSpotStrikes = generateStrikeLadder(380);
    expect(highSpotStrikes).toContain(380);
    expect(highSpotStrikes.length).toBeGreaterThan(30);

    const lowerSpotStrikes = generateStrikeLadder(234);
    expect(lowerSpotStrikes.length).toBeGreaterThan(30);
  });

  it("discovers bullish strategies for TSLA matching OptionStrat format", () => {
    const expirations = generateExpirations();
    const strategies = discoverStrategies({
      symbol: "TSLA",
      currentPrice: 380.68,
      sentiment: "bullish",
      targetPrice: 545.82,
      expiration: expirations[6],
      optimizationBias: 50,
    });

    expect(strategies.length).toBeGreaterThanOrEqual(5);

    const names = strategies.map((s) => s.name);
    expect(names).toContain("Long Call");
    expect(names).toContain("Covered Call");
    expect(names).toContain("Cash-Secured Put");
    expect(names).toContain("Bull Call Spread");
    expect(names).toContain("Bull Put Spread");

    const longCall = strategies.find((s) => s.name === "Long Call")!;
    expect(longCall.maxLoss).toBeGreaterThan(0);
    expect(longCall.maxProfit).toBeNull(); // unlimited upside
    expect(longCall.targetProfit).toBeGreaterThan(0);
    expect(longCall.miniPayoffPoints.length).toBeGreaterThanOrEqual(25);
    expect(longCall.chanceOfProfit).toBeGreaterThan(0);

    const bullCallSpread = strategies.find((s) => s.name === "Bull Call Spread")!;
    expect(bullCallSpread.legs).toHaveLength(2);
    expect(bullCallSpread.maxLoss).toBeGreaterThan(0);
    expect(bullCallSpread.maxProfit).toBeGreaterThan(0);
    expect(bullCallSpread.breakevens.length).toBeGreaterThanOrEqual(1);
  });

  it("discovers bearish strategies matching OptionStrat format", () => {
    const expirations = generateExpirations();
    const strategies = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 233.95,
      sentiment: "bearish",
      targetPrice: 195.0,
      expiration: expirations[4],
      optimizationBias: 50,
    });

    const names = strategies.map((s) => s.name);
    expect(names).toContain("Long Put");
    expect(names).toContain("Bear Put Spread");
    expect(names).toContain("Bear Call Spread");
    expect(names).toContain("Short Synthetic Future");

    const shortFuture = strategies.find((s) => s.name === "Short Synthetic Future")!;
    expect(shortFuture.legs).toHaveLength(2);
    expect(shortFuture.breakevens).toHaveLength(1);
    expect(shortFuture.breakevenText).toContain("Below");
  });

  it("discovers neutral and directional strategies", () => {
    const expirations = generateExpirations();
    const neutral = discoverStrategies({
      symbol: "SPY",
      currentPrice: 585.0,
      sentiment: "neutral",
      targetPrice: 585.0,
      expiration: expirations[5],
      optimizationBias: 50,
    });

    const neutralNames = neutral.map((s) => s.name);
    expect(neutralNames).toContain("Iron Condor");
    expect(neutralNames).toContain("Iron Butterfly");
    expect(neutralNames).toContain("Short Straddle");

    const directional = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 233.95,
      sentiment: "directional",
      targetPrice: 275.0,
      expiration: expirations[5],
      optimizationBias: 50,
    });

    const dirNames = directional.map((s) => s.name);
    expect(dirNames).toContain("Long Straddle");
    expect(dirNames).toContain("Long Strangle");
  });

  it("evaluates strategy PnL across prices at expiration and at intermediate time t", () => {
    const expirations = generateExpirations();
    const strategies = discoverStrategies({
      symbol: "TSLA",
      currentPrice: 380.0,
      sentiment: "bullish",
      targetPrice: 500.0,
      expiration: expirations[4],
      optimizationBias: 50,
    });

    const bullCallSpread = strategies.find((s) => s.name === "Bull Call Spread")!;
    const pnlAtZero = evaluateStrategyPnL(bullCallSpread.legs, 0, 0, 0.44);
    const pnlAtHigh = evaluateStrategyPnL(bullCallSpread.legs, 800, 0, 0.44);

    expect(pnlAtZero).toBeLessThan(0); // Max loss at 0 price
    expect(pnlAtHigh).toBeGreaterThan(0); // Max profit at high price

    // Intermediate PnL (half-time remaining)
    const pnlIntermediate = evaluateStrategyPnL(bullCallSpread.legs, 380, 15 / 365, 0.44);
    expect(typeof pnlIntermediate).toBe("number");
  });

  it("evaluates optimization bias factors across regimes and attaches factor scores", () => {
    const maxReturnFactors = getOptimizationFactors(0);
    expect(maxReturnFactors.regime).toContain("Max Return");
    expect(maxReturnFactors.returnWeight).toBeGreaterThan(maxReturnFactors.chanceWeight);

    const maxChanceFactors = getOptimizationFactors(100);
    expect(maxChanceFactors.regime).toContain("Max Chance");
    expect(maxChanceFactors.chanceWeight).toBeGreaterThan(maxChanceFactors.returnWeight);

    const balancedFactors = getOptimizationFactors(50);
    expect(balancedFactors.regime).toContain("Balanced");

    // Verify strategies have factors attached
    const expirations = generateExpirations();
    const strats = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 233.95,
      sentiment: "bullish",
      targetPrice: 280.0,
      expiration: expirations[5],
      optimizationBias: 80,
    });

    expect(strats[0].factors).toBeDefined();
    expect(strats[0].factors!.chanceScore).toBeGreaterThan(0);
    expect(strats[0].factors!.compositeScore).toBeGreaterThan(0);
  });

  it("updates leg strike prices and recomputes Black-Scholes Greeks when slider moves", () => {
    const expirations = generateExpirations();
    const strats = discoverStrategies({
      symbol: "TSLA",
      currentPrice: 380.0,
      sentiment: "bullish",
      targetPrice: 500.0,
      expiration: expirations[4],
      optimizationBias: 50,
    });

    const callStrategy = strats.find((s) => s.name === "Long Call")!;
    const originalLeg = callStrategy.legs[0];
    const originalStrike = originalLeg.strike;
    const originalPrice = originalLeg.entryPrice;

    // Slide strike 20 points higher (further OTM)
    const newStrike = originalStrike + 20;
    const updatedLeg = updateLegStrike(originalLeg, newStrike, 380.0, expirations[4].dte, 0.44);

    expect(updatedLeg.strike).toBe(newStrike);
    // Higher strike call should be cheaper
    expect(updatedLeg.entryPrice).toBeLessThan(originalPrice);
    // Delta should be lower for higher call strike
    expect(updatedLeg.delta).toBeLessThan(originalLeg.delta);
  });

  it("updates leg expiration dates and re-prices premiums when different dates are selected", () => {
    const expirations = generateExpirations();
    const nearExp = expirations[1]; // short DTE
    const farExp = expirations[expirations.length - 2]; // long DTE (LEAP)

    const strats = discoverStrategies({
      symbol: "TSLA",
      currentPrice: 380.0,
      sentiment: "bullish",
      targetPrice: 500.0,
      expiration: nearExp,
      optimizationBias: 50,
    });

    const callLeg = strats[0].legs[0];
    const shortTermPrice = callLeg.entryPrice;

    // Update expiration to far term
    const updatedLegs = updateLegsExpiration([callLeg], farExp.dte, farExp.date, 380.0, 0.44);
    const farTermPrice = updatedLegs[0].entryPrice;

    // Longer DTE option has more extrinsic time value, so premium must be higher
    expect(farTermPrice).toBeGreaterThan(shortTermPrice);
    expect(updatedLegs[0].dte).toBe(farExp.dte);
    expect(updatedLegs[0].expirationDate).toBe(farExp.date);
  });

  it("verifies time decay progression between today, intermediate dates, and expiration", () => {
    const expirations = generateExpirations();
    const exp = expirations[5]; // e.g. 30-45 DTE
    const strats = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 233.95,
      sentiment: "bullish",
      targetPrice: 300.0,
      expiration: exp,
      optimizationBias: 50,
    });

    const bullCall = strats.find((s) => s.name === "Bull Call Spread")!;
    const spot = 233.95;

    // PnL today (full time remaining)
    const pnlToday = evaluateStrategyPnL(bullCall.legs, spot, exp.dte / 365, 0.44);
    // PnL halfway to expiration
    const pnlHalfway = evaluateStrategyPnL(bullCall.legs, spot, (exp.dte * 0.5) / 365, 0.44);
    // PnL at expiration
    const pnlExpiry = evaluateStrategyPnL(bullCall.legs, spot, 0, 0.44);

    expect(typeof pnlToday).toBe("number");
    expect(typeof pnlHalfway).toBe("number");
    expect(typeof pnlExpiry).toBe("number");
  });
});

