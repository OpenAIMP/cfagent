/**
 * Consolidation #1257 (epic #1151 remainder): the bridge from Phase 3
 * re-selection proposals (proposal_only_not_promoted) to challengers
 * — the documented path by which a proposal earns promotion
 * (championChallenger.ts header). This is what POST
 * /adaptation/candidates/generate does after the challenger re-point:
 * the old #757 generation (track-record anomalies → improvement
 * candidates) has no production caller and is retired with its store.
 *
 * Generation defaults (frozen-set-calibrated, NOT aspirational): the
 * v2 frozen set holds only 4 cases x 1 idea, so the holdout fold
 * evaluates at most 2 ideas. minEvaluated 1 and minHoldoutEdge
 * 0.0005 (the phase5 test precedent) are the only bars a challenger
 * can pass today; a larger frozen set must revisit them. Criteria
 * are frozen at creation — a generated challenger keeps these
 * defaults until it is resolved; it can never edit them.
 *
 * Evaluation-spec mapping (buildEvaluationSpecs): the route's
 * evaluate/gate handlers do not invent specs — the champion is the
 * CURRENT state (v2 weights for the challenger's regime + the
 * recorded active set, null when none is recorded, in which case
 * scoring does not filter by strategy), and the challenger differs
 * from the champion ONLY in what its kind changes: weights
 * challengers change weights, active-set/ranking challengers change
 * the active set. Anything else would score a challenger that is not
 * the one proposed.
 */
import {
  createChallenger,
  listChallengers,
  type Challenger,
  type ChallengerCriteria,
  type ScoringSpec,
} from "./championChallenger";
import type { WeightsV2Regime } from "./strategyWeightsV2";
import { listReselectionProposals } from "./strategyBankReselection";

export const CHALLENGER_GENERATION_DEFAULTS = {
  criteria: { minHoldoutEdge: 0.0005, minEvaluated: 1 } as ChallengerCriteria,
  evalSetVersion: "v2",
  createdBy: "strategy-bank-reselection",
};

export function buildEvaluationSpecs(
  challenger: Challenger,
  current: { weightsForRegime: Record<string, number>; activeSet: string[] | null }
): { championSpec: ScoringSpec; challengerSpec: ScoringSpec } {
  const championSpec: ScoringSpec = {
    weights: current.weightsForRegime,
    activeStrategies: current.activeSet,
  };
  let challengerSpec: ScoringSpec;
  if (challenger.kind === "weights") {
    challengerSpec = {
      weights: challenger.spec.weights ?? current.weightsForRegime,
      activeStrategies: current.activeSet,
    };
  } else if (challenger.kind === "ranking") {
    challengerSpec = {
      weights: current.weightsForRegime,
      activeStrategies: challenger.spec.ranking ?? null,
    };
  } else {
    challengerSpec = {
      weights: current.weightsForRegime,
      activeStrategies: challenger.spec.activeStrategies ?? null,
    };
  }
  return { championSpec, challengerSpec };
}

export interface GeneratedChallengerOutcome {
  created: Challenger[];
  skipped: Array<{ proposalId: string; reason: string }>;
}

/**
 * Human-readable basis for a challenger evaluation's verdict, for
 * the verdicts read path and the gate response. Each condition of
 * the frozen criteria is named with its measured value, so a fail
 * says exactly which bar was missed — never a bare pass/fail.
 */
export function verdictReasons(evaluation: {
  holdout: { championScore: number | null; challengerScore: number | null; evaluated: number };
  criteria: ChallengerCriteria;
  verdict: "pass" | "fail";
}): string[] {
  const { holdout, criteria } = evaluation;
  const edge =
    holdout.championScore !== null && holdout.challengerScore !== null
      ? holdout.challengerScore - holdout.championScore
      : null;
  const reasons: string[] = [];
  if (edge === null) {
    reasons.push("Holdout scores unavailable — no scored ideas on the frozen set.");
  } else if (edge >= criteria.minHoldoutEdge) {
    reasons.push(`Holdout edge ${edge.toFixed(4)} >= minimum ${criteria.minHoldoutEdge}.`);
  } else {
    reasons.push(`Holdout edge ${edge.toFixed(4)} below minimum ${criteria.minHoldoutEdge}.`);
  }
  if (holdout.evaluated >= criteria.minEvaluated) {
    reasons.push(`Holdout evaluated ${holdout.evaluated} >= minimum ${criteria.minEvaluated}.`);
  } else {
    reasons.push(`Holdout evaluated ${holdout.evaluated} below minimum ${criteria.minEvaluated}.`);
  }
  return reasons;
}

/**
 * Create one active-set challenger per re-selection proposal that
 * does not already have one (dedup on sourceProposalId — generating
 * twice never duplicates). Proposals with an empty active set are
 * skipped with a reason: an empty challenger could never promote
 * and would only add noise to the inbox. Returns created + skipped
 * so the route can report both.
 */
export function generateChallengersFromProposals(
  sql: any,
  userLogin: string
): GeneratedChallengerOutcome {
  const proposals = listReselectionProposals(sql, userLogin);
  const existing = new Set(
    listChallengers(sql, userLogin)
      .map((c) => c.sourceProposalId)
      .filter((id): id is string => id !== null)
  );
  const created: Challenger[] = [];
  const skipped: Array<{ proposalId: string; reason: string }> = [];
  for (const p of proposals) {
    if (existing.has(p.id)) {
      skipped.push({ proposalId: p.id, reason: "a challenger already exists for this proposal" });
      continue;
    }
    const strategies = p.proposal.activeSet.map((a) => a.strategy);
    if (strategies.length === 0) {
      skipped.push({ proposalId: p.id, reason: "proposal carries no active strategies" });
      continue;
    }
    created.push(
      createChallenger(sql, userLogin, {
        kind: "active_set",
        title: `Reselection ${p.regime} active set (${strategies.length} strategies)`,
        regime: p.regime as WeightsV2Regime,
        spec: { activeStrategies: strategies },
        criteria: CHALLENGER_GENERATION_DEFAULTS.criteria,
        evalSetVersion: CHALLENGER_GENERATION_DEFAULTS.evalSetVersion,
        sourceProposalId: p.id,
        createdBy: CHALLENGER_GENERATION_DEFAULTS.createdBy,
      })
    );
  }
  return { created, skipped };
}
