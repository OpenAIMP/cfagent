import { describe, it, expect } from "vitest";
import {
  computeRiskProfile,
  type RiskSubject,
} from "../src/client/options/riskManagementEngine";

describe("Institutional Risk Management Engine Suite", () => {
  describe("Defined Risk Debit Spreads", () => {
    it("computes comprehensive risk anatomy and defense rules for a Bull Call Spread", () => {
      const subject: RiskSubject = {
        title: "Bull Call Spread",
        underlyingSymbol: "NVDA",
        underlyingPrice: 125.0,
        strategyType: "Bull Call Spread",
        sentiment: "bullish",
        expirationDate: "2026-11-20",
        dte: 30,
        quantity: 1,
        netDebit: 3.5,
        maxProfit: 650,
        maxLoss: 350,
        chanceOfProfit: 58,
        breakevens: [128.5],
        legs: [
          { side: "BUY", strike: 125, optionType: "CALL", quantity: 1, entryPrice: 6.0, delta: 0.52, gamma: 0.025, theta: -0.06, vega: 0.15 },
          { side: "SELL", strike: 135, optionType: "CALL", quantity: 1, entryPrice: 2.5, delta: 0.28, gamma: 0.018, theta: -0.04, vega: 0.11 },
        ],
      };

      const profile = computeRiskProfile(subject);

      // Anatomy checks
      expect(profile.anatomy.riskProfileType).toBe("DEFINED_RISK");
      expect(profile.anatomy.capitalAtRisk).toBe(350);
      expect(profile.anatomy.capitalAtRiskFormatted).toBe("$350.00");
      expect(profile.anatomy.maxProfitFormatted).toBe("$650.00");
      expect(profile.anatomy.directionalBias).toBe("BULLISH");
      expect(profile.anatomy.netDelta).toBeCloseTo(0.24, 2);
      expect(profile.anatomy.dollarDelta).toBeCloseTo(24, 1);
      expect(profile.anatomy.probabilityOfProfit).toBe(58);
      expect(profile.anatomy.breakevens).toHaveLength(1);
      expect(profile.anatomy.breakevens[0].price).toBe(128.5);
      expect(profile.anatomy.breakevens[0].direction).toBe("ABOVE");
      expect(profile.anatomy.breakevens[0].distancePct).toBeGreaterThan(0);

      // Playbook checks
      expect(profile.playbook.profitTakingRule.targetPct).toBe(75);
      expect(profile.playbook.stopLossRule.stopLossThreshold).toContain("50% Premium Loss");
      expect(profile.playbook.adjustments.length).toBeGreaterThanOrEqual(2);
      expect(profile.playbook.adjustments.some((a) => a.name.includes("Butterfly") || a.name.includes("Calendar"))).toBe(true);

      // Sizing calculation checks
      const contractsFor25k = profile.playbook.recommendedMaxContracts(25000);
      expect(contractsFor25k).toBeGreaterThan(0);

      // Multi-point Stress Test Scenario Matrix
      expect(profile.scenarioMatrix).toHaveLength(7);
      const spotRow = profile.scenarioMatrix.find((p) => p.spotChangePct === 0);
      expect(spotRow).toBeDefined();
      expect(spotRow?.spotPrice).toBe(125.0);

      // AI Prompt formatting
      expect(profile.playbook.aiPrompt).toContain("NVDA");
      expect(profile.playbook.aiPrompt).toContain("Bull Call Spread");
      expect(profile.playbook.aiPrompt).toContain("Spot: $125.00");
    });
  });

  describe("Credit Spreads and Iron Condors", () => {
    it("computes risk profile and rolling defense adjustments for an Iron Condor", () => {
      const subject: RiskSubject = {
        title: "Iron Condor",
        underlyingSymbol: "SPY",
        underlyingPrice: 580.0,
        strategyType: "Iron Condor",
        sentiment: "neutral",
        expirationDate: "2026-11-15",
        dte: 45,
        quantity: 2,
        netDebit: -2.1, // Net credit 2.10
        maxProfit: 420,
        maxLoss: 580,
        chanceOfProfit: 72,
        breakevens: [567.9, 592.1],
        legs: [
          { side: "BUY", strike: 565, optionType: "PUT", quantity: 2, delta: -0.12 },
          { side: "SELL", strike: 570, optionType: "PUT", quantity: 2, delta: -0.22 },
          { side: "SELL", strike: 590, optionType: "CALL", quantity: 2, delta: 0.22 },
          { side: "BUY", strike: 595, optionType: "CALL", quantity: 2, delta: 0.12 },
        ],
      };

      const profile = computeRiskProfile(subject);

      expect(profile.anatomy.riskProfileType).toBe("DEFINED_RISK");
      expect(profile.anatomy.directionalBias).toBe("NEUTRAL");
      expect(profile.anatomy.capitalAtRisk).toBe(580);
      expect(profile.anatomy.probabilityOfProfit).toBe(72);
      expect(profile.anatomy.breakevens).toHaveLength(2);

      // Credit spread rules
      expect(profile.playbook.profitTakingRule.targetPct).toBe(50);
      expect(profile.playbook.stopLossRule.stopLossThreshold).toContain("2.0x Net Credit Received");

      // Iron Condor tactical adjustments
      const rollUntested = profile.playbook.adjustments.find((a) => a.name.includes("Roll Untested Wing"));
      expect(rollUntested).toBeDefined();
      expect(rollUntested?.action).toContain("Close unchallenged spread and re-open");

      const rollDuration = profile.playbook.adjustments.find((a) => a.name.includes("Roll Tested Spread Out in Time"));
      expect(rollDuration).toBeDefined();
    });
  });

  describe("Undefined Risk & Early Assignment Tail Hazards", () => {
    it("flags undefined risk and extreme margin penalty for naked short options", () => {
      const subject: RiskSubject = {
        title: "Short Put (Naked)",
        underlyingSymbol: "TSLA",
        underlyingPrice: 380.0,
        strategyType: "Naked Put",
        sentiment: "bullish",
        expirationDate: "2026-10-18",
        dte: 10,
        quantity: 1,
        netDebit: -8.5,
        maxProfit: 850,
        maxLoss: null, // Unlimited
        chanceOfProfit: 82,
        breakevens: [371.5],
        legs: [
          { side: "SELL", strike: 380, optionType: "PUT", quantity: 1, entryPrice: 8.5 },
        ],
      };

      const profile = computeRiskProfile(subject);

      expect(profile.anatomy.riskProfileType).toBe("UNDEFINED_RISK");
      expect(profile.anatomy.capitalAtRiskFormatted).toContain("Full Assignment Downside");
      expect(profile.anatomy.riskScore).toBeGreaterThanOrEqual(75);
      expect(["HIGH", "EXTREME"]).toContain(profile.anatomy.riskLevel);
      expect(profile.playbook.recommendedMaxAllocationPct).toBeLessThanOrEqual(2.0);
    });

    it("detects American-style early assignment warning on ITM short call near expiration", () => {
      const subject: RiskSubject = {
        title: "Short ITM Call",
        underlyingSymbol: "AAPL",
        underlyingPrice: 240.0,
        strategyType: "Bear Call Spread",
        expirationDate: "2026-10-12",
        dte: 4,
        legs: [
          { side: "SELL", strike: 235.0, optionType: "CALL", quantity: 1 }, // ITM short call (spot 240 > strike 235)
          { side: "BUY", strike: 245.0, optionType: "CALL", quantity: 1 },
        ],
      };

      const profile = computeRiskProfile(subject);

      expect(profile.anatomy.earlyAssignmentRisk.hasRisk).toBe(true);
      expect(["HIGH", "MODERATE"]).toContain(profile.anatomy.earlyAssignmentRisk.severity);
      expect(profile.anatomy.earlyAssignmentRisk.reasons.some((r) => r.includes("Short Call Strike $235.00 is currently In-The-Money"))).toBe(true);
    });
  });

  describe("Equity Holdings & Brokerage Ledger Trades", () => {
    it("computes equity risk anatomy, dollar delta, and protective collar playbook for share positions", () => {
      const subject: RiskSubject = {
        title: "100 shares of NVDA",
        underlyingSymbol: "NVDA",
        underlyingPrice: 130.0,
        strategyType: "Long Equity Position",
        sentiment: "bullish",
        quantity: 100,
        positionType: "EQUITY",
        costBasis: 120.0,
        unrealizedPnL: 1000.0,
      };

      const profile = computeRiskProfile(subject);

      expect(profile.anatomy.riskProfileType).toBe("EQUITY_RISK");
      expect(profile.anatomy.capitalAtRisk).toBe(13000);
      expect(profile.anatomy.dollarDelta).toBe(13000);
      expect(profile.anatomy.netDelta).toBe(100);
      expect(profile.playbook.profitTakingRule.targetPct).toBe(15);
      expect(profile.playbook.stopLossRule.stopLossThreshold).toContain("-7.0% Drawdown");

      // Hedging adjustments for long stock
      expect(profile.playbook.adjustments.some((a) => a.name.includes("Covered Call"))).toBe(true);
      expect(profile.playbook.adjustments.some((a) => a.name.includes("Protective Collar"))).toBe(true);

      // Tail shocks on equities
      expect(profile.anatomy.tailShockDown10Pct).toBe(-1300);
      expect(profile.anatomy.tailShockDown20Pct).toBe(-2600);
      expect(profile.anatomy.tailShockUp10Pct).toBe(1300);
    });
  });
});
