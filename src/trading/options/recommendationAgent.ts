/**
 * Capability 3 — Recommendation / Ranking Agent with "Best Trade" picker
 *
 * Re-ranks strategy candidates using a risk-profile-weighted composite and
 * selects a single best trade with rationale, runner-ups, confidence and
 * explicit blockers. Output is research only; execution always requires human
 * approval.
 */

import type { StrategyCandidate, StrategyRequest } from "./strategyEngine";

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface RankingComponents {
  engineScore: number;
  probability: number;
  rewardRisk: number;
  capitalSafety: number;
  liquidity: number;
}

export interface RankedStrategy {
  candidate: StrategyCandidate;
  rank: number;
  compositeScore: number;
  components: RankingComponents;
}

export interface BestTradePick {
  status: "recommended" | "research_only" | "no_trade";
  riskProfile: RiskProfile;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  best?: RankedStrategy;
  alternatives: RankedStrategy[];
  tradePlan?: Array<{ action: "BUY" | "SELL"; quantity: number; contract: string; optionType: "CALL" | "PUT"; strike: number; expiration: string; limitPrice: number }>;
  rationale: string[];
  blockers: string[];
  humanApprovalRequired: true;
  disclaimer: string;
}

const PROFILE_WEIGHTS: Record<RiskProfile, RankingComponents> = {
  conservative: { engineScore: 0.20, probability: 0.35, rewardRisk: 0.10, capitalSafety: 0.20, liquidity: 0.15 },
  balanced: { engineScore: 0.30, probability: 0.20, rewardRisk: 0.25, capitalSafety: 0.10, liquidity: 0.15 },
  aggressive: { engineScore: 0.25, probability: 0.10, rewardRisk: 0.45, capitalSafety: 0.00, liquidity: 0.20 },
};

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export class RecommendationAgent {
  readonly id = "recommendation-agent";
  readonly capability = "Strategy ranking & best-trade picker";

  weightsFor(profile: RiskProfile): RankingComponents {
    return PROFILE_WEIGHTS[profile];
  }

  rank(
    candidates: StrategyCandidate[],
    request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk">,
    profile: RiskProfile = "balanced"
  ): RankedStrategy[] {
    const weights = PROFILE_WEIGHTS[profile];
    const scored = candidates.map((candidate) => {
      const components: RankingComponents = {
        engineScore: candidate.score,
        probability: clamp(candidate.modelImpliedProbabilityOfProfit * 100),
        rewardRisk: clamp((candidate.targetRewardRisk / Math.max(request.minRewardRisk, 0.5)) * 50),
        capitalSafety: clamp(100 - (candidate.maxLoss / request.maxPlannedLoss) * 100),
        liquidity: clamp(candidate.liquidityScore),
      };
      const compositeScore = (Object.keys(weights) as Array<keyof RankingComponents>)
        .reduce((sum, key) => sum + components[key] * weights[key], 0);
      return { candidate, components, compositeScore: Number(compositeScore.toFixed(2)) };
    });
    scored.sort((a, b) => b.compositeScore - a.compositeScore || a.candidate.id.localeCompare(b.candidate.id));
    return scored.map((item, index) => ({ ...item, rank: index + 1 }));
  }

  pickBestTrade(
    candidates: StrategyCandidate[],
    request: Pick<StrategyRequest, "maxPlannedLoss" | "minRewardRisk" | "thesis" | "symbol">,
    profile: RiskProfile = "balanced",
    alternativesCount = 3
  ): BestTradePick {
    const disclaimer = "Research output only; not personalized advice or an order. Verify live quotes and event risk, and approve any order manually.";
    const ranked = this.rank(candidates, request, profile);
    if (ranked.length === 0) {
      return {
        status: "no_trade",
        riskProfile: profile,
        confidence: "LOW",
        alternatives: [],
        rationale: [`No ${request.symbol.toUpperCase()} strategy satisfied the ${request.thesis.replaceAll("_", " ")} thesis, risk cap and reward/risk minimum.`],
        blockers: ["No qualifying candidates"],
        humanApprovalRequired: true,
        disclaimer,
      };
    }

    const [best, runnerUp, ...rest] = ranked;
    const c = best.candidate;
    const blockers: string[] = [];
    if (c.dataFreshness !== "FRESH") blockers.push(`Quote data is ${c.dataFreshness}; refresh quotes before considering this trade.`);
    if (c.maxProfitUnbounded === false && c.maxProfit !== null && c.maxProfit <= 0) blockers.push("No positive maximum profit after fees.");
    if (c.modelImpliedProbabilityOfProfit < 0.2) blockers.push("Model-implied probability of profit is below 20%.");

    const margin = runnerUp ? best.compositeScore - runnerUp.compositeScore : best.compositeScore;
    let confidence: BestTradePick["confidence"] = "MEDIUM";
    if (c.dataFreshness !== "FRESH" || blockers.length > 0) confidence = "LOW";
    else if (margin >= 5 && c.liquidityScore >= 60 && c.modelImpliedProbabilityOfProfit >= 0.35) confidence = "HIGH";

    const rationale = [
      `${c.label} ranks #1 for a ${profile} profile with composite score ${best.compositeScore}/100.`,
      `Max loss $${c.maxLoss.toFixed(2)} (${((c.maxLoss / request.maxPlannedLoss) * 100).toFixed(0)}% of your $${request.maxPlannedLoss} cap); ${c.maxProfitUnbounded ? "profit unbounded" : `max profit $${(c.maxProfit ?? 0).toFixed(2)}`}.`,
      `Target-date modeled P/L $${c.targetPnl.toFixed(2)} (${c.targetRewardRisk.toFixed(2)}x risk); model-implied POP ${(c.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%.`,
      `Breakeven${c.breakevens.length === 1 ? "" : "s"}: ${c.breakevens.map((b) => `$${b}`).join(", ") || "n/a"}; liquidity ${c.liquidityScore}/100.`,
    ];
    if (runnerUp) rationale.push(`Beats runner-up ${runnerUp.candidate.label} by ${margin.toFixed(1)} points.`);

    return {
      status: blockers.length > 0 ? "research_only" : "recommended",
      riskProfile: profile,
      confidence,
      best,
      alternatives: [runnerUp, ...rest].filter((r): r is RankedStrategy => Boolean(r)).slice(0, alternativesCount),
      tradePlan: c.legs.map((leg) => ({
        action: leg.side,
        quantity: leg.quantity,
        contract: leg.symbol,
        optionType: leg.optionType,
        strike: leg.strike,
        expiration: leg.expirationDate,
        limitPrice: leg.entryPrice,
      })),
      rationale,
      blockers,
      humanApprovalRequired: true,
      disclaimer,
    };
  }
}
