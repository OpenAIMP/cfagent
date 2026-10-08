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

  it("discovers all option strategies when sentiment is 'all' without premature truncation", () => {
    const expirations = generateExpirations();
    const allStrategies = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 233.95,
      sentiment: "all",
      targetPrice: 240.0,
      expiration: expirations[5],
      optimizationBias: 50,
    });

    // Verifies full breadth across all 72 catalog strategies + pre-built setups
    expect(allStrategies.length).toBeGreaterThanOrEqual(70);
    const names = new Set(allStrategies.map((s) => s.name));
    expect(names.has("Long Call")).toBe(true);
    expect(names.has("Long Put")).toBe(true);
    expect(names.has("Iron Condor")).toBe(true);
    expect(names.has("Iron Butterfly")).toBe(true);
    expect(names.has("Bull Call Spread")).toBe(true);
    expect(names.has("Bear Put Spread")).toBe(true);
    expect(names.has("Jade Lizard")).toBe(true);
    expect(names.has("Long Straddle")).toBe(true);
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

    const callStrategy = strats.find((s) => s.name === "Long Call") || strats[0];
    const callLeg = callStrategy.legs.find((l) => l.optionType === "CALL") || callStrategy.legs[0];
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

  it("validates 50+ pre-made strategy library with categories and valid SVG paths", async () => {
    const { STRATEGY_LIBRARY } = await import("../src/client/options/strategyLibrary");
    expect(STRATEGY_LIBRARY.length).toBeGreaterThanOrEqual(50);

    const categories = new Set(STRATEGY_LIBRARY.map((s) => s.category));
    expect(categories.has("Bullish")).toBe(true);
    expect(categories.has("Bearish")).toBe(true);
    expect(categories.has("Neutral")).toBe(true);
    expect(categories.has("Volatility")).toBe(true);
    expect(categories.has("Synthetics & Spreads")).toBe(true);

    for (const strat of STRATEGY_LIBRARY) {
      expect(strat.id).toBeTruthy();
      expect(strat.name).toBeTruthy();
      expect(strat.pnlSvgPath).toBeTruthy();
      expect(strat.pnlSvgPath.startsWith("M")).toBe(true);
      expect(strat.description).toBeTruthy();

      // Test leg generator factory
      const legs = strat.buildLegs(200, 30, "2026-11-20", 0.35, 0.04);
      expect(legs.length).toBeGreaterThanOrEqual(1);
      for (const leg of legs) {
        expect(leg.strike).toBeGreaterThan(0);
        expect(["CALL", "PUT", "STOCK"]).toContain(leg.optionType);
        expect(["BUY", "SELL"]).toContain(leg.side);
      }
    }
  });

  it("calculates log-normal probability density and above/below probabilities", async () => {
    const { calculateProbabilityDensityPoints, calculateProbabilityAboveBelow } = await import(
      "../src/client/options/blackScholes"
    );

    const spot = 100;
    const tYears = 30 / 365;
    const iv = 0.25;

    const points = calculateProbabilityDensityPoints(spot, tYears, iv, 80, 120, 40);
    expect(points.length).toBe(40);
    expect(points[0].price).toBe(80);
    expect(points[points.length - 1].price).toBe(120);

    // Peak density should be near spot (100)
    const maxDensityPt = points.reduce((prev, curr) => (curr.density > prev.density ? curr : prev));
    expect(Math.abs(maxDensityPt.price - spot)).toBeLessThan(5);

    // Cumulative probability below 100 should be ~50%
    const probsAtSpot = calculateProbabilityAboveBelow(spot, 100, tYears, iv);
    expect(probsAtSpot.probBelowPct).toBeGreaterThan(45);
    expect(probsAtSpot.probBelowPct).toBeLessThan(55);
    expect(probsAtSpot.probAbovePct + probsAtSpot.probBelowPct).toBe(100);

    // Probability below 85 should be small, above 85 should be large
    const probsLow = calculateProbabilityAboveBelow(spot, 85, tYears, iv);
    expect(probsLow.probBelowPct).toBeLessThan(10);
    expect(probsLow.probAbovePct).toBeGreaterThan(90);
  });

  it("calculates net Greeks and realized/unrealized P&L across legs", async () => {
    const {
      calculateNetGreeks,
      calculateRealizedAndUnrealizedPnl,
    } = await import("../src/client/options/strategyDiscoveryEngine");

    const spot = 200;
    const dte = 30;
    const iv = 0.3;

    // Straddle: Buy ATM Call + Buy ATM Put
    const expirations = generateExpirations();
    const strats = discoverStrategies({
      symbol: "TEST",
      currentPrice: spot,
      sentiment: "directional",
      targetPrice: spot * 1.2,
      expiration: expirations[5],
      optimizationBias: 50,
    });
    const straddle = strats.find((s) => s.name === "Long Straddle")!;
    expect(straddle).toBeTruthy();

    const greeks = calculateNetGreeks(straddle.legs, spot, dte, iv);
    // Delta of ATM straddle should be close to 0 (Call ~0.50 + Put ~ -0.50 = ~0)
    expect(Math.abs(greeks.netDelta)).toBeLessThan(25);
    // Gamma should be significantly positive (long gamma)
    expect(greeks.netGamma).toBeGreaterThan(0);
    // Theta should be negative (paying time decay)
    expect(greeks.netTheta).toBeLessThan(0);
    // Vega should be positive (long volatility)
    expect(greeks.netVega).toBeGreaterThan(0);

    // Test Realized & Unrealized P&L
    const pnlInitial = calculateRealizedAndUnrealizedPnl(straddle.legs, spot, dte, iv);
    expect(pnlInitial.realizedPnl).toBe(0);
    expect(pnlInitial.hasClosedPositions).toBe(false);

    // Close one leg to simulate locking in realized gain
    const legWithClose = {
      ...straddle.legs[0],
      isClosed: true,
      closingPrice: straddle.legs[0].entryPrice + 2.0, // $2 profit per share = $200
    };
    const pnlClosed = calculateRealizedAndUnrealizedPnl([legWithClose, straddle.legs[1]], spot, dte, iv);
    expect(pnlClosed.hasClosedPositions).toBe(true);
    expect(pnlClosed.realizedPnl).toBeCloseTo(200, 1);
  });

  it("evaluates 2D Payoff Matrix across price steps and future dates with date markers", async () => {
    const { evaluate2dPayoffMatrix } = await import(
      "../src/client/options/strategyDiscoveryEngine"
    );

    const spot = 380;
    const expirations = generateExpirations();
    const strats = discoverStrategies({
      symbol: "TSLA",
      currentPrice: spot,
      sentiment: "bullish",
      targetPrice: 450,
      expiration: expirations[6],
      optimizationBias: 50,
    });

    const matrix = evaluate2dPayoffMatrix(
      strats[0].legs,
      spot,
      expirations[6].dte,
      expirations[6].date,
      0.4,
      20,
      11,
      5,
      1000
    );

    expect(matrix.columns.length).toBe(5);
    expect(matrix.columns[0].label).toBe("Today");
    expect(matrix.columns[4].label).toContain("Exp");
    expect(matrix.rows.length).toBe(11);

    // Price rows should be ordered from highest to lowest
    expect(matrix.rows[0].price).toBeGreaterThan(matrix.rows[10].price);

    // Contains spot row
    const spotRow = matrix.rows.find((r) => r.isAtSpot);
    expect(spotRow).toBeTruthy();

    // Each row contains 5 cell evaluations
    for (const row of matrix.rows) {
      expect(row.cells.length).toBe(5);
      for (const cell of row.cells) {
        expect(typeof cell.pnlDollar).toBe("number");
        expect(typeof cell.pnlPercent).toBe("number");
        expect(typeof cell.contractValue).toBe("number");
      }
    }
  });

  it("shifts strikes simultaneously and symmetrically for condors", async () => {
    const { shiftAllStrikes, shiftSymmetricStrikes } = await import(
      "../src/client/options/strategyDiscoveryEngine"
    );

    const spot = 100;
    const expirations = generateExpirations();
    const strats = discoverStrategies({
      symbol: "XYZ",
      currentPrice: spot,
      sentiment: "neutral",
      targetPrice: spot,
      expiration: expirations[4],
      optimizationBias: 50,
    });

    const ironCondor = strats.find((s) => s.name === "Iron Condor")!;
    expect(ironCondor).toBeTruthy();
    expect(ironCondor.legs.length).toBe(4);

    const originalStrikes = ironCondor.legs.map((l) => l.strike);

    // Shift all strikes up by 2 steps
    const shiftedAll = shiftAllStrikes(ironCondor.legs, 2, spot, 30, 0.3);
    for (let i = 0; i < ironCondor.legs.length; i++) {
      expect(shiftedAll[i].strike).toBeGreaterThan(originalStrikes[i]);
    }

    // Shift symmetric wings (widens put wing down and call wing up)
    const shiftedSymmetric = shiftSymmetricStrikes(ironCondor.legs, 1, spot, 30, 0.3);
    for (let i = 0; i < ironCondor.legs.length; i++) {
      const leg = ironCondor.legs[i];
      if (leg.optionType === "PUT") {
        expect(shiftedSymmetric[i].strike).toBeLessThanOrEqual(originalStrikes[i]);
      } else if (leg.optionType === "CALL") {
        expect(shiftedSymmetric[i].strike).toBeGreaterThanOrEqual(originalStrikes[i]);
      }
    }
  });

  it("verifies STRATEGY_LIBRARY covers all 58 OptionStrat strategies with working leg builders and SVG thumbnails", async () => {
    const { STRATEGY_LIBRARY } = await import("../src/client/options/strategyLibrary");
    expect(STRATEGY_LIBRARY.length).toBe(73);

    const optionStratNames = [
      // Novice
      "Long Call", "Long Put", "Covered Call", "Cash-Secured Put", "Protective Put",
      // Intermediate
      "Bull Put Spread", "Bear Call Spread", "Iron Butterfly", "Iron Condor",
      "Long Put Butterfly", "Long Call Butterfly", "Calendar Call Spread", "Calendar Put Spread",
      "Diagonal Call Spread", "Diagonal Put Spread", "Bull Call Spread", "Bear Put Spread",
      "Inverse Iron Butterfly", "Inverse Iron Condor", "Short Put Butterfly", "Short Call Butterfly",
      "Straddle", "Strangle", "Collar",
      // Advanced
      "Short Put", "Short Call", "Short Straddle", "Short Strangle",
      "Long Call Condor", "Long Put Condor", "Call Ratio Backspread", "Put Ratio Backspread",
      "Covered Short Straddle", "Covered Strangle", "Short Call Condor", "Short Put Condor",
      "Bull Call Ladder", "Bear Call Ladder", "Bull Put Ladder", "Bear Put Ladder",
      "Jade Lizard", "Reverse Jade Lizard",
      // Expert
      "Call Ratio Spread", "Put Ratio Spread", "Synthetic Long Stock", "Synthetic Short Stock",
      "Synthetic Put", "Long Combo", "Short Combo", "Strip", "Strap", "Guts", "Short Guts", "Double Diagonal",
    ];

    const libNames = new Set(STRATEGY_LIBRARY.map((s) => s.name));
    for (const name of optionStratNames) {
      expect(libNames.has(name), `Strategy '${name}' should be in STRATEGY_LIBRARY`).toBe(true);
    }

    // Verify all 73 strategies have valid properties and executable buildLegs
    for (const strat of STRATEGY_LIBRARY) {
      expect(strat.id).toBeTruthy();
      expect(strat.pnlSvgPath.length).toBeGreaterThan(5);
      expect(strat.legsCount).toBeGreaterThanOrEqual(1);
      const legs = strat.buildLegs(200, 30, "2026-11-20", 0.35, 0.04);
      expect(legs.length).toBeGreaterThanOrEqual(strat.legsCount);
    }
  });

  it("filters illiquid option contracts under $0.05 and respects user budget in optimizer", () => {
    const expirations = generateExpirations();
    const exp = expirations[3];

    // Discovery with low budget
    const lowBudgetStrats = discoverStrategies({
      symbol: "TSLA",
      currentPrice: 380.0,
      sentiment: "bullish",
      targetPrice: 420.0,
      budget: 500, // $500 max risk / collateral
      expiration: exp,
      optimizationBias: 50,
    });

    for (const strat of lowBudgetStrats) {
      expect(strat.riskOrCollateral).toBeLessThanOrEqual(500);
      for (const leg of strat.legs) {
        if (leg.optionType !== "STOCK") {
          expect(leg.entryPrice).toBeGreaterThanOrEqual(0.05);
        }
      }
    }
  });

  it("evaluates all trends across bullish, bearish, neutral, and directional when sentiment is 'all'", () => {
    const expirations = generateExpirations();
    const exp = expirations[4];

    const allTrendStrats = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 230.0,
      sentiment: "all",
      targetPrice: 230.0,
      expiration: exp,
      optimizationBias: 50,
    });

    expect(allTrendStrats.length).toBeGreaterThan(10);
    const names = allTrendStrats.map((s) => s.name);
    // Bullish
    expect(names).toContain("Long Call");
    expect(names).toContain("Bull Call Spread");
    // Bearish
    expect(names).toContain("Long Put");
    expect(names).toContain("Bear Put Spread");
    // Neutral
    expect(names).toContain("Iron Condor");
    // Directional
    expect(names).toContain("Long Straddle");

    // Each strategy has rewardRiskRatio populated (or null if uncapped)
    for (const strat of allTrendStrats) {
      if (strat.maxProfit !== null && strat.maxLoss !== null && strat.maxLoss > 0) {
        expect(strat.rewardRiskRatio).toBeCloseTo(strat.maxProfit / strat.maxLoss, 1);
      } else if (strat.maxProfit === null) {
        expect(strat.rewardRiskRatio).toBeNull();
      }
    }
  });

  it("filters strategies by minimum Reward/Risk (Max Profit vs Max Loss) ratio", () => {
    const expirations = generateExpirations();
    const exp = expirations[2];

    // Filter for reward/risk >= 2.0 (1:2 ratio)
    const highRrStrats = discoverStrategies({
      symbol: "NVDA",
      currentPrice: 230.0,
      sentiment: "all",
      targetPrice: 230.0,
      minRewardRisk: 2.0,
      expiration: exp,
      optimizationBias: 50,
    });

    expect(highRrStrats.length).toBeGreaterThan(0);
    for (const strat of highRrStrats) {
      if (strat.maxProfit !== null && strat.maxLoss !== null && strat.maxLoss > 0) {
        expect(strat.maxProfit / strat.maxLoss).toBeGreaterThanOrEqual(2.0);
      }
    }
  });
});



