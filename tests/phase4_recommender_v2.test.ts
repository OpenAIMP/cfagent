/**
 * Issue #1135 (Phase 4 of epic #1096) — Recommendation Bundle (Best Trade v2).
 *
 * Pins PLAN.md §3.4: a recommendation is a BUNDLE, never a bare trade:
 *  (1) trade priced by researchEconomics + Phase 1 scenario grid;
 *  (2) falsification record — a bundle without one cannot be Qualified,
 *      and the recommendationAgent honesty/confidence caps (incl. the
 *      #534 no-view caps) survive into the bundle;
 *  (3) post-trade portfolio state via the #34 evaluate path;
 *  (4) optimizer: sizing via #36, scenario mean/CVaR objective, explicit
 *      improves/worsens verdict with evidence, concentration/correlation
 *      impact from #35;
 *  (5) hedging plan on a stated budget breach, built by hedgeProposals
 *      (#54) and ranked by cost vs risk removed;
 *  (6) repair options ranked by cost vs risk removed, carrying the #355
 *      proposals' honest limits verbatim;
 *  (7) alternatives including an explicit no-trade alternative — and the
 *      bundle decision itself can be no_trade.
 * Persistence rides the existing mas_outcomes store (no new table).
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { aggregatePortfolioRisk, type ResolvedPosition } from "../src/services/portfolioRisk";
import { buildScenario } from "../src/services/goalScenarioEngine";
import { createGoal, listOutcomes } from "../src/services/goalScenarioStore";
import {
  buildRecommendationBundle,
  formatRecommendationBundleReport,
  persistRecommendationBundle,
  researchLegsFromStrategyLegs,
  type BundleCandidateInput,
} from "../src/services/recommendationBundle";
import type { StrategyCandidate, StrategyLeg } from "../src/trading/options/strategyEngine";
import type { FalsificationInput } from "../src/services/researchFalsification";
import type { RepairProposal } from "../src/services/repairProposals";

/* ---------------- fixtures ---------------- */

const AS_OF = "2026-10-23T00:00:00.000Z";

function bookReport(nav = 200_000) {
  const resolved: ResolvedPosition[] = [{
    position: {
      symbol: "AAPL", description: "Common Stock", quantity: 50, pricePaid: 180,
      costBasis: 9_000, currentPrice: 200, marketPrice: 200, marketValue: 10_000,
      totalGain: 2_000, unrealizedGainLoss: 2_000, totalGainPercent: 11,
      unrealizedGainLossPercent: 11, daysGain: 0, daysGainPercent: 0,
      securityType: "EQ", positionType: "LONG",
    } as any,
    kind: "equity", signedQuantity: 50, referencePrice: 200,
    greeks: { delta: 1, gamma: 0, theta: 0, vega: 0, rho: 0 },
    beta: 1.2, betaSource: "computed-live", betaObservations: 252,
  }];
  return aggregatePortfolioRisk(resolved, { nav, spyPrice: 500, asOf: AS_OF });
}

function leg(partial: Partial<StrategyLeg>): StrategyLeg {
  return {
    symbol: "XYZ", optionType: "CALL", side: "BUY", quantity: 1, strike: 200,
    expirationDate: "2026-11-22", daysToExpiration: 30, entryPrice: 5, bid: 4.8, ask: 5.2,
    impliedVolatility: 0.3, delta: 0.5, gamma: 0.02, theta: -0.03, vega: 0.05,
    openInterest: 5_000, volume: 1_000, spreadPct: 0.08,
    quoteTimestamp: AS_OF, quoteFreshness: "FRESH", multiplier: 100,
    ...partial,
  };
}

function candidate(partial: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: "cand-spread", rank: 1, type: "bull_call_spread" as any, label: "XYZ 200/210 bull call spread",
    symbol: "XYZ", underlyingPrice: 200, expirationDate: "2026-11-22", dataFreshness: "FRESH",
    legs: [leg({ entryPrice: 2, bid: 1.8, ask: 2.2 })],
    netDebit: 2, estimatedFees: 2, maxProfit: null, maxProfitUnbounded: true, maxLoss: 200,
    breakevens: [203], targetPnl: 300, targetRewardRisk: 1, modelImpliedProbabilityOfProfit: 0.45,
    netGreeks: { delta: 0.5, gamma: 0.02, theta: -0.02, vega: 0.05 },
    liquidityScore: 80, score: 70, scoreBreakdown: {} as any, payoffCurve: [], scenarios: [],
    explanations: [], warnings: [], assumptions: [],
    ...partial,
  };
}

const FALSIFICATION: FalsificationInput = {
  symbol: "XYZ", outlook: "bullish", thesis: "XYZ breaks out on volume expansion.",
  supportingEvidence: ["rising relative strength vs sector", "earnings beat with raised guidance"],
  contradictingEvidence: ["IV is elevated into the event", "sector breadth is weakening"],
  resolutionTrigger: "product event on 2026-11-01", horizon: "30 DTE",
  invalidation: "Close below 190 on volume", whyThisStructure: "Defined-risk spread caps event gap loss vs shares.",
};

function scenario(constraints = {}) {
  return buildScenario({
    goalKind: "directional", portfolioRef: { kind: "real" },
    shocks: { pricePct: [-10, 0, 10], ivShift: [0], daysForward: [30] },
    constraints: { budget: 50_000, maxLoss: 50_000, ...constraints },
  });
}

function bundleInput(partial: Record<string, unknown> = {}) {
  return {
    candidates: [{ candidate: candidate(), beta: 1.0 } as BundleCandidateInput],
    report: bookReport(),
    scenario: scenario(),
    falsification: FALSIFICATION,
    pickStatus: "recommended" as const,
    pickConfidence: "HIGH" as const,
    ...partial,
  };
}

/* ---------------- leg conversion ---------------- */

describe("researchLegsFromStrategyLegs", () => {
  it("converts option legs with sign, IV, OI and DTE; flags stock legs unverified", () => {
    const { legs, hasStockLeg } = researchLegsFromStrategyLegs([leg({}), leg({ side: "SELL", strike: 210 })]);
    expect(hasStockLeg).toBe(false);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ optionType: "call", quantity: 1, strike: 200, iv: 0.3, openInterest: 5_000 });
    expect(legs[1].quantity).toBe(-1);
    const stock = researchLegsFromStrategyLegs([leg({ optionType: "STOCK" as any, strike: 0 })]);
    expect(stock.hasStockLeg).toBe(true);
    expect(stock.legs).toHaveLength(0);
  });
});

/* ---------------- the bundle ---------------- */

describe("buildRecommendationBundle — full bundle", () => {
  it("contains all seven §3.4 elements with economics recomputed, not caller-asserted", () => {
    const b = buildRecommendationBundle(bundleInput() as any);
    expect(b.decision).toBe("trade");
    expect(b.trade?.candidateId).toBe("cand-spread");
    // Economics from researchEconomics: long 200 call, debit $2 → $200/contract max loss.
    expect(b.trade?.economics.maxLoss).toBeCloseTo(2, 1);
    expect(b.trade?.maxLossDollarsPerContract).toBeCloseTo(200, 0);
    expect(b.trade?.scenarioGrid.cells.length).toBe(3);
    expect(b.falsification).not.toBeNull();
    expect(b.premortem).not.toBeNull();
    expect(b.qualification).toBe("Qualified");
    expect(b.sizing.recommendedContracts).toBeGreaterThan(0);
    expect(b.postTradeTotals).not.toBeNull();
    expect(b.optimizer.verdict).toMatch(/^(improves|worsens|neutral)$/);
    expect(b.optimizer.evidence.length).toBeGreaterThan(0);
    expect(b.alternatives.some((a) => a.kind === "no_trade")).toBe(true);
    expect(b.humanApprovalRequired).toBe(true);
    expect(b.disclaimer).toContain("not personalized advice");
  });

  it("post-trade totals equal the #34 evaluate composition at the sized count", () => {
    const report = bookReport();
    const b = buildRecommendationBundle(bundleInput({ report }) as any);
    const n = b.sizing.recommendedContracts;
    // Per contract: delta 0.5 × 100 × $200 spot = $10,000 delta dollars.
    expect(b.postTradeTotals?.deltaDollars).toBeCloseTo(report.totals.deltaDollars + 10_000 * n, 0);
    expect(b.postTradeTotals?.thetaDollarsPerDay).toBeCloseTo(report.totals.thetaDollarsPerDay + -0.02 * 100 * n, 1);
  });

  it("optimizer scenario stats are computed from the grid cells", () => {
    const single = buildScenario({
      goalKind: "directional", portfolioRef: { kind: "real" },
      shocks: { pricePct: [10], ivShift: [0], daysForward: [30] },
      constraints: { budget: 50_000, maxLoss: 50_000 },
    });
    const b = buildRecommendationBundle(bundleInput({ scenario: single }) as any);
    expect(b.optimizer.cellCount).toBe(1);
    expect(b.optimizer.expectedPnl).toBeCloseTo(b.trade!.scenarioGrid.cells[0].pnlTotal, 1);
    expect(b.optimizer.cvarPnl).toBeCloseTo(b.optimizer.expectedPnl, 1);
    expect(b.optimizer.probabilityOfProfit).toBe(b.optimizer.expectedPnl > 0 ? 1 : 0);
  });

  it("alternatives rank other candidates and always include no-trade with its outcome", () => {
    const runner = candidate({ id: "cand-runner", label: "XYZ 215 long call", legs: [leg({ strike: 215, entryPrice: 1, bid: 0.9, ask: 1.1, delta: 0.3 })], maxLoss: 100, netGreeks: { delta: 0.3, gamma: 0.01, theta: -0.01, vega: 0.03 } });
    const b = buildRecommendationBundle(bundleInput({
      candidates: [{ candidate: candidate(), beta: 1.0 }, { candidate: runner, beta: 1.0 }],
    }) as any);
    const alts = b.alternatives;
    expect(alts.length).toBeGreaterThanOrEqual(2);
    const noTrade = alts.find((a) => a.kind === "no_trade")!;
    expect(noTrade.expectedPnl).toBe(0);
    expect(noTrade.note).toMatch(/unchanged/i);
    expect(alts.find((a) => a.kind === "candidate")?.candidateId).toBe("cand-runner");
  });
});

/* ---------------- qualification & honesty caps ---------------- */

describe("qualification and honesty caps", () => {
  it("a bundle without a falsification record cannot be Qualified and is capped LOW", () => {
    const b = buildRecommendationBundle(bundleInput({ falsification: undefined }) as any);
    expect(b.qualification).toBe("Unqualified");
    expect(b.confidence).toBe("LOW");
    expect(b.qualificationReasons.join(" ")).toMatch(/falsification/i);
  });

  it("one-sided falsification (no contradicting evidence) downgrades to Watchlist", () => {
    const b = buildRecommendationBundle(bundleInput({
      falsification: { ...FALSIFICATION, contradictingEvidence: [] },
    }) as any);
    expect(b.qualification).toBe("Watchlist");
    expect(b.confidence).not.toBe("HIGH");
  });

  it("no-view pick caps survive: never recommended status, never HIGH confidence", () => {
    const b = buildRecommendationBundle(bundleInput({ pickStatus: "research_only", pickConfidence: "MEDIUM" }) as any);
    expect(b.status).toBe("research_only");
    expect(b.confidence).toBe("MEDIUM");
    expect(b.rationale.join(" ")).toMatch(/not a recommendation/i);
  });

  it("stock-leg candidates are Unverified and cannot be Qualified", () => {
    const stockCand = candidate({ id: "cand-stock", legs: [leg({ optionType: "STOCK" as any, strike: 0 })] });
    const b = buildRecommendationBundle(bundleInput({ candidates: [{ candidate: stockCand, beta: 1.0 }] }) as any);
    expect(b.qualification).toBe("Unqualified");
    expect(b.qualificationReasons.join(" ")).toMatch(/stock legs.*Unverified/i);
  });
});

/* ---------------- no-trade decision ---------------- */

describe("no-trade decision", () => {
  it("sizes to zero → decision no_trade, no trade element, no-trade alternative present", () => {
    // NAV $1,000: every budget sizes this $300-max-loss candidate to 0.
    const b = buildRecommendationBundle(bundleInput({ report: bookReport(1_000) }) as any);
    expect(b.sizing.recommendedContracts).toBe(0);
    expect(b.decision).toBe("no_trade");
    expect(b.trade).toBeNull();
    expect(b.alternatives.some((a) => a.kind === "no_trade")).toBe(true);
  });

  it("empty candidate list → no_trade bundle, never a manufactured pick", () => {
    const b = buildRecommendationBundle(bundleInput({ candidates: [] }) as any);
    expect(b.decision).toBe("no_trade");
    expect(b.status).toBe("no_trade");
    expect(b.trade).toBeNull();
  });
});

/* ---------------- hedging & repair ---------------- */

describe("hedging and repair plans", () => {
  it("post-trade delta-budget breach produces a hedge plan ranked by cost vs risk removed", () => {
    // Book beta-weighted delta is $12k of $100k NAV (12%); a large-delta
    // candidate sized up breaches the 25% budget → hedge plan required.
    const big = candidate({ id: "cand-big", netGreeks: { delta: 0.9, gamma: 0.01, theta: -0.02, vega: 0.03 } });
    const b = buildRecommendationBundle(bundleInput({
      candidates: [{ candidate: big, beta: 1.0, requestedContracts: 10 }],
    }) as any);
    expect(b.optimizer.breaches.join(" ")).toMatch(/delta/);
    expect(b.hedging.status).toBe("proposals");
    expect(b.hedging.options.length).toBeGreaterThan(0);
    const top = b.hedging.options[0];
    expect(top.riskRemovedDollars).toBeGreaterThan(0);
    expect(top.costPerDollarRiskRemoved).not.toBeNull();
    // Ranked ascending by cost per dollar of risk removed.
    const costs = b.hedging.options.map((o) => o.costPerDollarRiskRemoved ?? Infinity);
    expect([...costs].sort((x, y) => x - y)).toEqual(costs);
  });

  it("within-tolerance book states no hedge needed, explicitly", () => {
    const b = buildRecommendationBundle(bundleInput() as any);
    expect(b.hedging.status).toBe("none_needed");
  });

  it("repair options rank by risk removed minus cost, carrying honest limits", () => {
    const ratioRepair: RepairProposal = {
      status: "DRAFT", symbol: "XYZ", units: 1,
      legLong: { strike: 200, expirationDate: "2026-12-20", premium: 4 },
      legShort: { strike: 215, expirationDate: "2026-12-20", premium: 1.5, quantity: 2 },
      netDebitPerUnit: 1, breakevenAtExpiry: 195, maxRecoveryPerUnit: 500,
      upsideCappedAbove: 215, noDownsideProtection: true, maxAdditionalCapitalAtRisk: 100,
      postRepairBetaWeightedDeltaDollars: null, rationale: "ratio repair",
    };
    const b = buildRecommendationBundle(bundleInput({
      repairAnalysis: { asOf: AS_OF, status: "proposals", symbolsUnavailable: [], proposals: [ratioRepair] },
      compositionRepairs: [
        { label: "cheap small fix", costDollars: 10, riskRemovedDollars: 100, detail: "roll out" },
        { label: "big risk cut", costDollars: 50, riskRemovedDollars: 400, detail: "convert to butterfly" },
      ],
    }) as any);
    expect(b.repairs.status).toBe("proposals");
    // big risk cut: 400-50=350 > cheap fix: 100-10=90 > ratio repair (risk removed unknown → cost-first, last)
    expect(b.repairs.options[0].label).toBe("big risk cut");
    expect(b.repairs.options[b.repairs.options.length - 1].noDownsideProtection).toBe(true);
  });

  it("no repair inputs → repairs status none_supplied, not fabricated", () => {
    const b = buildRecommendationBundle(bundleInput() as any);
    expect(b.repairs.status).toBe("none_supplied");
    expect(b.repairs.options).toHaveLength(0);
  });
});

/* ---------------- persistence & report ---------------- */

describe("persistence and report format", () => {
  it("persists via mas_outcomes as a paper record and reads back tenant-scoped", () => {
    const sql = new MockSqlStorage() as any;
    const goal = createGoal(sql, { userLogin: "alice", kind: "directional", title: "XYZ breakout", source: "user" });
    const b = buildRecommendationBundle(bundleInput() as any);
    const rec = persistRecommendationBundle(sql, b, { userLogin: "alice", goalId: goal.id });
    expect(rec).not.toBeNull();
    expect(rec?.kind).toBe("paper");
    expect(rec?.recommendationRef).toBe(b.id);
    const mine = listOutcomes(sql, "alice", { goalId: goal.id });
    expect(mine).toHaveLength(1);
    expect((mine[0].metrics as any).decision).toBe("trade");
    expect(listOutcomes(sql, "bob", { goalId: goal.id })).toHaveLength(0);
  });

  it("report formatter includes verdict, qualification, hedge and no-trade lines", () => {
    const b = buildRecommendationBundle(bundleInput() as any);
    const text = formatRecommendationBundleReport(b);
    expect(text).toMatch(/Recommendation Bundle/);
    expect(text).toMatch(/Qualification: Qualified/);
    expect(text).toMatch(/no trade/i);
    expect(text).toMatch(/Human approval required/);
  });
});
