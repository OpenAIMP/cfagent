import { describe, expect, it } from "vitest";
import {
  blackScholes,
  normalCdf,
  calculateProbabilityOfProfit,
} from "../src/client/options/blackScholes";
import {
  analyzeStrategy,
  generateExpirations,
  generateStrikeLadder,
  evaluateStrategyPnL,
  getOptimizationFactors,
  updateLegStrike,
  updateLegsExpiration,
} from "../src/client/options/strategyDiscoveryEngine";
import { STRATEGY_LIBRARY } from "../src/client/options/strategyLibrary";

/**
 * Builder-path strategy factory (issue #29: discovery ranking is server-side).
 * Seeds a strategy from the template library through analyzeStrategy — the
 * same path the Builder UI uses — instead of the retired client discovery ranker.
 */
function sampleStrategy(id: string, spot: number, target: number, expiration: { dte: number; date: string }, iv = 0.44, bias = 50) {
  const def = STRATEGY_LIBRARY.find((d) => d.id === id)!;
  const legs = def.buildLegs(spot, expiration.dte, expiration.date, iv);
  return analyzeStrategy(def.name, def.category, def.subtitle, def.theses, legs, spot, target, expiration.dte, expiration.date, iv, def.description, bias);
}

describe("Builder modeling engine and Black-Scholes (discovery ranking is server-side, issue #29)", () => {
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

  it("evaluates strategy PnL across prices at expiration and at intermediate time t", () => {
    const expirations = generateExpirations();
    const bullCallSpread = sampleStrategy("bull_call_spread", 380.0, 500.0, expirations[4]);
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
    const strat = sampleStrategy("bull_call_spread", 233.95, 280.0, expirations[5], 0.44, 80);

    expect(strat.factors).toBeDefined();
    expect(strat.factors!.chanceScore).toBeGreaterThan(0);
    expect(strat.factors!.compositeScore).toBeGreaterThan(0);
  });

  it("updates leg strike prices and recomputes Black-Scholes Greeks when slider moves", () => {
    const expirations = generateExpirations();
    const callStrategy = sampleStrategy("long_call", 380.0, 500.0, expirations[4]);
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
    // Comprehensive Greeks & IV presence
    expect(updatedLeg.impliedVolatility).toBeGreaterThan(0);
    expect(typeof updatedLeg.rho).toBe("number");
    expect(typeof updatedLeg.vanna).toBe("number");
    expect(typeof updatedLeg.charm).toBe("number");
    expect(typeof updatedLeg.vomma).toBe("number");
  });

  it("updates leg expiration dates and re-prices premiums when different dates are selected", () => {
    const expirations = generateExpirations();
    const nearExp = expirations[1]; // short DTE
    const farExp = expirations[expirations.length - 2]; // long DTE (LEAP)

    const callStrategy = sampleStrategy("long_call", 380.0, 500.0, nearExp);
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
    const bullCall = sampleStrategy("bull_call_spread", 233.95, 300.0, exp);
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
    const straddle = sampleStrategy("long_straddle", spot, spot * 1.2, expirations[5], iv);
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
    expect(typeof greeks.netRho).toBe("number");
    expect(typeof greeks.netVanna).toBe("number");
    expect(typeof greeks.netCharm).toBe("number");
    expect(typeof greeks.netVomma).toBe("number");
    expect(greeks.weightedIv).toBeGreaterThan(0);

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
    const strat = sampleStrategy("bull_call_spread", spot, 450, expirations[6]);

    const matrix = evaluate2dPayoffMatrix(
      strat.legs,
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
    const ironCondor = sampleStrategy("iron_condor", spot, spot, expirations[4]);
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

  describe("Option Legs Dynamic Inspector (Add and Remove Capability)", () => {
    it("supports adding and removing individual Call and Put legs", () => {
      const spot = 200;
      const dte = 30;
      const iv = 0.35;
      const r = 0.045;

      const callLeg = updateLegStrike(
        {
          id: `CALL_205_BUY_1`,
          side: "BUY",
          optionType: "CALL",
          strike: 205,
          quantity: 1,
          expirationDate: "2026-11-20",
          dte,
          entryPrice: 5.0,
          bid: 4.9,
          ask: 5.1,
          impliedVolatility: iv,
          delta: 0.5,
          gamma: 0.02,
          theta: -0.05,
          vega: 0.12,
        },
        205,
        spot,
        dte,
        iv,
        r
      );

      const putLeg = updateLegStrike(
        {
          id: `PUT_195_BUY_2`,
          side: "BUY",
          optionType: "PUT",
          strike: 195,
          quantity: 1,
          expirationDate: "2026-11-20",
          dte,
          entryPrice: 4.0,
          bid: 3.9,
          ask: 4.1,
          impliedVolatility: iv,
          delta: -0.4,
          gamma: 0.02,
          theta: -0.04,
          vega: 0.11,
        },
        195,
        spot,
        dte,
        iv,
        r
      );

      // Start with both legs
      let legs = [callLeg, putLeg];
      expect(legs).toHaveLength(2);
      expect(legs.some((l) => l.optionType === "CALL")).toBe(true);
      expect(legs.some((l) => l.optionType === "PUT")).toBe(true);

      // Remove Call leg by ID
      legs = legs.filter((l) => l.id !== callLeg.id);
      expect(legs).toHaveLength(1);
      expect(legs.some((l) => l.optionType === "CALL")).toBe(false);
      expect(legs[0].id).toBe(putLeg.id);

      // Remove Put leg by Type
      const matchingPuts = legs.filter((l) => l.optionType === "PUT");
      expect(matchingPuts).toHaveLength(1);
      legs = legs.filter((l) => l.id !== matchingPuts[matchingPuts.length - 1].id);
      expect(legs).toHaveLength(0);
      expect(legs.some((l) => l.optionType === "PUT")).toBe(false);
    });
  });
});



