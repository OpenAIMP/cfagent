/**
 * Capability 2 — Multi-leg Strategy / Risk Engine Agent and Strategy Screener
 *
 * Builds multi-leg structures (verticals, straddles, strangles, condors) from
 * screened contracts, computes max loss / breakevens / Greeks / scenarios, and
 * screens the resulting strategies against user-set risk limits. It does not
 * choose a winner; ranking belongs to the recommendation agent.
 */

import type { ScreenedOptionContractItem } from "../../types";
import {
  recommendOptionStrategies,
  type OptionStrategyType,
  type StrategyCandidate,
  type StrategyRecommendationResult,
  type StrategyRequest,
} from "./strategyEngine";
import { defaultRegistry } from "./strategies/catalog";

export interface StrategyScreenFilter {
  strategyTypes?: OptionStrategyType[];
  minProbabilityOfProfit?: number; // 0-1
  maxNetDebit?: number;
  minNetCredit?: number;
  minTargetPnl?: number;
  minMaxProfit?: number;
  maxBreakevenDistancePct?: number;
  maxLegs?: number;
  requireFresh?: boolean;
}

export interface StrategyRiskReport {
  id: string;
  maxLoss: number;
  maxProfit: number | null;
  maxProfitUnbounded: boolean;
  breakevens: number[];
  probabilityOfProfit: number;
  netGreeks: StrategyCandidate["netGreeks"];
  budgetUsedPct: number;
  withinBudget: boolean;
  worstScenario: { underlyingPrice: number; daysToExpiry: number; ivChangePct: number; pnl: number };
  bestScenario: { underlyingPrice: number; daysToExpiry: number; ivChangePct: number; pnl: number };
  isCredit: boolean;
}

const THESES = ["bullish", "bearish", "range_bound", "large_move"];
const IV_DIRECTIONS = ["rise", "unchanged", "fall"];

export function validateStrategyRequest(body: Partial<StrategyRequest> | null | undefined): string | null {
  if (
    !body ||
    typeof body.symbol !== "string" ||
    !body.symbol.trim() ||
    !THESES.includes(body.thesis || "") ||
    !Number.isFinite(body.targetPrice) ||
    typeof body.targetDate !== "string" ||
    !IV_DIRECTIONS.includes(body.expectedIvDirection || "") ||
    !Number.isFinite(body.maxPlannedLoss) ||
    !Number.isFinite(body.minRewardRisk) ||
    (body.minDte !== undefined && (!Number.isInteger(body.minDte) || body.minDte < 1)) ||
    (body.maxDte !== undefined && (!Number.isInteger(body.maxDte) || body.maxDte < (body.minDte ?? 0))) ||
    (body.minVolume !== undefined && (!Number.isInteger(body.minVolume) || body.minVolume < 0)) ||
    (body.minOpenInterest !== undefined && (!Number.isInteger(body.minOpenInterest) || body.minOpenInterest < 0)) ||
    (body.maxSpreadPct !== undefined && (!Number.isFinite(body.maxSpreadPct) || body.maxSpreadPct <= 0)) ||
    (body.maxQuoteAgeSeconds !== undefined && (!Number.isFinite(body.maxQuoteAgeSeconds) || body.maxQuoteAgeSeconds < 0)) ||
    (body.contractLimit !== undefined && (!Number.isInteger(body.contractLimit) || body.contractLimit < 1)) ||
    (body.candidateLimit !== undefined && (!Number.isInteger(body.candidateLimit) || body.candidateLimit < 1)) ||
    (body.maxStrikesPerSide !== undefined && (!Number.isInteger(body.maxStrikesPerSide) || body.maxStrikesPerSide < 1)) ||
    (body.maxIronCondors !== undefined && (!Number.isInteger(body.maxIronCondors) || body.maxIronCondors < 0)) ||
    !Array.isArray(body.allowedStrategies) ||
    body.allowedStrategies.length === 0 ||
    defaultRegistry.resolveMany(body.allowedStrategies as string[]).unknown.length > 0
  ) {
    return "Invalid strategy request. Supply a thesis, target, date, risk cap, reward/risk minimum, and allowed strategies.";
  }
  return null;
}

export class StrategyRiskAgent {
  readonly id = "strategy-risk-agent";
  readonly capability = "Multi-leg strategy builder, risk engine & strategy screener";

  /** Build every valid, risk-capped multi-leg candidate (unlimited, engine-scored). */
  buildStrategies(contracts: ScreenedOptionContractItem[], request: StrategyRequest): StrategyRecommendationResult {
    return recommendOptionStrategies(contracts, request);
  }

  riskReport(candidate: StrategyCandidate, request: Pick<StrategyRequest, "maxPlannedLoss">): StrategyRiskReport {
    const byPnl = [...candidate.scenarios].sort((a, b) => a.pnl - b.pnl);
    const pick = (s?: StrategyCandidate["scenarios"][number]) =>
      s ?? { underlyingPrice: 0, daysToExpiry: 0, ivChangePct: 0, pnl: 0 };
    return {
      id: candidate.id,
      maxLoss: candidate.maxLoss,
      maxProfit: candidate.maxProfit,
      maxProfitUnbounded: candidate.maxProfitUnbounded,
      breakevens: candidate.breakevens,
      probabilityOfProfit: candidate.modelImpliedProbabilityOfProfit,
      netGreeks: candidate.netGreeks,
      budgetUsedPct: Number(((candidate.maxLoss / request.maxPlannedLoss) * 100).toFixed(1)),
      withinBudget: candidate.maxLoss <= request.maxPlannedLoss,
      worstScenario: pick(byPnl[0]),
      bestScenario: pick(byPnl[byPnl.length - 1]),
      isCredit: candidate.netDebit < 0,
    };
  }

  /** Strategy screener: filter built strategies by user-visible risk/return limits. */
  screenStrategies(candidates: StrategyCandidate[], filter: StrategyScreenFilter = {}): {
    matched: StrategyCandidate[];
    rejected: Array<{ id: string; reason: string }>;
  } {
    const matched: StrategyCandidate[] = [];
    const rejected: Array<{ id: string; reason: string }> = [];
    const types = filter.strategyTypes?.length ? new Set(filter.strategyTypes) : undefined;
    for (const c of candidates) {
      const reason = this.rejectionReason(c, filter, types);
      if (reason) rejected.push({ id: c.id, reason });
      else matched.push(c);
    }
    return { matched, rejected };
  }

  private rejectionReason(c: StrategyCandidate, f: StrategyScreenFilter, types?: Set<OptionStrategyType>): string | null {
    if (types && !types.has(c.type)) return `${c.label} not in selected strategy types`;
    if (f.maxLegs !== undefined && c.legs.length > f.maxLegs) return `${c.legs.length} legs exceeds max ${f.maxLegs}`;
    if (f.requireFresh && c.dataFreshness !== "FRESH") return `Quote data is ${c.dataFreshness}`;
    if (f.minProbabilityOfProfit !== undefined && c.modelImpliedProbabilityOfProfit < f.minProbabilityOfProfit) {
      return `Probability of profit ${(c.modelImpliedProbabilityOfProfit * 100).toFixed(1)}% below ${(f.minProbabilityOfProfit * 100).toFixed(1)}%`;
    }
    if (f.maxNetDebit !== undefined && c.netDebit > f.maxNetDebit) return `Net debit $${c.netDebit.toFixed(2)} exceeds $${f.maxNetDebit}`;
    if (f.minNetCredit !== undefined && -c.netDebit < f.minNetCredit) return `Net credit $${(-c.netDebit).toFixed(2)} below $${f.minNetCredit}`;
    if (f.minTargetPnl !== undefined && c.targetPnl < f.minTargetPnl) return `Target P/L $${c.targetPnl.toFixed(2)} below $${f.minTargetPnl}`;
    if (f.minMaxProfit !== undefined && !c.maxProfitUnbounded && (c.maxProfit ?? 0) < f.minMaxProfit) {
      return `Max profit $${(c.maxProfit ?? 0).toFixed(2)} below $${f.minMaxProfit}`;
    }
    if (f.maxBreakevenDistancePct !== undefined) {
      const spot = c.underlyingPrice;
      const far = c.breakevens.some((b) => spot > 0 && (Math.abs(b - spot) / spot) * 100 > f.maxBreakevenDistancePct!);
      if (far) return `Breakeven farther than ${f.maxBreakevenDistancePct}% from spot`;
    }
    return null;
  }
}
