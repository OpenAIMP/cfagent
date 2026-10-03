import type { StrategyCandidate, StrategyRequest } from "../strategyEngine";
import type { AcceptanceRule, EvaluationObserver, EvaluationStatus, StrategyDefinition, StrategyEvaluation } from "./types";

/** Chain of responsibility: the first rule that returns a reason rejects the candidate. */
export const DEFAULT_ACCEPTANCE_RULES: AcceptanceRule[] = [
  {
    id: "max-planned-loss",
    evaluate: (candidate, request) => candidate.maxLoss > request.maxPlannedLoss ? `${candidate.label} exceeds the max planned loss` : null,
  },
  {
    id: "profitable-at-target",
    evaluate: (candidate) => candidate.targetPnl <= 0 ? `${candidate.label} is not profitable at the stated target under the selected assumptions` : null,
  },
  {
    id: "min-reward-risk",
    evaluate: (candidate, request) => candidate.targetRewardRisk < request.minRewardRisk ? `${candidate.label} is below the minimum target reward/risk` : null,
  },
];

export function runAcceptanceRules(candidate: StrategyCandidate, request: StrategyRequest, rules: AcceptanceRule[] = DEFAULT_ACCEPTANCE_RULES): string | null {
  for (const rule of rules) {
    const reason = rule.evaluate(candidate, request);
    if (reason) return reason;
  }
  return null;
}

interface Tally {
  def: StrategyDefinition;
  skipped?: string;
  generated: number;
  accepted: number;
  bestScore: number;
  truncated: number;
  noGeneration?: string;
  reasons: Map<string, number>;
}

/** Observer that turns engine events into the per-strategy evaluation ledger. */
export class EvaluationLedger implements EvaluationObserver {
  private readonly tallies = new Map<string, Tally>();

  constructor(registryDefs: StrategyDefinition[]) {
    for (const def of registryDefs) this.tallies.set(def.id, { def, generated: 0, accepted: 0, bestScore: 0, truncated: 0, reasons: new Map() });
  }

  onSkipped(def: StrategyDefinition, reason: string): void {
    this.tallies.get(def.id)!.skipped = reason;
  }

  onGenerated(def: StrategyDefinition, count: number, truncated: number, skipReason?: string): void {
    const tally = this.tallies.get(def.id)!;
    tally.generated += count;
    tally.truncated += truncated;
    if (count === 0 && skipReason) tally.noGeneration = skipReason;
  }

  onRejected(def: StrategyDefinition, reason: string): void {
    const tally = this.tallies.get(def.id)!;
    tally.reasons.set(reason, (tally.reasons.get(reason) || 0) + 1);
  }

  onAccepted(def: StrategyDefinition, candidate: StrategyCandidate): void {
    const tally = this.tallies.get(def.id)!;
    tally.accepted++;
    tally.bestScore = Math.max(tally.bestScore, candidate.score);
  }

  report(): StrategyEvaluation[] {
    return Array.from(this.tallies.values()).map((tally) => {
      const reasons = Array.from(tally.reasons, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
      let status: EvaluationStatus;
      let summary: string;
      if (tally.skipped) {
        status = "skipped";
        summary = tally.skipped;
      } else if (tally.accepted > 0) {
        status = "accepted";
        summary = `Accepted: ${tally.accepted} of ${tally.generated} candidate(s) passed every rule (best score ${tally.bestScore.toFixed(1)})${tally.truncated ? `; ${tally.truncated} further combinations not evaluated (per-strategy cap)` : ""}.`;
      } else {
        status = "rejected";
        if (tally.generated === 0) {
          summary = `Rejected: ${tally.noGeneration ?? "no candidate could be generated from the loaded chain"}.`;
        } else {
          const top = reasons[0];
          summary = `Rejected: all ${tally.generated} candidate(s) failed. Main reason (${top.count}x): ${top.reason}.`;
        }
      }
      return {
        id: tally.def.id,
        label: tally.def.label,
        category: tally.def.category,
        status,
        generated: tally.generated,
        accepted: tally.accepted,
        summary,
        reasons,
      };
    });
  }
}
