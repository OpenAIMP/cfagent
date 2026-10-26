/**
 * Issue #1640 (parent #1638, doc §§2-4) — the single ranking-core
 * annotation contract, feeding #1257's recommendation-family core.
 *
 * Context, verified on main before this module was written: #1257's C5
 * work already landed the kernel RankingPolicies
 * (RiskProfileComposite / ScenarioGridRank / PerNameBestFit, plus the
 * llm/hybrid arm policies that are the bounded comparison exception),
 * the scanner's routing through RiskProfileComposite, v2 weights on
 * every live /adaptation/* route, and the championChallenger promotion
 * re-point. What §§2-4 still lacked was a single enforced contract
 * for the LLM overlay itself: the doc target is "LLM overlay
 * annotates, never overwrites quant ranking", but each consumer
 * hand-rolled its own rationale map, so nothing stopped a future
 * consumer from presenting the LLM's own order as the ranking.
 *
 * This module is that contract. `annotateQuantRanking` takes an
 * already quant-ranked list and LLM judgments and returns the SAME
 * list — same order, same length, same entry references — with each
 * judgment attached as an annotation. It can never reorder, drop, or
 * invent a candidate: judgments for unknown ids are dropped, a
 * candidate with no judgment annotates null, and the first judgment
 * for a duplicated id wins deterministically.
 *
 * Consumers: the E*TRADE options evaluate route (its `rankings`
 * field is the quant order annotated this way; the route's `answer`
 * prose remains the LLM's own top-3 list, explicitly labeled as the
 * LLM evaluation, and is NOT the ranking). The kernel's llm/hybrid
 * comparison arms are the single documented exception to
 * quant-authority — they order an arm's own list inside a comparison
 * run and never alter a production ranking (#1257 scope note).
 */
export interface LlmRankingAnnotation {
  candidateId: string;
  /** LLM score for the candidate, when the judgment carries one. */
  score: number | null;
  rationale: string | null;
  risks: string[];
}

export interface AnnotatedRanked<T> {
  ranked: T;
  annotation: LlmRankingAnnotation | null;
}

/** Minimal shape of an LLM judgment (llmComparison's LlmCandidateJudgment). */
export interface LlmJudgmentInput {
  candidateId: string;
  score?: number;
  rationale?: string;
  risks?: string[];
}

/**
 * Attach LLM judgments to a quant-ranked list without ever changing
 * the quant order. Pure: the input array and its entries are not
 * mutated, and the returned `ranked` entries are the same references.
 */
export function annotateQuantRanking<T extends { candidate: { id: string } }>(
  quantRanked: T[],
  judgments: LlmJudgmentInput[],
): AnnotatedRanked<T>[] {
  const byId = new Map<string, LlmRankingAnnotation>();
  for (const judgment of judgments) {
    if (byId.has(judgment.candidateId)) continue;
    byId.set(judgment.candidateId, {
      candidateId: judgment.candidateId,
      score: typeof judgment.score === "number" ? judgment.score : null,
      rationale: typeof judgment.rationale === "string" ? judgment.rationale : null,
      risks: Array.isArray(judgment.risks) ? [...judgment.risks] : [],
    });
  }
  return quantRanked.map((ranked) => ({
    ranked,
    annotation: byId.get(ranked.candidate.id) ?? null,
  }));
}
