/**
 * Natural-language entry points for the options strategy screener (capability 2)
 * and the best-trade picker (capability 3). Capability 1 (single-contract
 * screening) stays on the existing `options_screen` NLQ action.
 */

import { OptionsAgentPipeline } from "../trading/options";
import { defaultRegistry } from "../trading/options/strategies/catalog";
import { MAX_SCAN_SYMBOLS, OpportunityScanner, type ScanRequestTemplate } from "../trading/options/opportunityScanner";
import { DynamicOptionsScreener } from "../trading/optionsScreener";
import type {
  ExpectedIvDirection,
  OptionStrategyType,
  OptionThesis,
  StrategyRequest,
} from "../trading/options/strategyEngine";
import type { RiskProfile } from "../trading/options/recommendationAgent";
import { validateStrategyRequest, type StrategyScreenFilter } from "../trading/options/strategyRiskAgent";

export type OptionsStrategyAction = "options_strategies" | "options_best_trade" | "options_opportunities";

export type OpportunityScope =
  | { kind: "watchlist"; name?: string }
  | { kind: "symbols"; symbols: string[] }
  | { kind: "universe"; filters: Record<string, unknown>; maxSymbols: number };

export interface OptionsStrategyIntent {
  action: OptionsStrategyAction;
  filters: {
    request: Partial<StrategyRequest>;
    riskProfile: RiskProfile;
    strategyFilter: StrategyScreenFilter;
    targetPriceInferred: boolean;
    thesisInferred: boolean;
    scope?: OpportunityScope;
    showEvaluations?: boolean;
  };
}

const WATCHLIST_STOP = new Set(["MY", "THE", "A", "AN", "THIS", "EACH", "ANY", "ALL", "SAVED", "ONE"]);

function detectScope(question: string): OpportunityScope | null {
  // Contract-level screens (e.g. "Screen call options...") are handled by options_screen, not strategy opportunity scanner
  if (/\b(?:call|put)\s+options?\b/i.test(question) && !/\bstrateg\w*\b/i.test(question)) {
    return null;
  }

  if (/\bwatch\s?lists?\b/i.test(question)) {
    const quoted = question.match(/["'`]([^"'`]{1,40})["'`]/);
    const named = question.match(/\bwatch\s?lists?\s+(?:named\s+|called\s+)?([A-Za-z][\w-]*)/i);
    const prefixed = question.match(/\b([A-Za-z][\w-]*)\s+watch\s?lists?\b/i);
    const candidate = quoted?.[1] ?? [prefixed?.[1], named?.[1]].find((n) => n && !WATCHLIST_STOP.has(n.toUpperCase()) && !/^(for|in|on|from|across|scan|best|top|options?|trade|trades|with|max|bullish|bearish|conservative|aggressive)$/i.test(n));
    return { kind: "watchlist", name: candidate?.trim() };
  }
  const list = question.match(/\b[A-Z]{2,5}(?:\s*(?:,|and|&)\s*[A-Z]{2,5})+\b/);
  if (list) {
    const symbols = list[0].split(/\s*(?:,|and|&)\s*/).filter((s) => !NOT_TICKERS.has(s));
    if (symbols.length >= 2) return { kind: "symbols", symbols };
  }

  // If a single explicit symbol is provided (and not a multi-symbol list), single-symbol actions take precedence over broad scope
  if (detectSymbol(question)) {
    return null;
  }
  if (/\b(?:across|entire|whole|full)\b[^.]*\b(?:stocks?|market|universe|spectrum|listings)\b|\b(?:large|mega)[- ]?cap\b|\bmarket[- ]wide\b|\bacross\s+(?:the\s+)?(?:nasdaq|nyse|amex)\b/i.test(question)) {
    const filters: Record<string, unknown> = {};
    const cap = question.match(/market\s*cap(?:italization)?\s*(?:>|over|above|at least)\s*\$?([\d,.]+)\s*(t|b|m)?/i);
    if (cap) {
      const amount = parseNumber(cap[1]);
      const unit = (cap[2] || "b").toLowerCase();
      filters.minMarketCap = unit === "t" ? amount * 1000 : unit === "m" ? amount / 1000 : amount;
    } else if (/\bmega[- ]?cap\b/i.test(question)) filters.minMarketCap = 200;
    else filters.minMarketCap = 50;
    const price = question.match(/\b(?:price|priced|trading)\s+(?:between|from)\s*\$?([\d,.]+)\s*(?:and|to|-)\s*\$?([\d,.]+)/i);
    if (price) { filters.minPrice = parseNumber(price[1]); filters.maxPrice = parseNumber(price[2]); }
    const ex = question.match(/\b(nasdaq|nyse|amex)\b/i);
    if (ex) filters.exchange = ex[1].toUpperCase();
    if (/\b(gainers?|momentum)\b/i.test(question)) filters.gainersOnly = true;
    const top = question.match(/\b(?:top|first|up to|max(?:imum)?)\s*(\d+)\b/i);
    return { kind: "universe", filters, maxSymbols: Math.min(top ? Number(top[1]) : 10, MAX_SCAN_SYMBOLS) };
  }
  const underlyingsMatch = question.match(/(?:scan|screen|across|up to|max(?:imum)?)\s*(\d+)\s*underlyings\b/i);
  if (underlyingsMatch) {
    const filters: Record<string, unknown> = { minMarketCap: 50 };
    return { kind: "universe", filters, maxSymbols: Math.min(Number(underlyingsMatch[1]), MAX_SCAN_SYMBOLS) };
  }
  return null;
}

const NOT_TICKERS = new Set([
  "DTE", "IV", "OI", "ITM", "OTM", "ATM", "ETF", "PUT", "CALL", "NLQ", "USD", "POP", "RSI", "THE", "AND", "FOR",
  "BEST", "TOP", "PICK", "WITH", "LOSS", "MAX", "MIN", "RR", "A", "I", "IN", "ON", "TO", "OF",
]);

const OPTIONS_CONTEXT = /\b(options?|calls?|puts?|spreads?|straddles?|strangles?|condors?|debit|credit|iv|dte|delta|strike|strateg(?:y|ies)|max\s*profit|max\s*loss|underlyings?|iron\s*condor|covered\s*call|protective\s*put|collar|butterfly)\b/i;
const BEST_TRADE = /\b(?:best|top)\s+(?:\w+\s+){0,3}(?:trades?|plays?|strateg(?:y|ies)|spreads?|setups?)\b/i;
const PICK_TRADE = /\b(?:pick|choose|recommend|suggest|find)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+)?(?:\w+\s+){0,3}(?:trades?|strateg(?:y|ies)|spreads?)\b/i;
const STRATEGY_SCREEN = /\b(?:(?:find|screen|scan|search|show|get|list)?\s*(?:all\s+)?(?:options?\s+)?strateg(?:y|ies)(?:\s+(?:where|with|that|having|evaluated|ledger|screen|scan|screener))?|(?:all|every)\s+strateg(?:y|ies)|(?:debit|credit|vertical)\s+spreads?|straddles?|strangles?|iron\s+condors?|max\s*profit\s*(?:>|is\s*(?:more|greater|higher)\s*than)\s*max\s*loss)\b/i;

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

function registryPhrases(): Array<{ phrase: string; id: string }> {
  const out: Array<{ phrase: string; id: string }> = [];
  for (const def of defaultRegistry.list()) {
    for (const name of [def.label, ...def.aliases]) {
      const phrase = name.toLowerCase().replace(/[’']/g, "").trim();
      if (phrase.split(/\s+/).length >= 2 || phrase.length >= 6) out.push({ phrase, id: def.id });
    }
  }
  return out.sort((a, b) => b.phrase.length - a.phrase.length);
}

function detectStrategies(question: string): OptionStrategyType[] {
  const found = new Set<OptionStrategyType>();
  let q = question.toLowerCase().replace(/[’']/g, "");
  if (/\b(all|every|each)\s+(?:option\s+)?strateg(?:y|ies)\b|\ball\s+strategy\s+types\b/.test(q)) return ["all"];
  for (const { phrase, id } of registryPhrases()) {
    const re = new RegExp(`(?<![a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![a-z])`, "g");
    if (re.test(q)) {
      found.add(id);
      q = q.replace(re, " ");
    }
  }
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
  if (/\b(?:call|put)\s+options?\b/i.test(question) && !/\b(?:strateg\w*|credit\s+spread|debit\s+spread|vertical\s+spread|bull\s+spread|bear\s+spread|condor|straddle|strangle|butterfly|max\s*profit|max\s*loss)\b/i.test(question)) {
    return null;
  }

  const isBest = BEST_TRADE.test(question) && OPTIONS_CONTEXT.test(question)
    || /\bbest\s+(?:options?\s+)?(?:trade|play)\b/i.test(question)
    || (PICK_TRADE.test(question) && OPTIONS_CONTEXT.test(question));
  const isStrategies = STRATEGY_SCREEN.test(question);
  let scope = detectScope(question);

  const cleanedForStrategy = question.replace(/\b(?:bid[-/ ]?ask\s+spread|spread\s*(?:under|below|<|<=|at most|\d+\s*%))\b/gi, "");
  const hasStrategyKeywords = /\b(opportunit\w*|(?:option\s+)?trades?|trade\s+ideas?|spreads?|strateg\w*|best\s+trades?|condors?|straddles?|strangles?|butterfl\w*|max\s*profit|max\s*loss)\b/i.test(cleanedForStrategy);

  if (!isBest && !isStrategies && (!scope || !hasStrategyKeywords)) {
    if (!hasStrategyKeywords) return null;
  }

  if (!scope && !detectSymbol(question) && hasStrategyKeywords) {
    const underlyingsMatch = question.match(/(?:scan|screen|across|up to|max(?:imum)?)\s*(\d+)\s*underlyings\b/i);
    const count = underlyingsMatch ? Math.min(Number(underlyingsMatch[1]), MAX_SCAN_SYMBOLS) : 25;
    scope = { kind: "universe", filters: { minMarketCap: 50 }, maxSymbols: count };
  }

  const isScan = scope !== null
    && hasStrategyKeywords
    && !/\b(buy|sell)\s+\d+\b/i.test(question);
  if (!isBest && !isStrategies && !isScan) return null;
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
    allowedStrategies: detected.length > 0 ? detected : ["all"],
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

  // Max profit > max loss criteria
  if (
    /\bmax\s*profit\s*(?:is\s*)?(?:more|greater|higher|>)\s*(?:than)?\s*max\s*loss\b/i.test(question) ||
    /\bprofit\s*(?:is\s*)?(?:more|greater|higher|>)\s*(?:than)?\s*loss\b/i.test(question) ||
    /\breward\s*(?:is\s*)?(?:more|greater|higher|>)\s*(?:than)?\s*risk\b/i.test(question)
  ) {
    request.minRewardRisk = 1.0;
    strategyFilter.minRewardRisk = 1.0;
    strategyFilter.maxProfitGreaterThanMaxLoss = true;
  }

  const riskProfile: RiskProfile = /\b(conservative|safe|safer|low[- ]risk)\b/i.test(question)
    ? "conservative"
    : /\b(aggressive|high[- ]risk|speculative)\b/i.test(question)
      ? "aggressive"
      : "balanced";

  return {
    action: scope ? "options_opportunities" : isBest ? "options_best_trade" : "options_strategies",
    filters: {
      request, riskProfile, strategyFilter, targetPriceInferred: false, thesisInferred, scope: scope ?? undefined,
      showEvaluations: /\b(evaluated|ledger|accept(?:ed|ance)|reject(?:ed|ion)|why)\b/i.test(question) && /strateg/i.test(question),
    },
  };
}

export const OPTIONS_STRATEGY_EXAMPLES = [
  "Screen call options for NVDA with delta above 0.35, 20 to 45 DTE, volume over 50, open interest above 500, spread under 10%",
  "Rank bullish NVDA call debit spreads and put credit spreads target $260 in 30 days max loss $500 reward/risk at least 1.5",
  "What is the best trade for NVDA bullish target $260 by 2026-11-20 max loss $500 conservative",
  "Find the best bullish option trades across my Semis watchlist max loss $500",
  "Find best bullish option opportunities across large cap stocks top 10 max loss $500 conservative",
];

const money = (n: number | null | undefined) => (n === null || n === undefined ? "Unlimited" : `$${n.toFixed(2)}`);

interface LedgerEvaluation {
  id: string;
  label: string;
  category: string;
  status: "accepted" | "rejected" | "skipped";
  generated: number;
  accepted: number;
  summary: string;
  reasons: Array<{ reason: string; count: number }>;
}

/** One row per strategy category; candidateStrategies lists every strategy evaluated with its verdict and why. */
export function buildStrategyLedgerRows(
  evaluations: LedgerEvaluation[],
  bestScoreByStrategy: Map<string, number>,
  descriptions: Map<string, string>,
): Array<Record<string, unknown>> {
  const groups = new Map<string, LedgerEvaluation[]>();
  for (const e of evaluations) groups.set(e.category, [...(groups.get(e.category) ?? []), e]);
  return [...groups.entries()].map(([category, items]) => {
    const passed = items.filter((e) => e.status === "accepted");
    const failed = items.filter((e) => e.status !== "accepted");
    const scores = items.map((e) => bestScoreByStrategy.get(e.id)).filter((s): s is number => s !== undefined);
    const topReasons = new Map<string, number>();
    for (const e of failed) for (const r of e.reasons) topReasons.set(r.reason, (topReasons.get(r.reason) ?? 0) + r.count);
    const reason = passed.length === items.length
      ? `All ${items.length} ${category} strategies produced passing candidates.`
      : [...topReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([text, count]) => `${text} (${count})`).join("; ")
        || failed[0]?.summary
        || "No candidates built.";
    return {
      category,
      score: scores.length ? Math.max(...scores) : 0,
      passed: passed.length,
      failed: failed.length,
      reason,
      candidateStrategies: items.map((e) => ({
        id: e.id,
        name: e.label,
        status: e.status,
        why: e.status === "accepted" ? `${e.accepted} of ${e.generated} built candidates passed. ${e.summary}` : e.summary,
        description: descriptions.get(e.id) ?? "",
        score: bestScoreByStrategy.get(e.id),
      })),
    };
  });
}

export async function runOptionsStrategyAction(
  etrade: {
    client: ConstructorParameters<typeof DynamicOptionsScreener>[0];
    fetchQuoteRemote(symbol: string): Promise<{ lastPrice: number }>;
    getWatchlists(): Promise<Array<{ name: string; symbols: string[] }>>;
    screenMarketsAsync(filter?: any): Promise<{ stocks: Array<{ symbol: string; marketCap?: number }> }>;
  },
  action: OptionsStrategyAction,
  filters: OptionsStrategyIntent["filters"] | undefined,
): Promise<{ count: number; status: string; summary: string; rows: Array<Record<string, unknown>>; validationError?: string; rejections?: unknown[]; quoteQuality?: unknown; bestTrade?: unknown; evaluations?: unknown[]; nameLedger?: unknown[] }> {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  if (action === "options_opportunities" || !filters?.request?.symbol) {
    if (filters && !filters.scope) {
      filters.scope = { kind: "universe", filters: { minMarketCap: 50 }, maxSymbols: 25 };
    }
    return runOpportunityScan(etrade, filters);
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

  const bestScoreByStrategy = new Map<string, number>();
  for (const r of result.ranked) {
    bestScoreByStrategy.set(r.candidate.type, Math.max(bestScoreByStrategy.get(r.candidate.type) ?? 0, r.compositeScore));
  }
  const strategyDescriptions = new Map(defaultRegistry.list().map((def) => [def.id, def.description]));
  const evaluationRows = buildStrategyLedgerRows(result.strategies.evaluations, bestScoreByStrategy, strategyDescriptions);

  if (action === "options_strategies") {
    return {
      count: rankedRows.length,
      status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
      summary: `Options Strategy Screener (${request.symbol}, ${request.thesis}, ${filters.riskProfile} ranking): ${scan}${freshness}${note}`,
      rows: filters.showEvaluations ? evaluationRows : rankedRows,
      rejections: result.snapshot.rejections.slice(0, 15),
      quoteQuality: result.snapshot.screen.quoteQuality,
      validationError: result.snapshot.validationError,
      evaluations: result.strategies.evaluations,
      nameLedger: result.strategies.nameLedger,
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
    evaluations: result.strategies.evaluations,
    nameLedger: result.strategies.nameLedger,
    rejections: result.snapshot.rejections.slice(0, 15),
    quoteQuality: result.snapshot.screen.quoteQuality,
    bestTrade: pick,
    validationError: result.snapshot.validationError,
  };
}

async function runOpportunityScan(
  etrade: Parameters<typeof runOptionsStrategyAction>[0],
  filters: OptionsStrategyIntent["filters"] | undefined,
) {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  const scope = filters?.scope;
  if (!filters || !scope) return fail("Say where to look, e.g. \"across my Semis watchlist\" or \"across large cap stocks\".");

  let symbols: string[] = [];
  let scopeLabel = "";
  if (scope.kind === "symbols") {
    symbols = scope.symbols;
    scopeLabel = `${symbols.length} listed symbols`;
  } else if (scope.kind === "watchlist") {
    const lists = await etrade.getWatchlists();
    const chosen = scope.name ? lists.filter((l) => l.name.toLowerCase().includes(scope.name!.toLowerCase())) : lists;
    if (chosen.length === 0) {
      return fail(scope.name ? `No watchlist matching "${scope.name}". Say "list watchlists" to see yours.` : "You have no saved watchlists. Save one first, e.g. \"save these as watchlist Semis NVDA AMD AVGO\".");
    }
    symbols = chosen.flatMap((l) => l.symbols);
    scopeLabel = `watchlist ${chosen.map((l) => l.name).join(", ")}`;
  } else {
    const screened = await etrade.screenMarketsAsync(scope.filters);
    symbols = [...screened.stocks].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, scope.maxSymbols).map((s) => s.symbol);
    scopeLabel = `top ${symbols.length} stocks from the screened universe (${screened.stocks.length} matches)`;
  }
  if (symbols.length === 0) return fail("The selected scope contained no symbols.");

  const { symbol: _omit, targetPrice, ...rest } = filters.request;
  const template = { ...rest, targetPrice } as ScanRequestTemplate;
  const scanner = new OpportunityScanner(new DynamicOptionsScreener(etrade.client));
  const result = await scanner.scan(symbols, template, { riskProfile: filters.riskProfile, strategyFilter: filters.strategyFilter });

  const rows = result.opportunities.map((o, i) => {
    const c = o.pick.best!.candidate;
    return {
      rank: i + 1,
      symbol: o.symbol,
      underlyingPrice: money(o.underlyingPrice),
      strategy: c.label,
      legs: c.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
      expiry: c.expirationDate,
      netDebitCredit: c.netDebit >= 0 ? `${money(c.netDebit)} debit` : `${money(-c.netDebit)} credit`,
      maxLoss: money(c.maxLoss),
      maxProfit: c.maxProfitUnbounded ? "Unlimited" : money(c.maxProfit),
      probabilityOfProfit: `${(c.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%`,
      targetRewardRisk: `${c.targetRewardRisk.toFixed(2)}x`,
      score: o.score,
      status: o.pick.status.replace("_", " "),
      confidence: o.pick.confidence,
      quoteFreshness: c.dataFreshness,
    };
  });
  const skippedNote = result.skipped.length ? ` ${result.skipped.length} skipped (${result.skipped.slice(0, 3).map((s) => `${s.symbol}: ${s.reason}`).join("; ")}${result.skipped.length > 3 ? "; ..." : ""}).` : "";
  const truncNote = result.truncatedSymbols ? ` Only the first ${MAX_SCAN_SYMBOLS} symbols were scanned (${result.truncatedSymbols} not scanned) to stay within request limits.` : "";
  return {
    count: rows.length,
    status: rows.length > 0 ? "ranked_opportunities" : "no_opportunities",
    summary: `Opportunity scan over ${scopeLabel}: ${result.scanned} symbols scanned, ${result.withTrades} with a qualifying ${filters.request.thesis} trade (${filters.riskProfile} ranking).${skippedNote}${truncNote} Research only; verify live quotes and approve any order manually.`,
    rows,
  };
}
