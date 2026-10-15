/**
 * Issue #36 (G3): portfolio-aware position sizing.
 * Acceptance pins: identical candidates receive different sizing when the
 * current portfolio differs; every output names its binding constraint.
 */
import { describe, it, expect } from "vitest";
import { sizeCandidateAgainstPortfolio, type SizingCandidate } from "../src/services/positionSizing";
import type { PortfolioRiskReport, PortfolioRiskTotals } from "../src/services/portfolioRisk";

function totals(partial: Partial<PortfolioRiskTotals>): PortfolioRiskTotals {
  return {
    deltaShares: 0, deltaDollars: 0, betaWeightedDeltaDollars: 0, betaWeightedSpyShares: 0,
    gammaSharesPerDollar: 0, thetaDollarsPerDay: 0, vegaDollarsPerVolPoint: 0, rhoDollarsPerRatePoint: 0,
    definedMaxLoss: 0, definedMaxLossPctOfNav: 0,
    betaCoverage: { covered: 0, total: 0, computedLive: 0, staticFallback: 0 },
    ...partial,
  };
}

function report(t: PortfolioRiskTotals): PortfolioRiskReport {
  return { asOf: "2026-10-15T00:00:00.000Z", nav: 100000, spyPrice: 500, accountId: "acct-1", totals: t, rows: [], partial: [], excluded: [], undefinedRiskPositions: [] } as PortfolioRiskReport;
}

const candidate: SizingCandidate = {
  symbol: "ACME",
  perContract: { deltaDollars: 500, betaWeightedDeltaDollars: 600, definedMaxLoss: 200 },
  riskScore: 40, // standard band: 5% of NAV
};

describe("sizeCandidateAgainstPortfolio", () => {
  it("empty book: the NAV band binds (acceptance fixture A)", () => {
    const result = sizeCandidateAgainstPortfolio(report(totals({})), candidate);
    // band 5% * 100k = $5,000 / $200 = 25; delta budget allows 41; max-loss 50; concentration 30
    expect(result.recommendedContracts).toBe(25);
    expect(result.bindingConstraint).toBe("nav-band");
    expect(result.rationale).toContain("nav-band");
    expect(result.postTradeTotals.definedMaxLoss).toBe(5000);
  });

  it("loaded book: identical candidate, delta budget binds instead (acceptance fixture B)", () => {
    const loaded = report(totals({ betaWeightedDeltaDollars: 24000, deltaDollars: 24000 }));
    const result = sizeCandidateAgainstPortfolio(loaded, candidate);
    // headroom $1,000 / $600 = 1
    expect(result.recommendedContracts).toBe(1);
    expect(result.bindingConstraint).toBe("delta-budget");
  });

  it("max-loss budget binds when the book is already near it", () => {
    const nearLimit = report(totals({ definedMaxLoss: 9600 }));
    const small: SizingCandidate = { symbol: "ACME", perContract: { deltaDollars: 100, betaWeightedDeltaDollars: 100, definedMaxLoss: 200 }, riskScore: 10 };
    const result = sizeCandidateAgainstPortfolio(nearLimit, small);
    expect(result.recommendedContracts).toBe(2);
    expect(result.bindingConstraint).toBe("max-loss-budget");
  });

  it("never sizes an undefined-risk candidate", () => {
    const naked: SizingCandidate = { symbol: "ACME", perContract: { deltaDollars: 500, betaWeightedDeltaDollars: 600, definedMaxLoss: null } };
    const result = sizeCandidateAgainstPortfolio(report(totals({})), naked);
    expect(result.recommendedContracts).toBe(0);
    expect(result.bindingConstraint).toBe("undefined-risk");
  });

  it("requested quantity below every cap is the binding constraint", () => {
    const result = sizeCandidateAgainstPortfolio(report(totals({})), { ...candidate, requestedContracts: 3 });
    expect(result.recommendedContracts).toBe(3);
    expect(result.bindingConstraint).toBe("requested-quantity");
  });

  it("applies the correlation surcharge to the delta budget and labels the basis", () => {
    const book = report(totals({ betaWeightedDeltaDollars: 20000, deltaDollars: 20000 }));
    const corrCandidate: SizingCandidate = {
      symbol: "ACME",
      perContract: { deltaDollars: 500, betaWeightedDeltaDollars: 600, definedMaxLoss: 100 },
      riskScore: 10,
      maxMeasuredCorrelation: 0.9,
    };
    const withSurcharge = sizeCandidateAgainstPortfolio(book, corrCandidate);
    // headroom $5,000 / ($600 * 1.5) = 5
    expect(withSurcharge.correlationSurchargeApplied).toBe(true);
    expect(withSurcharge.recommendedContracts).toBe(5);
    expect(withSurcharge.bindingConstraint).toBe("delta-budget");

    const unweighted = sizeCandidateAgainstPortfolio(report(totals({ betaWeightedDeltaDollars: null })), {
      symbol: "ACME",
      perContract: { deltaDollars: 500, betaWeightedDeltaDollars: null, definedMaxLoss: 200 },
      riskScore: 40,
    });
    expect(unweighted.deltaBudgetBasis).toBe("unweighted (beta unavailable)");
  });
});
