/**
 * Natural-language entry points for the options strategy screener (capability 2)
 * and the best-trade picker (capability 3). Capability 1 (single-contract
 * screening) stays on the existing `options_screen` NLQ action.
 */

import { OptionsAgentPipeline } from "../trading/options";
import { DynamicOptionsScreener } from "../trading/optionsScreener";
import type {
  ExpectedIvDirection,
  OptionStrategyType,
  OptionThesis,
  StrategyRequest,
} from "../trading/options/strategyEngine";
import type { RiskProfile } from "../trading/options/recommendationAgent";
import { validateStrategyRequest, type StrategyScreenFilter } from "../trading/options/strategyRiskAgent";

export type OptionsStrategyAction = "options_strategies" | "options_best_trade";

export interface OptionsStrategyIntent {
  action: OptionsStrategyAction;
  filters: {
    request: Partial<StrategyRequest>;
    riskProfile: RiskProfile;
    strategyFilter: StrategyScreenFilter;
    targetPriceInferred: boolean;
    thesisInferred: boolean;
  };
}

const NOT_TICKERS = new Set([
  "DTE", "IV", "OI", "ITM", "OTM", "ATM", "ETF", "PUT", "CALL", "NLQ", "USD", "POP", "RSI", "THE", "AND", "FOR",
  "BEST", "TOP", "PICK", "WITH", "LOSS", "MAX", "MIN", "RR", "A", "I", "IN", "ON", "TO", "OF",
]);

const OPTIONS_CONTEXT = /\b(options?|calls?|puts?|spreads?|straddles?|strangles?|condors?|debit|credit|iv|dte|delta|strike)\b/i;
const BEST_TRADE = /\b(?:best|top)\s+(?:\w+\s+){0,2}(?:trade|play|strategy|spread|setup)\b/i;
const PICK_TRADE = /\b(?:pick|choose|recommend|suggest|find)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+)?(?:\w+\s+){0,2}(?:trade|strateg(?:y|ies)|spread)\b/i;
const STRATEGY_SCREEN = /\b(?:options?\s+strateg(?:y|ies)|strateg(?:y|ies)\s+(?:screen|scan|screener)|(?:debit|credit|vertical)\s+spreads?|straddles?|strangles?|iron\s+condors?)\b/i;

const THESIS_DEFAULTS: Record<OptionThesis, OptionStrategyType[]> = {
  bullish: ["long_call", "call_debit_spread", "put_credit_spread"],
  bearish: ["long_put", "put_debit_spread", "call_credit_spread"],
  range_bound: ["iron_condor", "call_credit_spread", "put_credit_spread"],
  large_move: ["long_straddle", "long_strangle"],
};

function parseNumber(text: string): number {
  return Number(text.replace(/,/g, ""));
}

function detectSymbol(question: string): string | undefined {
  const upper = [...question.matchAll(/\$?\b([A-Z]{1,5})\b/g)].map((m) => m[1]).find((t) => !NOT_TICKERS.has(t));
  if (upper) return upper;
  const prepositional = question.match(/\b(?:for|on|in)\s+\$?([A-Za-z]{1,5})\b/i);
  if (prepositional && !NOT_TICKERS.has(prepositional[1].toUpperCase()) && !/^(the|a|an|my|any|all)$/i.test(prepositional[1])) {
    return prepositional[1].toUpperCase();
  }
  return undefined;
}

function detectStrategies(question: string): OptionStrategyType[] {
  const found = new Set<OptionStrategyType>();
  const q = question.toLowerCase();
  if (/call\s+debit\s+spread/.test(q)) found.add("call_debit_spread");
  if (/put\s+debit\s+spread/.test(q)) found.add("put_debit_spread");
  if (/call\s+credit\s+spread/.test(q)) found.add("call_credit_spread");
  if (/put\s+credit\s+spread/.test(q)) found.add("put_credit_spread");
  if (/(?<!call |put )debit\s+spread/.test(q)) { found.add("call_debit_spread"); found.add("put_debit_spread"); }
  if (/(?<!call |put )credit\s+spread/.test(q)) { found.add("call_credit_spread"); found.add("put_credit_spread"); }
  if (/iron\s+condor/.test(q)) found.add("iron_condor");
  if (/straddle/.test(q)) found.add("long_straddle");
  if (/strangle/.test(q)) found.add("long_strangle");
  if (/long\s+call/.test(q)) found.add("long_call");
  if (/long\s+put/.test(q)) found.add("long_put");
  return [...found];
}

function detectThesis(question: string, strategies: OptionStrategyType[]): { thesis: OptionThesis; inferred: boolean } {
  if (/\b(bearish|downside|decline|drop(?:s|ping)?|fall(?:s|ing)?|sell[- ]?off|short)\b/i.test(question)) return { thesis: "bearish", inferred: false };
  if (/\b(neutral|range[- ]?bound|sideways|flat|stays?\s+(?:flat|between)|not\s+move|pinned)\b/i.test(question)) return { thesis: "range_bound", inferred: false };
  if (/\b(big\s+move|large\s+move|volatile|volatility\s+expansion|breakout|earnings\s+move)\b/i.test(question)) return { thesis: "large_move", inferred: false };
  if (/\b(bullish|upside|rally|rall(?:y|ies)|go(?:es)?\s+up|rises?|climbs?)\b/i.test(question)) return { thesis: "bullish", inferred: false };
  if (strategies.includes("iron_condor")) return { thesis: "range_bound", inferred: true };
  if (strategies.some((s) => s === "long_straddle" || s === "long_strangle")) return { thesis: "large_move", inferred: true };
  if (strategies.some((s) => s === "long_put" || s === "put_debit_spread" || s === "call_credit_spread")) return { thesis: "bearish", inferred: true };
  return { thesis: "bullish", inferred: true };
}

function detectTargetDate(question: string, maxDte?: number): string {
  const iso = question.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const rel = question.match(/\b(?:in|within|by)\s+(\d+)\s*(day|week|month)s?\b/i);
  const days = rel
    ? Number(rel[1]) * (rel[2].toLowerCase() === "week" ? 7 : rel[2].toLowerCase() === "month" ? 30 : 1)
    : maxDte ?? 30;
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Returns null when the question is not about multi-leg strategies or a best-trade pick. */
export function parseOptionsStrategyIntent(question: string): OptionsStrategyIntent | null {
  const isBest = BEST_TRADE.test(question) && OPTIONS_CONTEXT.test(question)
    || /\bbest\s+(?:options?\s+)?(?:trade|play)\b/i.test(question)
    || (PICK_TRADE.test(question) && OPTIONS_CONTEXT.test(question));
  const isStrategies = STRATEGY_SCREEN.test(question);
  if (!isBest && !isStrategies) return null;
  if (/\b(buy|sell)\s+\d+\s+(?:shares?\s+of\s+)?[A-Za-z]{1,5}\b/i.test(question) && !OPTIONS_CONTEXT.test(question)) return null;

  const detected = detectStrategies(question);
  const { thesis, inferred: thesisInferred } = detectThesis(question, detected);

  const request: Partial<StrategyRequest> = {
    symbol: detectSymbol(question),
    thesis,
    expectedIvDirection: /\biv\s+(?:crush|fall|drop|decline|contract)|volatility\s+(?:falls?|drops?|crush)/i.test(question)
      ? "fall"
      : /\biv\s+(?:rise|rising|expan\w*|increase)|volatility\s+(?:rises?|expands?)/i.test(question)
        ? "rise"
        : "unchanged" as ExpectedIvDirection,
    allowedStrategies: detected.length > 0 ? detected : THESIS_DEFAULTS[thesis],
    maxPlannedLoss: 500,
    minRewardRisk: 1.5,
    minDte: 14,
    maxDte: 60,
    maxQuoteAgeSeconds: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    eventPolicy: "warn",
  };

  const targetMatch = question.match(/(?:target(?:\s+price)?(?:\s+of)?|reach(?:es|ing)?|hits?|(?:rall(?:y|ies)|drops?|falls?|moves?|goes?|climbs?)\s+to|\bto)\s*\$\s*(\d[\d,]*(?:\.\d+)?)/i)
    || question.match(/\btarget(?:\s+price)?(?:\s+of)?\s*(\d[\d,]*(?:\.\d+)?)/i);
  if (targetMatch) request.targetPrice = parseNumber(targetMatch[1]);

  const dteRange = question.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:dte|days? to expiration)/i);
  if (dteRange) {
    request.minDte = Number(dteRange[1]);
    request.maxDte = Number(dteRange[2]);
  } else {
    const minDte = question.match(/(?:dte\s*(?:>|over|above)|at least\s*)(\d+)\s*(?:dte|days? to expiration)/i);
    const maxDte = question.match(/(?:dte\s*(?:<|under|below)|(?:under|below|within|at most)\s*)(\d+)\s*(?:dte|days? to expiration)/i);
    if (minDte) request.minDte = Number(minDte[1]);
    if (maxDte) request.maxDte = Number(maxDte[1]);
  }
  request.targetDate = detectTargetDate(question, request.maxDte);

  const loss = question.match(/(?:max(?:imum)?\s+(?:planned\s+)?loss|risk(?:ing)?|budget|capital)\s*(?:of|under|below|<|at most|up to|:)?\s*\$?\s*(\d[\d,]*)/i);
  if (loss) request.maxPlannedLoss = parseNumber(loss[1]);
  const rr = question.match(/(?:reward\s*(?:\/|to)\s*risk|r\/r)\s*(?:>=|>|of|over|above|at least)?\s*(\d+(?:\.\d+)?)/i);
  if (rr) request.minRewardRisk = Number(rr[1]);
  const volume = question.match(/volume\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
  if (volume) request.minVolume = parseNumber(volume[1]);
  const oi = question.match(/(?:open\s*interest|oi)\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
  if (oi) request.minOpenInterest = parseNumber(oi[1]);
  const spread = question.match(/spread\s*(?:<|under|below|at most)\s*(\d+(?:\.\d+)?)\s*%/i);
  if (spread) request.maxSpreadPct = Number(spread[1]);
  const age = question.match(/quote\s*age\s*(?:<|under|below|at most)\s*(\d+)\s*(?:s|seconds?)/i);
  if (age) request.maxQuoteAgeSeconds = Number(age[1]);

  const strategyFilter: StrategyScreenFilter = {};
  const pop = question.match(/(?:pop|probability\s+of\s+profit|chance\s+of\s+profit)\s*(?:>|over|above|at least|of)?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (pop) strategyFilter.minProbabilityOfProfit = Number(pop[1]) / 100;
  const debit = question.match(/(?:net\s+)?debit\s*(?:<|under|below|at most)\s*\$?\s*(\d[\d,]*)/i);
  if (debit) strategyFilter.maxNetDebit = parseNumber(debit[1]);
  const credit = question.match(/(?:net\s+)?credit\s*(?:>|over|above|at least)\s*\$?\s*(\d[\d,]*)/i);
  if (credit) strategyFilter.minNetCredit = parseNumber(credit[1]);
  if (/\bfresh\s+quotes?\s+only\b|\bonly\s+fresh\b/i.test(question)) strategyFilter.requireFresh = true;

  const riskProfile: RiskProfile = /\b(conservative|safe|safer|low[- ]risk)\b/i.test(question)
    ? "conservative"
    : /\b(aggressive|high[- ]risk|speculative)\b/i.test(question)
      ? "aggressive"
      : "balanced";

  return {
    action: isBest ? "options_best_trade" : "options_strategies",
    filters: { request, riskProfile, strategyFilter, targetPriceInferred: false, thesisInferred },
  };
}

export const OPTIONS_STRATEGY_EXAMPLES = [
  "Screen call options for NVDA with delta above 0.35, 20 to 45 DTE, volume over 50, open interest above 500, spread under 10%",
  "Rank bullish NVDA call debit spreads and put credit spreads target $260 in 30 days max loss $500 reward/risk at least 1.5",
  "What is the best trade for NVDA bullish target $260 by 2026-11-20 max loss $500 conservative",
];

const money = (n: number | null | undefined) => (n === null || n === undefined ? "Unlimited" : `$${n.toFixed(2)}`);

export async function runOptionsStrategyAction(
  etrade: { client: ConstructorParameters<typeof DynamicOptionsScreener>[0]; fetchQuoteRemote(symbol: string): Promise<{ lastPrice: number }> },
  action: OptionsStrategyAction,
  filters: OptionsStrategyIntent["filters"] | undefined,
): Promise<{ count: number; status: string; summary: string; rows: Array<Record<string, unknown>>; validationError?: string; rejections?: unknown[]; quoteQuality?: unknown; bestTrade?: unknown }> {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  if (!filters?.request?.symbol) {
    return fail("I could not find an underlying ticker. Example: \"best trade for NVDA bullish target $260 max loss $500\".");
  }

  const request = { ...filters.request } as Partial<StrategyRequest>;
  let assumedTarget = false;
  if (request.targetPrice === undefined) {
    try {
      const quote = await etrade.fetchQuoteRemote(request.symbol!);
      const factor = request.thesis === "bearish" ? 0.95 : request.thesis === "large_move" ? 1.1 : request.thesis === "range_bound" ? 1 : 1.05;
      request.targetPrice = Number((quote.lastPrice * factor).toFixed(2));
      assumedTarget = true;
    } catch {
      return fail(`No target price given and a quote for ${request.symbol} was unavailable. Add one, e.g. "target $260".`);
    }
  }

  const validationError = validateStrategyRequest(request);
  if (validationError) return fail(validationError);

  const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
  const result = await pipeline.run(request as StrategyRequest, {
    strategyFilter: filters.strategyFilter,
    riskProfile: filters.riskProfile,
    alternatives: 3,
  });

  const assumptions = [
    assumedTarget ? `target price assumed at $${request.targetPrice} (${request.thesis})` : "",
    filters.thesisInferred ? `thesis assumed ${request.thesis}` : "",
  ].filter(Boolean).join("; ");
  const note = assumptions ? ` Assumptions: ${assumptions}.` : "";
  const freshness = result.snapshot.screen.quoteQuality?.staleContractsReturned
    ? ` ${result.snapshot.screen.quoteQuality.staleContractsReturned} contracts have stale quotes.`
    : "";
  const scan = `Evaluated ${result.snapshot.screen.contractsEvaluated} contracts, ${result.snapshot.screen.contractsMatched} eligible; ${result.strategies.candidates.length} strategies built, ${result.ranked.length} ranked.`;

  const rankedRows = result.ranked.map((r) => ({
    rank: r.rank,
    strategy: r.candidate.label,
    legs: r.candidate.legs.map((l) => `${l.side} ${l.quantity} ${l.symbol} ${l.strike}${l.optionType[0]}`).join(" / "),
    expiry: r.candidate.expirationDate,
    netDebitCredit: r.candidate.netDebit >= 0 ? `${money(r.candidate.netDebit)} debit` : `${money(-r.candidate.netDebit)} credit`,
    maxLoss: money(r.candidate.maxLoss),
    maxProfit: r.candidate.maxProfitUnbounded ? "Unlimited" : money(r.candidate.maxProfit),
    breakevens: r.candidate.breakevens.map((b) => `$${b}`).join(", ") || "N/A",
    probabilityOfProfit: `${(r.candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%`,
    targetRewardRisk: `${r.candidate.targetRewardRisk.toFixed(2)}x`,
    liquidity: r.candidate.liquidityScore.toFixed(0),
    compositeScore: r.compositeScore,
    quoteFreshness: r.candidate.dataFreshness,
  }));

  if (action === "options_strategies") {
    return {
      count: rankedRows.length,
      status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
      summary: `Options Strategy Screener (${request.symbol}, ${request.thesis}, ${filters.riskProfile} ranking): ${scan}${freshness}${note}`,
      rows: rankedRows,
      rejections: result.snapshot.rejections.slice(0, 15),
      quoteQuality: result.snapshot.screen.quoteQuality,
      validationError: result.snapshot.validationError,
    };
  }

  const pick = result.bestTrade;
  const headline = pick.best
    ? `Best trade (${pick.status.replace("_", " ")}, ${pick.confidence} confidence, ${pick.riskProfile} profile): ${pick.best.candidate.label}. ${pick.rationale.join(" ")}`
    : `No trade: ${pick.rationale.join(" ")}`;
  const planRows = (pick.tradePlan ?? []).map((leg) => ({
    section: "TRADE PLAN",
    action: leg.action,
    quantity: leg.quantity,
    contract: leg.contract,
    type: leg.optionType,
    strike: `$${leg.strike}`,
    expiration: leg.expiration,
    limitPrice: `$${leg.limitPrice.toFixed(2)}`,
  }));
  return {
    count: planRows.length,
    status: pick.status,
    summary: `${headline}${pick.blockers.length ? ` Blockers: ${pick.blockers.join(" ")}` : ""} ${scan}${freshness}${note} ${pick.disclaimer}`,
    rows: planRows.length > 0 ? planRows : rankedRows,
    rejections: result.snapshot.rejections.slice(0, 15),
    quoteQuality: result.snapshot.screen.quoteQuality,
    bestTrade: pick,
    validationError: result.snapshot.validationError,
  };
}
