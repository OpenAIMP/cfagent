/**
 * CvarOptimizer — scenario mean/CVaR objective + candidate ranking
 * (issue #1361, epic #1151 slice C5; #1257 family rationalization).
 *
 * Extracted from recommendationBundle.ts (SRP): the bundle module
 * assembles; this module optimizes. Every rule below moved verbatim
 * from the builder so bundle output is byte-identical for the Phase 4
 * fixture set:
 * - Score: expected P/L + 0.5 * min(0, CVaR-25). No-trade scores
 *   exactly 0, so a trade must BEAT doing nothing.
 * - CVaR-25: mean of the worst quartile of grid cells (at least 1).
 * - Ranking: score desc, candidate id asc on ties.
 * - Alternatives: non-primary candidates + explicit no-trade,
 *   ranked by score desc, label asc on ties.
 * - Verdict: breaches => worsens; else a trade that does not worsen
 *   |beta-weighted delta| (plain delta fallback) improves when its
 *   score is positive; else neutral when positive, worsens otherwise.
 *   No primary / no trade / no post-trade totals => neutral.
 * - Trade decision: a primary sized above 0 contracts whose score
 *   beats no-trade (0).
 */

/** Two-decimal rounding shared by the optimizer and the bundle builder. */
export const round2 = (n: number): number => Number(n.toFixed(2));

export interface OptimizerCandidateStats {
  expectedPnl: number;
  cvarPnl: number;
  worstPnl: number;
  probabilityOfProfit: number;
  /** Optimizer score: expected P/L penalized by tail loss. Higher wins. */
  score: number;
}

/** Scenario-grid statistics for one candidate (moved verbatim). */
export function computeScenarioStats(
  cells: ReadonlyArray<{ pnlTotal: number }>,
): OptimizerCandidateStats {
  const pnls = cells.map((c) => c.pnlTotal).sort((a, b) => a - b);
  const n = pnls.length;
  const expected = n ? pnls.reduce((s, v) => s + v, 0) / n : 0;
  const tailCount = Math.max(1, Math.ceil(n * 0.25));
  const cvar = n ? pnls.slice(0, tailCount).reduce((s, v) => s + v, 0) / tailCount : 0;
  const pop = n ? pnls.filter((v) => v > 0).length / n : 0;
  return {
    expectedPnl: round2(expected),
    cvarPnl: round2(cvar),
    worstPnl: n ? pnls[0] : 0,
    probabilityOfProfit: Number(pop.toFixed(3)),
    score: round2(expected + 0.5 * Math.min(0, cvar)),
  };
}

/** The optimizer's minimal view of a candidate (no engine types leak in). */
export interface OptimizerCandidate {
  id: string;
  label: string;
  stats: OptimizerCandidateStats;
  sizing: { recommendedContracts: number; bindingConstraint: string };
}

/** Rank candidates: score desc, id asc on ties. Input is not mutated. */
export function rankOptimizerCandidates(
  candidates: readonly OptimizerCandidate[],
): OptimizerCandidate[] {
  return [...candidates].sort(
    (a, b) => b.stats.score - a.stats.score || a.id.localeCompare(b.id),
  );
}

export interface OptimizerAlternative {
  kind: "candidate" | "no_trade";
  candidateId?: string;
  label: string;
  expectedPnl: number;
  cvarPnl: number;
  score: number;
  note: string;
}

/** The explicit no-trade alternative (moved verbatim). */
export const NO_TRADE_ALTERNATIVE: OptimizerAlternative = {
  kind: "no_trade",
  label: "No trade",
  expectedPnl: 0,
  cvarPnl: 0,
  score: 0,
  note: "Portfolio unchanged: no new premium, Greeks, or max loss; scenario outcome is the current book's own outcome.",
};

/**
 * Alternatives for a ranked list: every non-primary candidate,
 * optimizer-ranked, plus no-trade — sorted by score desc, label asc.
 * `ranked` must already be in ranked order; `primary` is ranked[0].
 */
export function buildOptimizerAlternatives(
  ranked: readonly OptimizerCandidate[],
  primary: OptimizerCandidate | null,
): OptimizerAlternative[] {
  const alternatives: OptimizerAlternative[] = ranked.slice(1).map((e) => ({
    kind: "candidate" as const,
    candidateId: e.id,
    label: e.label,
    expectedPnl: e.stats.expectedPnl,
    cvarPnl: e.stats.cvarPnl,
    score: e.stats.score,
    note: `Sized to ${e.sizing.recommendedContracts} contract(s) by ${e.sizing.bindingConstraint}; scenario score ${e.stats.score} vs primary ${primary?.stats.score ?? 0}.`,
  }));
  alternatives.push(NO_TRADE_ALTERNATIVE);
  alternatives.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return alternatives;
}

/** The optimizer must BEAT no-trade (score 0) at a sized count. */
export function shouldTrade(primary: OptimizerCandidate | null): boolean {
  return (
    primary !== null &&
    primary.sizing.recommendedContracts > 0 &&
    primary.stats.score > 0
  );
}

export type OptimizerVerdict = "improves" | "worsens" | "neutral";

export interface OptimizerDeltaTotals {
  betaWeightedDeltaDollars: number | null;
  deltaDollars: number;
}

/** Optimizer verdict (moved verbatim from the builder). */
export function decideOptimizerVerdict(input: {
  primary: OptimizerCandidate | null;
  decision: "trade" | "no_trade";
  postTradeTotals: OptimizerDeltaTotals | null;
  reportTotals: OptimizerDeltaTotals;
  breaches: string[];
}): OptimizerVerdict {
  const { primary, decision, postTradeTotals, reportTotals, breaches } = input;
  if (primary && decision === "trade" && postTradeTotals) {
    if (breaches.length > 0) return "worsens";
    const post = Math.abs(
      postTradeTotals.betaWeightedDeltaDollars ?? postTradeTotals.deltaDollars,
    );
    const pre = Math.abs(
      reportTotals.betaWeightedDeltaDollars ?? reportTotals.deltaDollars,
    );
    if (primary.stats.score > 0 && post <= pre) return "improves";
    return primary.stats.score > 0 ? "neutral" : "worsens";
  }
  return "neutral";
}
