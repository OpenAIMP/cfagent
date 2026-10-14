/**
 * Server-backed strategy discovery (issue #29).
 *
 * The Discovery view is a thin client of the server options pipeline
 * (POST /api/trading/options/strategies -> OptionsAgentPipeline). The server
 * evaluates the live E*TRADE chain against the registry, enforces the
 * acceptance rules, and ranks deterministically — the browser no longer
 * ranks strategies over a synthetic chain. The local engine
 * (strategyDiscoveryEngine) remains only as the Builder's modeling layer
 * for legs the user is actively editing.
 */
import { apiFetch } from "../apiFetch";
import type { DiscoveredStrategy, ExpirationOption, SentimentType, StrategyLegItem } from "./strategyDiscoveryEngine";

export interface ServerDiscoveryInputs {
  symbol: string;
  currentPrice: number;
  sentiment: SentimentType;
  targetPrice: number;
  budget: number;
  minRewardRisk: number;
  expiration: ExpirationOption;
  /** Panel bias slider (0 = max return, 100 = max chance). Since issue #29
   *  slice 7 the server converts it to score weights; the Builder fallback
   *  keeps applying it locally to analyzeStrategy. */
  bias?: number;
}

type OptionThesis = "bullish" | "bearish" | "range_bound" | "large_move";

/** Panel sentiment -> server thesis. "all" follows the target's direction. */
export function sentimentToThesis(sentiment: SentimentType, targetPrice: number, currentPrice: number): OptionThesis {
  switch (sentiment) {
    case "very_bullish":
    case "bullish":
    case "directional":
      return "bullish";
    case "very_bearish":
    case "bearish":
      return "bearish";
    case "neutral":
      return "range_bound";
    case "all":
    default:
      if (targetPrice > currentPrice * 1.001) return "bullish";
      if (targetPrice < currentPrice * 0.999) return "bearish";
      return "range_bound";
  }
}

export function buildStrategyRequest(inputs: ServerDiscoveryInputs) {
  return {
    symbol: inputs.symbol.toUpperCase(),
    thesis: sentimentToThesis(inputs.sentiment, inputs.targetPrice, inputs.currentPrice),
    targetPrice: inputs.targetPrice,
    targetDate: inputs.expiration.date,
    expectedIvDirection: "unchanged" as const,
    maxPlannedLoss: inputs.budget,
    minRewardRisk: inputs.minRewardRisk,
    allowedStrategies: ["all"],
    maxDte: inputs.expiration.dte,
    candidateLimit: 24,
    ...(inputs.bias !== undefined ? { optimizationBias: inputs.bias } : {}),
  };
}

interface ServerLeg {
  symbol: string;
  optionType: "CALL" | "PUT" | "STOCK";
  side: "BUY" | "SELL";
  quantity: number;
  strike: number;
  expirationDate: string;
  daysToExpiration?: number;
  entryPrice: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface ServerCandidate {
  id: string;
  type: string;
  label: string;
  expirationDate: string;
  legs: ServerLeg[];
  netDebit: number;
  maxProfit: number | null;
  maxLoss: number;
  breakevens: number[];
  targetPnl: number;
  targetRewardRisk: number;
  modelImpliedProbabilityOfProfit: number;
  payoffCurve: Array<{ underlyingPrice: number; pnl: number }>;
  explanations: string[];
}

interface RankedEntry {
  candidate: ServerCandidate;
  rank: number;
  compositeScore: number;
}

const THESIS_BY_SENTIMENT: Record<string, SentimentType> = {
  bullish: "bullish",
  bearish: "bearish",
  range_bound: "neutral",
  large_move: "directional",
};

/** Maps one server-ranked candidate into the panel's DiscoveredStrategy view model. */
export function mapCandidateToDiscovered(entry: RankedEntry, thesis: OptionThesis): DiscoveredStrategy {
  const c = entry.candidate;
  const dte = Math.max(0, ...c.legs.map((l) => l.daysToExpiration ?? 0));
  const legs: StrategyLegItem[] = c.legs.map((l) => ({
    id: l.symbol,
    side: l.side,
    optionType: l.optionType,
    strike: l.strike,
    quantity: l.quantity,
    expirationDate: l.expirationDate,
    dte: l.daysToExpiration ?? dte,
    entryPrice: l.entryPrice,
    bid: l.bid,
    ask: l.ask,
    impliedVolatility: l.impliedVolatility,
    delta: l.delta,
    gamma: l.gamma,
    theta: l.theta,
    vega: l.vega,
  }));
  const maxLoss = c.maxLoss;
  return {
    id: c.id,
    name: c.label,
    category: "Server Ranked",
    subtitle: `Composite ${entry.compositeScore.toFixed(1)} · Rank #${entry.rank}`,
    theses: [THESIS_BY_SENTIMENT[thesis] ?? "bullish"],
    legs,
    netDebit: c.netDebit,
    estMargin: maxLoss,
    maxProfit: c.maxProfit,
    maxLoss,
    targetProfit: c.targetPnl,
    riskOrCollateral: maxLoss,
    returnOnRiskPct: maxLoss > 0 ? (c.targetPnl / maxLoss) * 100 : null,
    returnOnCollateralPct: maxLoss > 0 ? (c.targetPnl / maxLoss) * 100 : null,
    rewardRiskRatio: c.targetRewardRisk,
    chanceOfProfit: Math.round(c.modelImpliedProbabilityOfProfit * 100),
    breakevens: c.breakevens,
    breakevenText: c.breakevens.length ? c.breakevens.map((b) => b.toFixed(2)).join(", ") : "—",
    miniPayoffPoints: c.payoffCurve.filter((_, i) => i % 2 === 0).map((p) => ({ price: p.underlyingPrice, pnl: p.pnl })),
    expirationDate: c.expirationDate,
    dte,
    description: c.explanations[0] ?? `${c.label} ranked #${entry.rank} by the server pipeline over the live chain.`,
    tag: entry.rank === 1 ? "#1 Server Ranked" : undefined,
  };
}

export interface ServerDiscoveryResult {
  strategies: DiscoveredStrategy[];
  status: string;
}

/** Fetches ranked strategies from the server pipeline for the Discovery view. */
export async function fetchServerDiscovery(inputs: ServerDiscoveryInputs, fetchImpl: typeof apiFetch = apiFetch): Promise<ServerDiscoveryResult> {
  const requestBody = buildStrategyRequest(inputs);
  const response = await fetchImpl("/api/trading/options/strategies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const data = (await response.json().catch(() => null)) as { status?: string; ranked?: RankedEntry[]; error?: string } | null;
  if (!response.ok || !data) {
    throw new Error(data?.error || `Server discovery failed (${response.status})`);
  }
  const thesis = requestBody.thesis;
  return {
    status: data.status ?? "no_candidates",
    strategies: (data.ranked ?? []).map((entry) => mapCandidateToDiscovered(entry, thesis)),
  };
}
