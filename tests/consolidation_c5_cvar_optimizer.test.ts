/**
 * Issue #1361 (epic #1151 slice C5; #1257 family rationalization).
 *
 * CvarOptimizer extraction (SRP): the scenario mean/CVaR objective,
 * candidate ranking, alternatives ranking, and optimizer verdict move
 * out of the recommendationBundle god-module into their own module.
 * Bundle output must be byte-identical for the Phase 4 fixture set
 * (guarded by tests/phase4_recommender_v2.test.ts); these tests pin
 * the extracted behavior directly.
 *
 * Verdict rules (moved verbatim from the builder):
 * - No primary, or decision != trade, or no post-trade totals: neutral.
 * - Trade branch: breaches > 0 => worsens; else score > 0 and post-trade
 *   |beta-weighted delta| (falling back to plain delta) no worse than
 *   the book's => improves; else score > 0 => neutral, else worsens.
 * Score rule (moved verbatim): expected + 0.5 * min(0, cvar).
 * CVaR-25: mean of the worst quartile of grid cells (at least 1 cell).
 */
import { describe, it, expect } from "vitest";
import {
  buildOptimizerAlternatives,
  computeScenarioStats,
  decideOptimizerVerdict,
  rankOptimizerCandidates,
  shouldTrade,
  type OptimizerCandidate,
} from "../src/services/cvarOptimizer";

function cells(pnls: number[]) {
  return pnls.map((pnlTotal) => ({ pnlTotal }));
}

function cand(
  partial: Partial<OptimizerCandidate> & { id: string },
): OptimizerCandidate {
  return {
    label: partial.id,
    stats: { expectedPnl: 0, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 0 },
    sizing: { recommendedContracts: 1, bindingConstraint: "test" },
    ...partial,
  } as OptimizerCandidate;
}

describe("CvarOptimizer.computeScenarioStats", () => {
  it("computes expected / CVaR-25 / worst / P(profit) / score", () => {
    // Sorted: -100, -50, 0, 100. Worst quartile = 1 cell (-100).
    const stats = computeScenarioStats(cells([-50, 100, -100, 0]));
    expect(stats.expectedPnl).toBe(-12.5);
    expect(stats.cvarPnl).toBe(-100);
    expect(stats.worstPnl).toBe(-100);
    expect(stats.probabilityOfProfit).toBe(0.25);
    // score = expected + 0.5 * min(0, cvar) = -12.5 + 0.5 * -100 = -62.5
    expect(stats.score).toBe(-62.5);
  });

  it("scores exactly 0 for an empty grid (no-trade parity)", () => {
    const stats = computeScenarioStats([]);
    expect(stats).toEqual({
      expectedPnl: 0,
      cvarPnl: 0,
      worstPnl: 0,
      probabilityOfProfit: 0,
      score: 0,
    });
  });

  it("ignores upside tail in the score: positive CVaR does not inflate", () => {
    const stats = computeScenarioStats(cells([10, 20, 30, 40]));
    expect(stats.cvarPnl).toBe(10);
    expect(stats.expectedPnl).toBe(25);
    expect(stats.score).toBe(25);
  });
});

describe("CvarOptimizer.rankOptimizerCandidates", () => {
  it("ranks by score desc, id asc on ties, without mutating input", () => {
    const a = cand({ id: "a", stats: { expectedPnl: 0, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 5 } });
    const b = cand({ id: "b", stats: { expectedPnl: 0, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 5 } });
    const c = cand({ id: "c", stats: { expectedPnl: 0, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 9 } });
    const input = [a, b, c];
    const ranked = rankOptimizerCandidates(input);
    expect(ranked.map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(input.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("CvarOptimizer.buildOptimizerAlternatives", () => {
  it("lists non-primary candidates + no-trade, ranked by score desc", () => {
    const primary = cand({ id: "p", label: "Primary", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 } });
    const other = cand({ id: "o", label: "Other", stats: { expectedPnl: 3, cvarPnl: -5, worstPnl: -5, probabilityOfProfit: 0, score: 0.5 }, sizing: { recommendedContracts: 2, bindingConstraint: "delta" } });
    const alts = buildOptimizerAlternatives([primary, other], primary);
    expect(alts.map((a) => a.kind)).toEqual(["candidate", "no_trade"]);
    expect(alts[0]).toMatchObject({ candidateId: "o", label: "Other", score: 0.5 });
    expect(alts[0].note).toContain("2 contract(s)");
    expect(alts[1]).toMatchObject({ kind: "no_trade", label: "No trade", score: 0 });
  });

  it("no-trade wins ties at score 0 by label order", () => {
    const primary = cand({ id: "p", label: "Primary", stats: { expectedPnl: 0, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 0 } });
    const alts = buildOptimizerAlternatives([primary], primary);
    expect(alts).toHaveLength(1);
    expect(alts[0].kind).toBe("no_trade");
  });
});

describe("CvarOptimizer.shouldTrade", () => {
  it("trades only when a primary exists, is sized above 0, and beats no-trade", () => {
    expect(shouldTrade(null)).toBe(false);
    const zero = cand({ id: "z", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 }, sizing: { recommendedContracts: 0, bindingConstraint: "delta" } });
    expect(shouldTrade(zero)).toBe(false);
    const flat = cand({ id: "f", stats: { expectedPnl: 0, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 0 } });
    expect(shouldTrade(flat)).toBe(false);
    const good = cand({ id: "g", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 } });
    expect(shouldTrade(good)).toBe(true);
  });
});

describe("CvarOptimizer.decideOptimizerVerdict", () => {
  const totals = (bw: number | null, d: number) => ({
    betaWeightedDeltaDollars: bw,
    deltaDollars: d,
  });
  it("is neutral without a trade", () => {
    expect(decideOptimizerVerdict({ primary: null, decision: "no_trade", postTradeTotals: null, reportTotals: totals(100, 100), breaches: [] })).toBe("neutral");
  });
  it("is worsens on any breach", () => {
    const primary = cand({ id: "p", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 } });
    expect(decideOptimizerVerdict({ primary, decision: "trade", postTradeTotals: totals(50, 50), reportTotals: totals(100, 100), breaches: ["delta budget"] })).toBe("worsens");
  });
  it("is improves when the trade reduces |beta-weighted delta|", () => {
    const primary = cand({ id: "p", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 } });
    expect(decideOptimizerVerdict({ primary, decision: "trade", postTradeTotals: totals(50, 50), reportTotals: totals(100, 100), breaches: [] })).toBe("improves");
  });
  it("falls back to plain delta when beta-weighted delta is null", () => {
    const primary = cand({ id: "p", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 } });
    expect(decideOptimizerVerdict({ primary, decision: "trade", postTradeTotals: totals(null, 40), reportTotals: totals(null, 100), breaches: [] })).toBe("improves");
  });
  it("is neutral when score is positive but delta worsens without breach", () => {
    const primary = cand({ id: "p", stats: { expectedPnl: 10, cvarPnl: 0, worstPnl: 0, probabilityOfProfit: 0, score: 10 } });
    expect(decideOptimizerVerdict({ primary, decision: "trade", postTradeTotals: totals(150, 150), reportTotals: totals(100, 100), breaches: [] })).toBe("neutral");
  });
  it("is worsens when score is not positive in the trade branch", () => {
    const primary = cand({ id: "p", stats: { expectedPnl: -5, cvarPnl: -10, worstPnl: -10, probabilityOfProfit: 0, score: -10 } });
    expect(decideOptimizerVerdict({ primary, decision: "trade", postTradeTotals: totals(50, 50), reportTotals: totals(100, 100), breaches: [] })).toBe("worsens");
  });
});
