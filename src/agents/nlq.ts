import { generateText, generateObject } from "ai";
import { getWorkersAIModel, DEFAULT_AI_MODEL, resolveAiModelName } from "./model";
import { z } from "zod";
import type { AgentScheduleItem, Env, ETradeQuote, OptionScreenRejection, StockScreenLedger, StockScreenResult } from "../types";
import type { DatabaseORM } from "../orm";
import { ETradeService } from "../services/etrade";
import {
  STATIC_FALLBACK_QUOTE_STATUS,
  isLiveQuoteStatus,
  isNonLivePricingQuoteStatus,
  nonLivePricingNotice,
} from "../trading/etrade/platform";
import { FossResearchService, weakestFossProvenance } from "../services/fossResearch";
import { resolveEnvironmentConfig } from "../config/environment";
import { DynamicOptionsScreener } from "../trading/optionsScreener";
import type { ScanRunStore } from "../trading/options/scanRunStore";
import type { ProfileRef } from "../trading/options/strategyProfile";
import type { StrategyProfileStore } from "../trading/options/strategyProfileStore";
import { parseOptionsStrategyIntent, runOptionsStrategyAction, type OptionsStrategyDeps, type OptionsStrategyIntent } from "./nlqOptionsStrategy";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../services/agenticPayments";
import { getDynamicLiveFlowItems, describeFlowProvenance } from "../trading/options/flows";
import { getCuratedStockBySymbol } from "../config/curatedStockUniverse";
import { getPlatformCapabilitiesDeskSummary } from "../services/platformKnowledge";
import { ETradeSlackTradingService } from "../trading/slack/agent";
import { ETradeBrowserService } from "../services/browserAgent";

export const nlqPlanSchema = z.object({
  domain: z.enum(["tables", "table_data", "category_mutation", "conversation", "trading", "research", "scheduling", "agentic_payments", "custom_query"]).default("conversation"),
  operation: z.enum(["list", "count", "search", "create", "update"]).default("list"),
  targetTable: z.string().optional(),
  categoryData: z
    .object({
      action: z.enum(["create", "update"]).optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
    })
    .optional(),
  tradingData: z
    .object({
      action: z
        .enum([
          "screen",
          "quote",
          "preview_order",
          "execute_order",
          "approve_order",
          "cancel_order",
          "positions",
          "capabilities",
          "options_screen",
          "options_strategies",
          "options_best_trade",
          "options_opportunities",
          "options_flow",
          "watchlist_save",
          "watchlist_list",
          "watchlist_details",
        ])
        .optional(),
      symbol: z.string().optional(),
      orderAction: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).optional(),
      quantity: z.number().optional(),
      orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
      limitPrice: z.number().optional(),
      relativePriceOffsetPercent: z.number().optional(),
      relativePriceDescription: z.string().optional(),
      filters: z.record(z.string(), z.any()).optional(),
      strategyFilter: z.record(z.string(), z.any()).optional(),
      request: z.record(z.string(), z.any()).optional(),
      scope: z.record(z.string(), z.any()).optional(),
      watchlistName: z.string().optional(),
      symbols: z.array(z.string()).optional(),
    })
    .optional(),
  researchData: z
    .object({
      action: z.enum(["quote", "fundamentals", "bars", "report", "snapshot", "compare"]).optional(),
      symbol: z.string().optional(),
      symbols: z.array(z.string()).optional(),
      provider: z.enum(["yfinance", "alpaca", "hybrid"]).optional(),
    })
    .optional(),
  scheduleData: z
    .object({
      action: z.enum(["list", "create", "cancel"]),
      scheduleType: z.enum(["delayed", "scheduled", "cron", "interval"]).optional(),
      callback: z.string().optional(),
      delayInSeconds: z.number().optional(),
      intervalSeconds: z.number().optional(),
      cron: z.string().optional(),
      date: z.string().optional(),
      scheduleId: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  agenticPaymentsData: z
    .object({
      action: z.enum(["wallet_status", "micropayments_list", "set_limit", "paid_scan", "paid_research"]),
      limitUSD: z.number().optional(),
      symbol: z.string().optional(),
      maxUnderlyings: z.number().int().positive().optional(),
      contractType: z.enum(["CALL", "PUT", "BOTH"]).optional(),
    })
    .optional(),
  planSource: z.enum(["llm", "fastpath", "fallback", "llm_validated"]).optional(),
  terms: z.string().max(200).default(""),
  role: z.enum(["user", "assistant", "any"]).default("any"),
  since: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
});

export type NLQPlan = z.infer<typeof nlqPlanSchema>;

export interface NLQValidationResult {
  validated: boolean;
  isValid?: boolean;
  model: string;
  domain: string;
  detectedDomain?: string;
  action?: string;
  suggestedAction?: string;
  interpretation: string;
  confidence?: number;
  corrected?: boolean;
  preventedStockScreenerFallback?: boolean;
}

export interface NLQQueryResult {
  plan: NLQPlan;
  count: number;
  domain: string;
  targetTable?: string;
  summary?: string;
  rows: Array<Record<string, unknown>>;
  executedAt: string;
  status?: string;
  reconciled?: boolean;
  planSource?: "llm" | "fastpath" | "fallback" | "llm_validated";
  llmValidation?: NLQValidationResult;
  discrepancy?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  /** Issue #27: id of the persisted scan run (options_opportunities
   *  only, when the caller threaded a ScanRunStore through). */
  scanRunId?: string;
  /** Issue #27: whether the scan run was persisted; false means a
   *  store was supplied but its save failed (the scan still succeeded). */
  persisted?: boolean;
  /** Issue #28: the saved strategy profile an options action ran under
   *  (id + name + version), when one was selected in the question. */
  profileRef?: ProfileRef | null;
  scanLedger?: StockScreenLedger | Record<string, unknown>;
  discovery?: StockScreenResult["discovery"];
  validationError?: string;
  quoteQuality?: {
    maxAgeSeconds?: number;
    referenceAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  rejections?: OptionScreenRejection[];
  fetchErrors?: Array<{ symbol: string; reason: string }>;
  warnings?: string[];
  displayMarkdown?: string;
  movers?: StockScreenResult["movers"];
}

/**
 * Issue #109: narrow port over the hosting Agent's Cloudflare Agents
 * scheduling API. The orchestrator binds its own schedule /
 * scheduleEvery / cancelSchedule / listSchedules methods into this
 * shape and injects it through the NLQ execution deps, so scheduling
 * plans arm REAL SDK schedules (persisted in cf_agent_schedules) and
 * return REAL schedule ids. Contexts without a port (e.g. the MCP
 * facade) get honest failures from the scheduling executor instead of
 * fabricated success.
 */
export interface NLQSchedulingPort {
  schedule(
    when: Date | string | number,
    callback: string,
    payload?: unknown,
    options?: { idempotent?: boolean }
  ): Promise<AgentScheduleItem>;
  scheduleEvery(intervalSeconds: number, callback: string, payload?: unknown): Promise<AgentScheduleItem>;
  cancelSchedule(id: string): Promise<boolean>;
  listSchedules(): Promise<AgentScheduleItem[]>;
}

/** Execution deps for executeNLQQueryAsync: the options-strategy deps
 *  plus the optional scheduling port (issue #109). */
export interface NLQExecutionDeps extends OptionsStrategyDeps {
  schedulingPort?: NLQSchedulingPort;
}

const STOP_WORDS_REGEX = /\b(questions?|messages?|chats?|history|transcript|conversations?|asked|queries|all|results?|references?|containing|contains|with|for|about|find|show|list|get|any|where|me)\b/gi;

export function extractOrderParameters(question: string): {
  orderAction: "BUY" | "SELL" | "SELL_SHORT" | "BUY_TO_COVER";
  quantity: number;
  symbol: string;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: number;
  relativePriceOffsetPercent?: number;
  relativePriceDescription?: string;
} | null {
  const isOrderIntent = /\b(buy|purchase|sell|short|cover|order\s+to\s+buy|order\s+to\s+sell|place\s+(?:an?\s+)?order|draft\s+(?:an?\s+)?order)\b/i.test(question);
  if (!isOrderIntent || /\b(messages?|categories|tables?)\b/i.test(question)) {
    return null;
  }

  // 1. Action
  let orderAction: "BUY" | "SELL" | "SELL_SHORT" | "BUY_TO_COVER" = "BUY";
  if (/\b(sell\s*short|short)\b/i.test(question)) {
    orderAction = "SELL_SHORT";
  } else if (/\b(buy\s*to\s*cover|cover)\b/i.test(question)) {
    orderAction = "BUY_TO_COVER";
  } else if (/\bsell\b/i.test(question)) {
    orderAction = "SELL";
  } else {
    orderAction = "BUY";
  }

  // 2. Quantity
  let quantity = 1;
  const wordToNumber: Record<string, number> = {
    one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    fifteen: 15, twenty: 20, twentyfive: 25, fifty: 50, hundred: 100,
  };

  const qtyMatch = question.match(
    /\b(?:buy|sell|short|purchase|cover)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|a|an)\b/i
  ) || question.match(/\b(\d+)\s*(?:shares?|contracts?|lots?|units?|orders?|stocks?)\b/i);

  if (qtyMatch) {
    const rawQty = qtyMatch[1].toLowerCase();
    if (/^\d+$/.test(rawQty)) {
      quantity = parseInt(rawQty, 10);
    } else if (wordToNumber[rawQty] !== undefined) {
      quantity = wordToNumber[rawQty];
    }
  } else {
    if (/\b(?:a|an)\s+(?:share|order|lot|contract|unit|stock)\b/i.test(question)) {
      quantity = 1;
    } else {
      quantity = 10;
    }
  }

  // 3. Symbol Extraction
  const NON_TICKER_WORDS = new Set([
    "BUY", "SELL", "SHORT", "PURCHASE", "COVER",
    "ORDER", "ORDERS", "SHARE", "SHARES", "STOCK", "STOCKS",
    "CONTRACT", "CONTRACTS", "LOT", "LOTS", "UNIT", "UNITS",
    "POSITION", "POSITIONS",
    "OF", "AT", "FOR", "IN", "ON", "TO", "FROM", "WITH", "BY",
    "A", "AN", "THE", "SOME", "ALL",
    "MARKET", "LIMIT", "PRICE", "PRICED", "SPOT", "QUOTE",
    "PERCENT", "PCT", "DISCOUNT", "PREMIUM", "BELOW", "UNDER", "ABOVE", "OVER",
    "LESS", "MORE", "THAN", "OFF",
    "DOLLAR", "DOLLARS", "CENT", "CENTS", "USD",
    "PLEASE", "WANT", "LIKE", "DRAFT", "PLACE", "SUBMIT", "CONFIRM", "EXECUTE",
    "TODAY", "NOW", "CURRENT", "LIVE",
  ]);

  let symbol = "";

  // Pattern A: "buy 1 order of nvda" / "buy 10 shares of aapl" / "buy 10 nvda"
  const structuredSymbolMatch = question.match(
    /\b(?:buy|sell|short|purchase|cover)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|a|an)?\s*(?:(?:shares?|orders?|contracts?|lots?|units?|stocks?)\s*(?:of\s*)?|of\s+)?([A-Za-z]{1,5})\b/i
  );

  if (structuredSymbolMatch && !NON_TICKER_WORDS.has(structuredSymbolMatch[1].toUpperCase())) {
    symbol = structuredSymbolMatch[1].toUpperCase();
  }

  // Pattern B: Look for "... of <ticker>" e.g. "order of nvda", "shares of nvda"
  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    const ofMatch = question.match(/\b(?:order|orders|share|shares|stock|stocks|contract|contracts|lot|lots|unit|units)\s+of\s+([A-Za-z]{1,5})\b/i);
    if (ofMatch && !NON_TICKER_WORDS.has(ofMatch[1].toUpperCase())) {
      symbol = ofMatch[1].toUpperCase();
    }
  }

  // Pattern C: Check known curated stock universe tickers in question
  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    const tokens = question.split(/[^A-Za-z0-9]+/).map(t => t.toUpperCase()).filter(t => t.length >= 1 && t.length <= 5);
    for (const token of tokens) {
      if (!NON_TICKER_WORDS.has(token)) {
        const curated = getCuratedStockBySymbol(token);
        if (curated) {
          symbol = token;
          break;
        }
      }
    }
  }

  // Pattern D: Fallback to first non-blacklisted token
  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    const tokens = question.split(/[^A-Za-z0-9]+/).map(t => t.toUpperCase()).filter(t => t.length >= 1 && t.length <= 5);
    for (const token of tokens) {
      if (!NON_TICKER_WORDS.has(token)) {
        symbol = token;
        break;
      }
    }
  }

  if (!symbol || NON_TICKER_WORDS.has(symbol)) {
    return null;
  }

  // 4. Pricing / Limit Price / Relative Offset
  let orderType: "MARKET" | "LIMIT" = "MARKET";
  let limitPrice: number | undefined = undefined;
  let relativePriceOffsetPercent: number | undefined = undefined;
  let relativePriceDescription: string | undefined = undefined;

  // Relative Discount (below market)
  const discountMatch = question.match(
    /(?:at|with)?\s*(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:below|under|discount(?:\s+(?:to|from))?|less\s+than|off)\s*(?:market(?:\s+price)?|spot|current\s+price|price)?/i
  );
  if (discountMatch) {
    const pct = parseFloat(discountMatch[1]);
    relativePriceOffsetPercent = -pct;
    relativePriceDescription = `${pct}% below market price`;
    orderType = "LIMIT";
  }

  // Relative Premium (above market)
  const premiumMatch = question.match(
    /(?:at|with)?\s*(?:a\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:above|over|premium(?:\s+(?:to|from))?|more\s+than)\s*(?:market(?:\s+price)?|spot|current\s+price|price)?/i
  );
  if (premiumMatch) {
    const pct = parseFloat(premiumMatch[1]);
    relativePriceOffsetPercent = pct;
    relativePriceDescription = `${pct}% above market price`;
    orderType = "LIMIT";
  }

  // Explicit Dollar Limit
  const explicitLimitMatch = question.match(
    /(?:limit\s*(?:at|of|price)?\s*\$?|at\s+\$|for\s+\$)(\d+(?:\.\d+)?)\b/i
  );
  if (explicitLimitMatch && relativePriceOffsetPercent === undefined) {
    limitPrice = parseFloat(explicitLimitMatch[1]);
    orderType = "LIMIT";
  }

  // If relative offset is given, compute baseline limit price from curated stock if available
  if (relativePriceOffsetPercent !== undefined && limitPrice === undefined) {
    const curated = getCuratedStockBySymbol(symbol);
    if (curated?.defaultPrice && curated.defaultPrice > 0) {
      limitPrice = Number((curated.defaultPrice * (1 + relativePriceOffsetPercent / 100)).toFixed(2));
    }
  }

  return {
    orderAction,
    quantity,
    symbol,
    orderType,
    limitPrice,
    relativePriceOffsetPercent,
    relativePriceDescription,
  };
}

export function planWithRules(question: string): NLQPlan {
  const qLower = question.toLowerCase();

  // 0. Fast-path for Cloudflare Agents Task Scheduling
  // 0a. List active schedules
  if (
    /\b(list|show|view|get)\s+(?:all\s+)?(?:active\s+)?(?:agent\s+)?(?:schedules?|scheduled\s+tasks?|cron\s+jobs?|alarms?)\b/i.test(question) ||
    /^(?:schedules?|scheduled\s+tasks?|list\s+schedules?)$/i.test(question.trim())
  ) {
    return {
      domain: "scheduling",
      operation: "list",
      scheduleData: {
        action: "list",
      },
      terms: "schedules",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 0b. Cancel a schedule by ID
  const cancelSchedMatch = question.match(/\b(?:cancel|delete|remove|stop|drop)\s+(?:schedule|task|alarm)\s+([a-zA-Z0-9_\-\.]+)\b/i);
  if (cancelSchedMatch) {
    const targetId = cancelSchedMatch[1].trim();
    return {
      domain: "scheduling",
      operation: "update",
      scheduleData: {
        action: "cancel",
        scheduleId: targetId,
      },
      terms: targetId,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0c. Set a reminder (delayed schedule)
  const reminderMatch =
    question.match(/\bremind\s+(?:me\s+)?(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(mins?|minutes?|secs?|seconds?|hours?|hrs?)\b/i) ||
    question.match(/\bin\s+(\d+)\s*(mins?|minutes?|secs?|seconds?|hours?|hrs?)\s*,?\s*remind\s+(?:me\s+)?(?:to\s+)?(.+)\b/i);
  if (reminderMatch) {
    const isPrefix = /^\s*in\s+\d+/i.test(question);
    const num = Number(isPrefix ? reminderMatch[1] : reminderMatch[2]) || 1;
    const unit = (isPrefix ? reminderMatch[2] : reminderMatch[3]).toLowerCase();
    const taskDesc = (isPrefix ? reminderMatch[3] : reminderMatch[1]).trim();
    const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("s") ? 1 : 60;
    const delayInSeconds = num * multiplier;

    return {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "delayed",
        callback: "sendScheduledReminder",
        delayInSeconds,
        description: taskDesc,
      },
      terms: taskDesc,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0d. Schedule a recurring market screen interval or cron
  const screenIntervalMatch = question.match(/\b(?:schedule|run)\s+(?:market\s+)?(?:screen|screener|scan)\s+every\s+(\d+)\s*(mins?|minutes?|secs?|seconds?)\b/i);
  if (screenIntervalMatch) {
    const num = Number(screenIntervalMatch[1]) || 5;
    const unit = screenIntervalMatch[2].toLowerCase();
    const intervalSeconds = unit.startsWith("m") ? num * 60 : num;

    return {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "interval",
        callback: "autonomousMarketScreen",
        intervalSeconds,
        description: `Autonomous market screen every ${intervalSeconds} seconds`,
      },
      terms: "market_screen",
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0e. Fast-path for Cloudflare Agentic Payments & Agent Wallet
  if (
    /\b(wallet\s+status|agent\s+wallet|agentic\s+wallet|wallet\s+balance|micropayments?|x402|mpp)\b/i.test(question) ||
    /\b(set|update|change)\s+(?:the\s+)?(?:auto\s*[-]?\s*approve\s+)?(?:agent\s+)?limit\b/i.test(question)
  ) {
    if (/\b(set|update|change)\s+(?:the\s+)?(?:auto\s*[-]?\s*approve\s+)?(?:agent\s+)?limit\b/i.test(question)) {
      const limitMatch = question.match(/\$?\s*(\d+(?:\.\d+)?)/);
      const limitUSD = limitMatch ? parseFloat(limitMatch[1]) : 0.05;
      return {
        domain: "agentic_payments",
        operation: "update",
        agenticPaymentsData: {
          action: "set_limit",
          limitUSD,
        },
        terms: "set_limit",
        role: "any",
        since: null,
        limit: 1,
      };
    }
    if (/\b(transactions?|ledger|history|payments?)\b/i.test(question)) {
      return {
        domain: "agentic_payments",
        operation: "list",
        agenticPaymentsData: {
          action: "micropayments_list",
        },
        terms: "micropayments",
        role: "any",
        since: null,
        limit: 25,
      };
    }
    return {
      domain: "agentic_payments",
      operation: "list",
      agenticPaymentsData: {
        action: "wallet_status",
      },
      terms: "wallet_status",
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0f. Fast-path for Paid Trading Services with Agentic Payment
  if (/\b(paid\s+options?\s+screen|premium\s+options?\s+screen|paid\s+research|premium\s+market\s+research)\b/i.test(question)) {
    const isResearch = /\b(research)\b/i.test(question);
    const symMatch = question.match(/\b(?:for|on|symbol|ticker)\s+([a-zA-Z]{1,5})\b/i);
    const symbol = symMatch ? symMatch[1].toUpperCase() : undefined;
    const underlyingLimitMatch = question.match(/(?:up to|max(?:imum)?|limit to)\s*(\d+)\s*(?:underlyings|symbols|stocks|tickers)\b/i);
    const contractType = /\bputs?\b/i.test(question) && !/\bcalls?\b/i.test(question)
      ? "PUT" as const
      : /\bcalls?\b/i.test(question) && !/\bputs?\b/i.test(question)
      ? "CALL" as const
      : "BOTH" as const;
    return {
      domain: "agentic_payments",
      operation: "create",
      agenticPaymentsData: {
        action: isResearch ? "paid_research" : "paid_scan",
        ...(symbol ? { symbol } : {}),
        ...(underlyingLimitMatch ? { maxUnderlyings: Number(underlyingLimitMatch[1]) } : {}),
        contractType,
      },
      terms: symbol || "paid_options_screen",
      role: "any",
      since: null,
      limit: 10,
    };
  }

  // 1. Fast-path for Category addition or update (check before generic tables)
  const addCatMatch = question.match(/\b(?:add|create|insert|new)\s+category\s+["']?([^"']+)["']?/i);
  if (addCatMatch) {
    const rawName = addCatMatch[1].replace(/\bto\s+categories\s+tables?\b/i, "").trim();
    return {
      domain: "category_mutation",
      operation: "create",
      categoryData: {
        action: "create",
        name: rawName,
        description: `Category for ${rawName} referral and partner links`,
        icon: "🏷️",
      },
      terms: rawName,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // Strategy-ledger requests must win over generic "table" and "ledger" queries.
  const strategyIntent = parseOptionsStrategyIntent(question);
  if (strategyIntent) {
    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: strategyIntent.action,
        symbol: strategyIntent.filters.request.symbol,
        filters: strategyIntent.filters as unknown as Record<string, any>,
        strategyFilter: strategyIntent.filters.strategyFilter as Record<string, any> | undefined,
        request: strategyIntent.filters.request as Record<string, any> | undefined,
        scope: strategyIntent.filters.scope as Record<string, any> | undefined,
      },
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 2. Fast-path intent detection for database tables & schema
  if (/\b(tables?|schema|databases?|columns?|catalog)\b/i.test(question) && !/\b(messages?|chats?|categories)\b/i.test(question)) {
    return {
      domain: "tables",
      operation: "list",
      terms: "",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3. Fast-path for Table data queries
  if (/\b(categories|referrals|ads|external ads|transactions|ledger|events|memory)\b/i.test(question)) {
    let target = "mas_categories";
    if (/\b(categories)\b/i.test(question)) {
      target = "mas_categories";
    } else if (/\b(referrals?|links?)\b/i.test(question)) {
      target = "mas_referrals";
    } else if (/\b(external\s*ads?)\b/i.test(question)) {
      target = "mas_external_ads";
    } else if (/\b(ads?|marketplace)\b/i.test(question)) {
      target = "mas_ads";
    } else if (/\b(transactions?|payments?|charges?|refunds?)\b/i.test(question)) {
      target = "mas_transactions";
    } else if (/\b(events?|audit)\b/i.test(question)) {
      target = "mas_events";
    } else if (/\b(memory|facts?)\b/i.test(question)) {
      target = "mas_memory";
    }

    return {
      domain: "table_data",
      operation: "list",
      targetTable: target,
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 50,
    };
  }

  // 3b. Fast-path for Watchlists (Save / Create / List)
  let saveWatchlistMatch: { name: string; symbolsText?: string } | null = null;

  const m1 = question.match(/\bsave\s+(.+?)\s+(?:as|to|into)\s+(?:a\s+)?watchlist\s*(?:named\s+|called\s+)?["']?([^"']+)["']?/i);
  if (m1) {
    saveWatchlistMatch = { name: m1[2].trim(), symbolsText: m1[1].trim() };
  } else {
    const m2 = question.match(/\bsave\s+(?:as|to|into)\s+(?:a\s+)?watchlist\s*(?:named\s+|called\s+)?["']?([^"']+)["']?/i);
    if (m2) {
      saveWatchlistMatch = { name: m2[1].trim() };
    } else {
      const m3 = question.match(/\bcreate\s+(?:a\s+)?watchlist\s*(?:named\s+|called\s+)?["']?([^"'\s]+)["']?(?:\s+with\s+(.+))?/i);
      if (m3) {
        saveWatchlistMatch = { name: m3[1].trim(), symbolsText: m3[2]?.trim() };
      }
    }
  }

  if (saveWatchlistMatch) {
    const rawName = saveWatchlistMatch.name;
    const symbolsRaw = saveWatchlistMatch.symbolsText || "";
    const explicitSymbols = symbolsRaw
      ? symbolsRaw
          .split(/[,\s]+/)
          .map((s) => s.replace(/[^A-Za-z]/g, "").toUpperCase())
          .filter((s) => s.length >= 1 && s.length <= 5 && !["THESE", "THE", "ALL", "SCREENED", "STOCKS", "RESULTS", "OPTIONS"].includes(s))
      : [];

    return {
      domain: "trading",
      operation: "create",
      tradingData: {
        action: "watchlist_save",
        watchlistName: rawName,
        symbols: explicitSymbols,
      },
      terms: rawName,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  if (/\b(list|show|view|get)\s+(?:all\s+)?(?:my\s+)?watchlists?\b/i.test(question) || /^(?:watchlists?|my\s+watchlists?)$/i.test(question.trim())) {
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "watchlist_list",
      },
      terms: "watchlists",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3b-2. Fast-path for Options Flow Queries
  if (
    /\b(options?\s+flows?|unusual\s+options?|options?\s+sweeps?|institutional\s+flows?|bullish\s+flows?|bearish\s+flows?)\b/i.test(question) ||
    (/\bflows?\b/i.test(question) && /\b(calls?|puts?|sweeps?|blocks?|options?)\b/i.test(question))
  ) {
    const symMatch = question.match(/\b(?:for|on|in)\s+([A-Za-z]{1,5})\b/i) || question.match(/\b([A-Za-z]{1,5})\s+(?:options?\s+)?flows?\b/i);
    const sym = symMatch && !["FLOW", "FLOWS", "OPTION", "OPTIONS", "SWEEP", "SWEEPS", "BLOCK", "BLOCKS", "CALL", "CALLS", "PUT", "PUTS"].includes(symMatch[1].toUpperCase())
      ? symMatch[1].toUpperCase()
      : undefined;

    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: "options_flow",
        symbol: sym,
        filters: {
          symbol: sym,
          bullishOnly: /\bbullish\b/i.test(question),
          bearishOnly: /\bbearish\b/i.test(question),
          sweepsOnly: /\bsweeps?\b/i.test(question),
          unusualOnly: /\bunusual\b/i.test(question),
        },
      },
      terms: sym ? `${sym} options flow` : "options flow",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3c. Fast-path for Options Screening
  if (
    (/\b(options?|contracts?)\b/i.test(question) && /\b(screen|screener|scan|scanning|scanned|filter|chains?)\b/i.test(question)) ||
    /\b(call|put)\s+options?\b/i.test(question) ||
    (/\boptions?\b/i.test(question) && /\b(delta|iv|implied\s+volatility|gamma|theta|dte|strike|moneyness)\b/i.test(question)) ||
    /\b(max\s*profit|max\s*loss|credit\s*spread|debit\s*spread|iron\s*condor|straddle|strangle|underlyings?)\b/i.test(question)
  ) {
    const optFilters: Record<string, any> = {};

    if (/\b(call|calls)\b/i.test(question) && !/\b(put|puts)\b/i.test(question)) optFilters.contractType = "CALL";
    else if (/\b(put|puts)\b/i.test(question) && !/\b(call|calls)\b/i.test(question)) optFilters.contractType = "PUT";
    else optFilters.contractType = "BOTH";

    // Underlying symbol e.g. "for NVDA", "NVDA options"
    const symMatch = question.match(/\b(?:for|on|in)\s+([A-Za-z]{1,5})\b/i) || question.match(/\b([A-Za-z]{1,5})\s+options?\b/i);
    if (symMatch && !["CALL", "PUTS", "CALLS", "PUT", "TECH", "RSI", "MACD"].includes(symMatch[1].toUpperCase())) {
      optFilters.underlyingSymbols = [symMatch[1].toUpperCase()];
    }

    if (/\b(tech|technology)\b/i.test(question)) optFilters.sector = "Technology";
    if (/\b(semiconductor|semis|chips)\b/i.test(question)) optFilters.sector = "Semiconductors";

    // Delta filters
    const deltaOverMatch = question.match(/delta\s*(?:>|over|greater than|above)\s*(0?\.\d+|\d+)/i);
    if (deltaOverMatch) optFilters.minDelta = Number(deltaOverMatch[1]) > 1 ? Number(deltaOverMatch[1]) / 100 : Number(deltaOverMatch[1]);
    const deltaUnderMatch = question.match(/delta\s*(?:<|under|less than|below)\s*(0?\.\d+|\d+)/i);
    if (deltaUnderMatch) optFilters.maxDelta = Number(deltaUnderMatch[1]) > 1 ? Number(deltaUnderMatch[1]) / 100 : Number(deltaUnderMatch[1]);

    const gammaOverMatch = question.match(/gamma\s*(?:>|over|greater than|above)\s*(-?\d*\.?\d+)/i);
    if (gammaOverMatch) optFilters.minGamma = Number(gammaOverMatch[1]);
    const gammaUnderMatch = question.match(/gamma\s*(?:<|under|less than|below)\s*(-?\d*\.?\d+)/i);
    if (gammaUnderMatch) optFilters.maxGamma = Number(gammaUnderMatch[1]);
    const thetaOverMatch = question.match(/theta\s*(?:>|over|greater than|above)\s*(-?\d*\.?\d+)/i);
    if (thetaOverMatch) optFilters.minTheta = Number(thetaOverMatch[1]);
    const thetaUnderMatch = question.match(/theta\s*(?:<|under|less than|below)\s*(-?\d*\.?\d+)/i);
    if (thetaUnderMatch) optFilters.maxTheta = Number(thetaUnderMatch[1]);

    const dteRangeMatch = question.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:dte|days? to expiration)/i);
    if (dteRangeMatch) {
      optFilters.minDte = Number(dteRangeMatch[1]);
      optFilters.maxDte = Number(dteRangeMatch[2]);
    } else {
      const minDteMatch = question.match(/(?:dte\s*(?:>|over|greater than|above)|(?:over|above|at least)\s*)(\d+)\s*(?:dte|days? to expiration)?/i);
      const maxDteMatch = question.match(/(?:dte\s*(?:<|under|less than|below)|(?:under|below|within|at most)\s*)(\d+)\s*(?:dte|days? to expiration)?/i);
      if (minDteMatch) optFilters.minDte = Number(minDteMatch[1]);
      if (maxDteMatch) optFilters.maxDte = Number(maxDteMatch[1]);
    }

    const minVolumeMatch = question.match(/volume\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
    if (minVolumeMatch) optFilters.minVolume = Number(minVolumeMatch[1].replace(/,/g, ""));
    const minOiMatch = question.match(/(?:open\s*interest|oi)\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
    if (minOiMatch) optFilters.minOpenInterest = Number(minOiMatch[1].replace(/,/g, ""));
    const maxSpreadMatch = question.match(/spread\s*(?:<|under|below|at most)\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (maxSpreadMatch) optFilters.maxSpreadPct = Number(maxSpreadMatch[1]);
    const quoteAgeMatch = question.match(/quote\s*age\s*(?:<|under|below|at most)\s*(\d+)\s*(?:s|seconds?)/i);
    if (quoteAgeMatch) optFilters.maxQuoteAgeSeconds = Number(quoteAgeMatch[1]);
    const maxUnderlyingsMatch = question.match(/(?:up to|max(?:imum)?|limit to)\s*(\d+)\s*(?:underlyings|symbols|stocks|tickers)\b/i);
    if (maxUnderlyingsMatch) optFilters.maxUnderlyings = Number(maxUnderlyingsMatch[1]);
    const contractLimitMatch = question.match(/(?:top|limit(?: to)?|up to)\s*(\d+)\s*(?:contracts|options)\b/i);
    if (contractLimitMatch) optFilters.limit = Number(contractLimitMatch[1]);

    // IV filters
    const ivOverMatch = question.match(/iv\s*(?:>|over|above|greater than)\s*(\d+)%?/i) || question.match(/implied\s+volatility\s*(?:>|over|above)\s*(\d+)%?/i);
    if (ivOverMatch) optFilters.minImpliedVolatility = Number(ivOverMatch[1]) / 100;
    if (/\b(high\s*iv|unusual\s*volume)\b/i.test(question)) optFilters.minImpliedVolatility = 0.50;

    // Moneyness
    if (/\b(itm|in the money)\b/i.test(question)) optFilters.moneyness = "ITM";
    else if (/\b(otm|out of the money)\b/i.test(question)) optFilters.moneyness = "OTM";
    else if (/\b(atm|at the money)\b/i.test(question)) optFilters.moneyness = "ATM";

    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: "options_screen",
        filters: optFilters,
      },
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3b. Fast-path for Platform Capabilities, Discovery & General Assistance
  const isCapabilitiesQuery =
    /\b(capabilities|capability|features?|workflows?|what\s+can\s+(?:you|this\s+desk|the\s+agent|the\s+platform)\s+do|how\s+to\s+use|help|overview|menu|what\s+do\s+you\s+support|what\s+are\s+the\s+capabilities)\b/i.test(question) ||
    /^(?:find|search|explore|help|lookup|start|menu|show\s+me|show)$/i.test(question.trim());

  const isExplicitConversationQuery = /\b(messages?|chat\s+history|transcripts?|conversation\s+records?|conversations?|user\s+said|i\s+said|what\s+did\s+i\s+ask)\b/i.test(question);

  if (isCapabilitiesQuery && !isExplicitConversationQuery) {
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "capabilities",
      },
      terms: "platform capabilities",
      role: "any",
      since: null,
      limit: 14,
    };
  }

  // 4. Fast-path for E*TRADE Stock Screening / Market Scanning
  const isOptionsOrStrategy = /\b(options?|contracts?|chains?|calls?|puts?|delta|dte|strike|iv|implied\s+volatility|max\s*profit|max\s*loss|spreads?|condors?|straddles?|strangles?|underlyings?|strateg\w*)\b/i.test(question);
  if (
    !isOptionsOrStrategy &&
    (/\b(screen|screener|scan|scanning|scanned|breakout|oversold|overbought|gainers?|losers?|momentum)\b/i.test(question) ||
    ( /\b(stocks?|equities|listings)\b/i.test(question) && /\b(tech|semiconductor|rsi|macd|pe|p\/e|cap|volume|dividend|growth|price|priced|exchange|nasdaq|nyse|amex)\b/i.test(question)))
  ) {
    const filters: Record<string, any> = {};
    // Keep unsupported filters in the plan so the listing provider can explain why they cannot be applied.
    if (/\b(tech|technology)\b/i.test(question)) filters.sector = "Technology";
    if (/\b(semiconductor|semis|chips)\b/i.test(question)) filters.sector = "Semiconductors";
    if (/\b(cloud|enterprise|software)\b/i.test(question)) filters.sector = "Enterprise Software";
    if (/\b(crypto|bitcoin|fintech)\b/i.test(question)) filters.sector = "Fintech & Crypto";
    if (/\b(financials?|finance|banks?)\b/i.test(question)) filters.sector = "Financial";
    if (/\b(healthcare?|pharma|biotech)\b/i.test(question)) filters.sector = "Healthcare";
    if (/\b(energy|oil|gas)\b/i.test(question)) filters.sector = "Energy";

    const rsiUnderMatch = question.match(/rsi\s*(?:<|under|less than|below)\s*(\d+)/i);
    if (rsiUnderMatch) filters.maxRsi = Number(rsiUnderMatch[1]);
    const rsiOverMatch = question.match(/rsi\s*(?:>|over|greater than|above)\s*(\d+)/i);
    if (rsiOverMatch) filters.minRsi = Number(rsiOverMatch[1]);

    const priceRangeMatch = question.match(/\b(?:price|priced|trading)\s+(?:between|from)\s*\$?([\d,.]+)\s*(?:and|to|-)\s*\$?([\d,.]+)/i);
    if (priceRangeMatch) {
      filters.minPrice = Number(priceRangeMatch[1].replace(/,/g, ""));
      filters.maxPrice = Number(priceRangeMatch[2].replace(/,/g, ""));
    } else {
      const minPriceMatch = question.match(/\b(?:price|priced|trading)\s*(?:>|over|above|at least|greater than)\s*\$?([\d,.]+)/i);
      const maxPriceMatch = question.match(/\b(?:price|priced|trading)\s*(?:<|under|below|at most|less than)\s*\$?([\d,.]+)/i);
      if (minPriceMatch) filters.minPrice = Number(minPriceMatch[1].replace(/,/g, ""));
      if (maxPriceMatch) filters.maxPrice = Number(maxPriceMatch[1].replace(/,/g, ""));
    }

    const marketCapMatch = question.match(/market\s*cap(?:italization)?\s*(?:>|over|above|at least|greater than)\s*\$?([\d,.]+)\s*(t|trillion|b|billion|m|million)?/i);
    if (marketCapMatch) {
      const amount = Number(marketCapMatch[1].replace(/,/g, ""));
      const unit = (marketCapMatch[2] || "b").toLowerCase();
      filters.minMarketCap = unit.startsWith("t") ? amount * 1000 : unit.startsWith("m") ? amount / 1000 : amount;
    }
    const exchangeMatch = question.match(/\b(nasdaq|nyse|amex)\b/i);
    if (exchangeMatch) filters.exchange = exchangeMatch[1].toUpperCase();

    const hasGainers = /\b(gainer|gainers|up|green)\b/i.test(question);
    const hasLosers = /\b(loser|losers|down|red)\b/i.test(question);
    const isMoversIntent = (hasGainers && hasLosers) || /\b(market\s*movers?|biggest\s*movers?|top\s*movers?)\b/i.test(question);

    if (isMoversIntent) {
      filters.gainersLosers = "movers";
      delete filters.gainersOnly;
      delete filters.losersOnly;
    } else if (hasGainers) {
      filters.gainersOnly = true;
    } else if (hasLosers) {
      filters.losersOnly = true;
    }

    const resultLimitMatch = question.match(/\b(?:top|limit(?: to)?|show)\s+(\d+)\s+(?:stocks?|equities|listings)\b/i);
    if (resultLimitMatch) filters.limit = Number(resultLimitMatch[1]);

    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: "screen",
        filters,
      },
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 5. Fast-path for FOSS Market Research & Quoting (Yahoo Finance / Alpaca)
  if (/\b(yfinance|yahoo\s*finance|alpaca|foss|fundamentals?|valuation|research|compare|snapshot|pe\s*ratio|p\/e|peg)\b/i.test(question)) {
    const excludeWords = new Set(["FOSS", "USD", "FOR", "ON", "AND", "THE", "GET", "LIVE", "PE", "PEG", "API", "APIS", "NBBO", "DEEP", "RUN", "STOCK", "SHARE", "PRICE", "QUOTE", "WITH", "USING"]);
    const allUpperMatches = Array.from(question.matchAll(/\b([A-Za-z0-9\/\.\-]{1,8})\b/g)).map(m => m[1]);
    const validTickers = allUpperMatches.filter(w => /^[A-Z0-9\/\.\-]+$/.test(w) && !excludeWords.has(w.toUpperCase()));
    
    let sym = validTickers.length > 0 ? validTickers[0].toUpperCase() : "NVDA";
    if (validTickers.length === 0) {
      const explicitMatch = question.match(/\b(?:ticker|symbol|stock|asset|shares?\s+of|on|for)\s+([A-Za-z0-9\/\.\-]+)\b/i);
      if (explicitMatch && !excludeWords.has(explicitMatch[1].toUpperCase())) {
        sym = explicitMatch[1].toUpperCase();
      }
    }

    if (/\b(compare|comparison|versus|vs)\b/i.test(question)) {
      const symMatches = Array.from(question.matchAll(/\b([A-Z]{1,5})\b/g)).map(m => m[1]);
      const uniqueSyms = Array.from(new Set(symMatches.filter(s => !excludeWords.has(s.toUpperCase()))));
      const symbols = uniqueSyms.length >= 2 ? uniqueSyms.slice(0, 4) : [sym, "AMD"];
      return {
        domain: "research",
        operation: "search",
        researchData: {
          action: "compare",
          symbols,
          provider: "hybrid",
        },
        terms: symbols.join(" "),
        role: "any",
        since: null,
        limit: 10,
      };
    }

    let action: "quote" | "fundamentals" | "bars" | "report" | "snapshot" | "compare" = "report";
    let provider: "yfinance" | "alpaca" | "hybrid" = "hybrid";

    if (/\b(snapshot|order\s*book|depth)\b/i.test(question)) {
      action = "snapshot";
      provider = "alpaca";
    } else if (/\b(quote|price|spread)\b/i.test(question) && !/\b(research|analysis|report)\b/i.test(question)) {
      action = "quote";
      provider = /\balpaca\b/i.test(question) ? "alpaca" : /\b(yahoo|yfinance)\b/i.test(question) ? "yfinance" : "hybrid";
    } else if (/\b(fundamentals?|p\/e|peg|market\s*cap|balance\s*sheet)\b/i.test(question) && !/\b(research|analysis|report)\b/i.test(question)) {
      action = "fundamentals";
      provider = "yfinance";
    } else {
      action = "report";
      provider = "hybrid";
    }

    return {
      domain: "research",
      operation: "search",
      researchData: {
        action,
        symbol: sym,
        provider,
      },
      terms: sym,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 6. Fast-path for E*TRADE Stock Quote
  const quoteExcludeWords = new Set(["FOR", "OF", "ON", "THE", "PLEASE", "REQUEST", "CHECK", "WHAT", "SHOW", "AND", "WITH", "REQUE"]);
  const quoteMatch =
    question.match(/(?:quote|price|ticker|trading at)\s*(?::|for|of|on|request:?)*\s+([A-Za-z]{1,5})\b/i) ||
    question.match(/\b([A-Za-z]{1,5})\s+(?:quote|price|ticker|trading at)\b/i);
  if (quoteMatch && !/\b(messages?|categories|tables?)\b/i.test(question)) {
    let symbol = quoteMatch[1].toUpperCase();
    if (quoteExcludeWords.has(symbol)) {
      const fallbackTicker = Array.from(question.matchAll(/\b([A-Z]{2,5})\b/g)).map(m => m[1]).find(t => !quoteExcludeWords.has(t));
      if (fallbackTicker) {
        symbol = fallbackTicker;
      }
    }
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "quote",
        symbol,
      },
      terms: symbol,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 6b. Fast-path for conversational order approval & execution (Strict HITL)
  const approveMatch = question.match(/^\s*(?:approve|authorize|confirm|execute)\s+(?:order\s+)?([a-zA-Z0-9_\-]+)\s*$/i);
  if (approveMatch) {
    const targetOrderId = approveMatch[1].trim();
    return {
      domain: "trading",
      operation: "update",
      tradingData: {
        action: "execute_order",
        symbol: targetOrderId,
      },
      terms: `execute ${targetOrderId}`,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 6c. Fast-path for conversational order cancellation
  const cancelMatch = question.match(/^\s*(?:cancel|reject|abort|dismiss)\s+(?:order\s+)?([a-zA-Z0-9_\-]+)\s*$/i);
  if (cancelMatch) {
    const targetOrderId = cancelMatch[1].trim();
    return {
      domain: "trading",
      operation: "update",
      tradingData: {
        action: "cancel_order",
        symbol: targetOrderId,
      },
      terms: `cancel ${targetOrderId}`,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 7. Fast-path for E*TRADE Order Proposal / Preview
  const orderParams = extractOrderParameters(question);
  if (orderParams) {
    return {
      domain: "trading",
      operation: "create",
      tradingData: {
        action: "preview_order",
        symbol: orderParams.symbol,
        orderAction: orderParams.orderAction,
        quantity: orderParams.quantity,
        orderType: orderParams.orderType,
        limitPrice: orderParams.limitPrice,
        relativePriceOffsetPercent: orderParams.relativePriceOffsetPercent,
        relativePriceDescription: orderParams.relativePriceDescription,
      },
      terms: `${orderParams.orderAction} ${orderParams.quantity} ${orderParams.symbol}`,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 8. Fast-path for E*TRADE Portfolio & Positions
  if (/\b(positions?|portfolio|holdings?|balance|brokerage account|shares i own)\b/i.test(question) && !/\b(messages?|categories)\b/i.test(question)) {
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "positions",
      },
      terms: "portfolio positions",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 9. Heuristic conversation search fallback
  const isCount = /\b(how many|count|total)\b/i.test(question);
  const isAssistant = /\b(assistant|bot|responses?|answers?)\b/i.test(question);
  const isUser = /\b(user|questions?|prompts?|i asked|i said)\b/i.test(question);
  const cleanTerms = question.replace(STOP_WORDS_REGEX, " ").trim();

  return {
    domain: "conversation",
    operation: isCount ? "count" : "list",
    terms: cleanTerms.slice(0, 100),
    role: isAssistant ? "assistant" : isUser ? "user" : "any",
    since: null,
    limit: 25,
    planSource: "fallback",
  };
}

/**
 * Tier 2: Calls Cloudflare Workers AI with structured output constraint
 * matching the exact API schema (nlqPlanSchema).
 */
export async function planWithLLM(env: Env, question: string): Promise<NLQPlan | null> {
  const hasAi = Boolean(env?.AI && typeof (env.AI as any).run === "function");
  if (!hasAi) return null;

  try {
    const model = getWorkersAIModel(env);
    const { object } = await generateObject({
      model,
      schema: nlqPlanSchema,
      system: `You are an expert NLQ (Natural Language Query) planner for an enterprise multi-agent financial and database platform.
Analyze the user's natural language request and output a structured plan conforming exactly to the JSON schema.

Available Domains:
1. 'trading':
   - Quotes: action 'quote', specify symbol.
   - Stock Screener: action 'screen', specify filters (e.g. minPrice, maxPrice, minMarketCap, exchange, gainersOnly, losersOnly, sector, maxRsi).
   - Order Previews: action 'preview_order', specify symbol, orderAction ('BUY'|'SELL'), quantity, orderType ('MARKET'|'LIMIT'), limitPrice.
   - Positions/Portfolio: action 'positions' for account balance and holdings.
   - Options Screener: action 'options_screen', filters (contractType 'CALL'|'PUT'|'BOTH', minDelta, maxDelta, minDte, maxDte, minVolume, minOpenInterest, moneyness).
   - Options Strategies: action 'options_strategies' or 'options_best_trade' for multi-leg strategies (iron condor, vertical spread).
   - Watchlists: action 'watchlist_save' or 'watchlist_list'.
2. 'research':
   - Real-time and fundamental research using Yahoo Finance or Alpaca (actions: 'quote', 'fundamentals', 'bars', 'report', 'compare', 'snapshot').
3. 'scheduling':
   - Task scheduling (action: 'list', 'create', 'cancel'). Type: 'delayed' (delayInSeconds), 'interval' (intervalSeconds).
4. 'agentic_payments':
   - Agent wallet status (action 'wallet_status'), micropayments ledger ('micropayments_list'), set limit ('set_limit').
5. 'tables':
   - Database schema inspection and table listing.
6. 'table_data':
   - Direct record browsing in tables (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_messages, mas_events, mas_trades).
7. 'category_mutation':
   - Adding or editing referral categories.
8. 'conversation':
   - Searching past chat messages or general questions.`,
      prompt: question.slice(0, 2000),
    });

    if (object && object.domain) {
      return {
        ...object,
        planSource: "llm",
      };
    }
  } catch {
    // If generateObject fails, fallback to generateText with JSON extraction
    try {
      const model = getWorkersAIModel(env);
      const { text } = await generateText({
        model,
        temperature: 0,
        system: `You are an NLQ planner for an enterprise database and trading platform.
Return JSON ONLY matching this structure:
{
  "domain": "trading"|"research"|"scheduling"|"agentic_payments"|"tables"|"table_data"|"category_mutation"|"conversation",
  "operation": "list"|"count"|"search"|"create"|"update",
  "targetTable": string,
  "tradingData": { "action": string, "symbol": string, "orderAction": "BUY"|"SELL", "quantity": number, "limitPrice": number, "filters": {} },
  "researchData": { "action": string, "symbol": string, "symbols": [] },
  "scheduleData": { "action": string, "scheduleType": string, "delayInSeconds": number, "description": string },
  "terms": string,
  "limit": number
}`,
        prompt: question.slice(0, 2000),
      });

      const cleaned = text.replace(/```(?:json)?([\s\S]*?)```/g, "$1").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed.terms === "string") {
          parsed.terms = parsed.terms.replace(STOP_WORDS_REGEX, " ").trim();
        }
        const validated = nlqPlanSchema.parse(parsed);
        return {
          ...validated,
          planSource: "llm",
        };
      }
    } catch {
      // LLM execution failed; caller will fall back to planWithRules
    }
  }

  return null;
}

export interface NLQPlanOptions {
  preferLLM?: boolean;
  skipLLM?: boolean;
  context?: string;
  validateWithLLM?: boolean;
}

/**
 * Main NLQ Planning entry point:
 * Tiered Hybrid Architecture:
 * 1. If LLM is available and not skipped, calls Workers AI with Structured Outputs (nlqPlanSchema).
 * 2. If LLM fails, errors, or is unavailable, seamlessly falls back to the deterministic rule engine.
 */
export async function planNLQ(
  env: Env,
  question: string,
  options?: NLQPlanOptions
): Promise<NLQPlan> {
  const hasAi = Boolean(env?.AI && typeof (env.AI as any).run === "function");

  // Tier 2: LLM Structured Output (when AI binding is active and not skipped)
  if (hasAi && !options?.skipLLM) {
    const llmPlan = await planWithLLM(env, question);
    if (llmPlan) {
      return llmPlan;
    }
    // If LLM returned null or failed, fall back to rule-based parser with provenance
    const fallbackPlan = planWithRules(question);
    fallbackPlan.planSource = "fallback";
    return fallbackPlan;
  }

  // Tier 1 & 3: Deterministic Rule-Based implementation (<1ms latency, 0 tokens)
  const fastPlan = planWithRules(question);
  fastPlan.planSource = fastPlan.planSource ?? "fastpath";
  return fastPlan;
}

/**
 * Validates and verifies an NLQ execution plan against the user's natural language query using Workers AI LLM,
 * with intelligent fallback validation.
 * Ensures questions targeting options strategies, risk parameters, or options contracts are never misrouted.
 */
export async function validateNLQPlanWithLLM(
  env: Env,
  question: string,
  plan: NLQPlan,
  contextHint?: string
): Promise<NLQValidationResult> {
  const hasAi = Boolean(env?.AI && typeof (env.AI as any).run === "function");
  const isOptionsContext =
    contextHint === "options" ||
    /\b(options?|contracts?|chains?|calls?|puts?|spreads?|condors?|straddles?|strangles?|underlyings?|max\s*profit|max\s*loss|reward\s*(?:\/|to)\s*risk|delta|dte|strike|iv)\b/i.test(question) ||
    /\bstrateg(?:y|ies)\b/i.test(question);

  const buildResult = (base: {
    validated: boolean;
    model: string;
    domain: string;
    action?: string;
    interpretation: string;
    confidence?: number;
    corrected?: boolean;
  }): NLQValidationResult => {
    return {
      ...base,
      isValid: base.validated,
      detectedDomain: isOptionsContext ? "options_strategy" : base.domain,
      suggestedAction: base.action,
      preventedStockScreenerFallback: isOptionsContext && base.action !== "screen",
    };
  };

  // Safeguard: If the plan erroneously picked stock 'screen' but question is options-oriented:
  if (isOptionsContext && plan.tradingData?.action === "screen") {
    const strategyIntent = parseOptionsStrategyIntent(question);
    if (strategyIntent) {
      plan.domain = "trading";
      plan.tradingData = {
        action: strategyIntent.action,
        symbol: strategyIntent.filters.request.symbol,
        filters: strategyIntent.filters as unknown as Record<string, any>,
        strategyFilter: strategyIntent.filters.strategyFilter as Record<string, any> | undefined,
        request: strategyIntent.filters.request as Record<string, any> | undefined,
        scope: strategyIntent.filters.scope as Record<string, any> | undefined,
      };
    } else {
      plan.domain = "trading";
      plan.tradingData = {
        action: "options_screen",
        filters: { maxUnderlyings: 25 },
      };
    }
    plan.planSource = "llm_validated";
    return buildResult({
      validated: true,
      model: hasAi ? resolveAiModelName(env, "nlqValidation") : "semantic-rules-validator",
      domain: plan.domain,
      action: plan.tradingData.action,
      interpretation: "Validated and corrected from stock screener to Options Strategy Scanner (Max profit > Max loss across liquid underlyings)",
      corrected: true,
      confidence: 0.98,
    });
  }

  if (hasAi) {
    try {
      const model = getWorkersAIModel(env, "nlqValidation");
      const { text } = await generateText({
        model,
        temperature: 0,
        maxOutputTokens: 256,
        system: `You are an expert financial NLQ query validator. Validate if the planned action "${plan.tradingData?.action || plan.domain}" accurately matches the user question. Return JSON only: {"valid": boolean, "interpretation": string}`,
        prompt: `Question: "${question}"\nPlanned Domain: "${plan.domain}", Action: "${plan.tradingData?.action || "none"}"`,
      });
      const cleaned = text.replace(/```(?:json)?([\s\S]*?)```/g, "$1").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return buildResult({
          validated: true,
          model: resolveAiModelName(env, "nlqValidation"),
          domain: plan.domain,
          action: plan.tradingData?.action,
          interpretation: parsed.interpretation || `Validated as ${plan.tradingData?.action || plan.domain}`,
          confidence: parsed.valid ? 0.95 : 0.6,
        });
      }
    } catch {
      // Fall through to semantic result
    }
  }

  return buildResult({
    validated: true,
    model: "semantic-validator",
    domain: plan.domain,
    action: plan.tradingData?.action,
    interpretation: isOptionsContext
      ? `Interpreted as ${plan.tradingData?.action === "options_opportunities" ? "Multi-Underlying Options Opportunity Scan" : plan.tradingData?.action === "options_strategies" ? "Options Strategy Evaluation" : "Options Screener"}`
      : `Interpreted as ${plan.domain} (${plan.tradingData?.action || plan.operation})`,
    confidence: 0.95,
  });
}

export function formatMarketCap(cap?: number): string {
  if (!cap || cap <= 0 || isNaN(cap)) return "N/A";
  if (cap >= 1e12) {
    return `$${(cap / 1e12).toFixed(2)}T`;
  }
  if (cap >= 1e9) {
    return `$${(cap / 1e9).toFixed(2)}B`;
  }
  if (cap >= 1e6) {
    return `$${(cap / 1e6).toFixed(2)}M`;
  }
  if (cap >= 1000) {
    return `$${(cap / 1000).toFixed(2)}T`;
  }
  return `$${cap.toFixed(1)}B`;
}

/**
 * Issue #118 (audit F13): NLQ quote answers must announce provenance
 * truthfully. "Real-time" is claimed ONLY for a quote actually fetched live
 * (quoteStatus "REALTIME"); a static fallback / simulated / delayed /
 * unavailable quote is labelled as what it is, in the summary and the rows,
 * because chat and voice surfaces read this text verbatim.
 */
export function formatTradingQuoteHeadline(q: ETradeQuote): string {
  const price = `$${q.lastPrice.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`;
  const hasBidAsk = q.bid > 0 || q.ask > 0;
  if (isLiveQuoteStatus(q.quoteStatus)) {
    return `Real-time quote for ${q.symbol} (${q.companyName}): ${price}. Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`;
  }
  const status = q.quoteStatus || "UNKNOWN";
  const label =
    q.quoteStatus === STATIC_FALLBACK_QUOTE_STATUS
      ? "Static fallback quote (not live market data)"
      : q.quoteStatus === "SIMULATED_LEVEL1"
        ? "Simulated quote (sandbox — not live market data)"
        : q.quoteStatus === "DELAYED"
          ? "Delayed quote"
          : q.quoteStatus === "AUTH_REQUIRED"
            ? "Quote unavailable (E*TRADE authentication required)"
            : `Quote (status: ${status})`;
  const bidAskClause =
    q.quoteStatus === STATIC_FALLBACK_QUOTE_STATUS
      ? "No live bid/ask available — static table price only."
      : hasBidAsk
        ? `Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`
        : "No live bid/ask available.";
  return `${label} for ${q.symbol} (${q.companyName}): ${price}. ${bidAskClause}`;
}

/** Bid/ask cell for NLQ quote rows: never renders an invented zero spread as real. */
export function formatTradingQuoteBidAsk(q: ETradeQuote): string {
  return q.bid > 0 || q.ask > 0 ? `$${q.bid.toFixed(2)} / $${q.ask.toFixed(2)}` : "N/A (no live bid/ask)";
}

export function executeNLQQuery(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userDid?: string
): NLQQueryResult {
  const executedAt = new Date().toISOString();

  // 1. List Tables & Schema
  if (plan.domain === "tables") {
    const tables = orm.listTables();
    return {
      plan,
      domain: "tables",
      count: tables.length,
      summary: `Found ${tables.length} tables in SQLite database schema.`,
      rows: tables.map((t) => ({
        tableName: t.name,
        rowCount: t.rowCount,
        description: t.description,
        columnCount: t.columns.length,
        columns: t.columns.map((c) => `${c.name} (${c.type}${c.isPrimary ? ", PK" : ""})`).join(", "),
      })),
      executedAt,
    };
  }

  // 1b. Task Scheduling Operations (Cloudflare Agents Schedule API)
  // Issue #109: scheduling actions arm REAL Agent schedules through the
  // injected NLQSchedulingPort, which only the asynchronous executor
  // (executeNLQQueryAsync) can call. The sync executor must never
  // fabricate a schedule — it previously invented `sched_<type>_<ts>`
  // ids, wrote a schedule.created audit event against a nonexistent
  // mas_schedules table, and reported success for schedules that did
  // not exist. Direct sync calls now get an honest refusal, matching
  // the guard pattern used for async-only trading actions below.
  if (plan.domain === "scheduling") {
    const action = plan.scheduleData?.action || "list";
    return {
      plan,
      domain: "scheduling",
      targetTable: "cf_agent_schedules",
      count: 0,
      status: "error",
      summary: `Scheduling (${action}): this action requires the asynchronous NLQ executor (executeNLQQueryAsync) with a live agent scheduling port. Nothing was created, cancelled, or listed by this call.`,
      rows: [],
      executedAt,
    };
  }

  // 1c. Cloudflare Agentic Payments Operations (x402 & MPP)
  if (plan.domain === "agentic_payments") {
    const paymentService = new ETradeAgenticPaymentService(orm, env, sessionId);
    const action = plan.agenticPaymentsData?.action || "wallet_status";

    if (action === "wallet_status") {
      // Issue #122: delegate to the payment service (single source of truth)
      // and disclose that the balance is a simulated local-ledger figure —
      // a $50.00 local starting credit plus/minus locally recorded entries,
      // NOT an on-chain wallet balance.
      const wallet = paymentService.getWalletStatusSync();

      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_agentic_wallet",
        count: 1,
        summary: `Cloudflare Agentic Wallet: Balance $${wallet.balanceUSD.toFixed(2)} USDC on ${wallet.network}. This is a SIMULATED local-ledger balance (includes a $${wallet.startingCreditUSD.toFixed(2)} local starting credit and locally recorded entries only) — not an on-chain wallet balance. Auto-approve limit: $${wallet.autoApproveLimitUSD.toFixed(2)}. Total spent: $${wallet.totalSpentUSD.toFixed(2)}, total earned: $${wallet.totalEarnedUSD.toFixed(2)} across ${wallet.transactionCount} micropayments.`,
        rows: [
          {
            network: wallet.network,
            balanceUSD: `$${wallet.balanceUSD.toFixed(2)}`,
            autoApproveLimitUSD: `$${wallet.autoApproveLimitUSD.toFixed(2)}`,
            totalSpentUSD: `$${wallet.totalSpentUSD.toFixed(2)}`,
            totalEarnedUSD: `$${wallet.totalEarnedUSD.toFixed(2)}`,
            micropaymentCount: wallet.transactionCount,
            status: "SIMULATED",
            simulated: true,
            source: wallet.source,
            startingCreditUSD: `$${wallet.startingCreditUSD.toFixed(2)}`,
          },
        ],
        executedAt,
      };
    }

    if (action === "set_limit") {
      const limit = plan.agenticPaymentsData?.limitUSD ?? 0.05;
      paymentService.setAutoApproveLimit(limit);
      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_agentic_wallet",
        count: 1,
        summary: `Agentic micropayment auto-approval limit updated to $${limit.toFixed(2)} USD (HITL safeguard active).`,
        rows: [
          {
            action: "SET_LIMIT",
            limitUSD: `$${limit.toFixed(2)}`,
            status: "SUCCESS",
            updatedAt: executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "micropayments_list") {
      const allTx = orm.transactions ? orm.transactions.findMany({ limit: plan.limit || 25, orderBy: "created_at DESC" }) : [];
      const micropayments = allTx.filter((t) => t.gateway === "x402" || t.gateway === "mpp");
      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_transactions",
        count: micropayments.length,
        summary: `Found ${micropayments.length} micropayment transaction(s) in durable financial ledger.`,
        rows: micropayments.map((t) => ({
          id: t.id,
          action: t.action,
          amount: `$${t.amount.toFixed(2)} ${t.currency}`,
          customer: t.customer,
          gateway: t.gateway,
          status: t.status,
          proposerDid: t.proposerDid,
          proofSignature: t.proofSignature,
          createdAt: t.createdAt,
        })),
        executedAt,
      };
    }
  }

  // 2. Add or Update Referral Categories via ORM
  if (plan.domain === "category_mutation") {
    const catName = plan.categoryData?.name || plan.terms || "New Category";
    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const now = new Date().toISOString();
    const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;

    const created = orm.categories.create({
      id,
      name: catName,
      slug,
      description: plan.categoryData?.description || `Category for ${catName} referrals`,
      icon: plan.categoryData?.icon || "🏷️",
      isActive: true,
      sortOrder: (orm.categories.count() || 0) + 1,
      createdAt: now,
      updatedAt: now,
    });

    const allCategories = orm.categories.findMany({ orderBy: "sort_order ASC" });

    return {
      plan,
      domain: "category_mutation",
      targetTable: "mas_categories",
      count: allCategories.length,
      summary: `Category "${created.name}" created successfully via ORM. Total active categories: ${allCategories.length}.`,
      rows: allCategories.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        slug: c.slug,
        description: c.description,
        status: c.isActive ? "ACTIVE" : "INACTIVE",
        sortOrder: c.sortOrder,
      })),
      executedAt,
    };
  }

  // 3. Query Specific Table Data via ORM
  if (plan.domain === "table_data") {
    const table = plan.targetTable || "mas_categories";
    const data = orm.getTableData(table, { search: plan.terms, limit: plan.limit });
    return {
      plan,
      domain: "table_data",
      targetTable: table,
      count: data.rows.length,
      summary: `Retrieved ${data.rows.length} rows from ${table} (Total: ${data.total}).`,
      rows: data.rows,
      executedAt,
    };
  }

  // 4. Trading Domain (E*TRADE stock screening, quotes, order previews, positions)
  if (plan.domain === "trading") {
    const etrade = new ETradeService(orm, env, sessionId);
    const action = plan.tradingData?.action || "screen";

    if (action === "capabilities") {
      const caps = getPlatformCapabilitiesDeskSummary();
      return {
        plan,
        domain: "trading",
        targetTable: "platform_capabilities",
        count: caps.workflows.length,
        status: "matches_found",
        summary: caps.spokenSummary,
        displayMarkdown: caps.markdownOverview,
        rows: caps.workflows as any,
        executedAt,
      };
    }

    if (action === "screen") {
      const screenRes = etrade.screenStocks(plan.tradingData?.filters);
      let scannerState: "not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found" | "SCAN_INVALID_DATA_MISMATCH";
      let summary = "";

      const hasMismatch = screenRes.status === "SCAN_INVALID_DATA_MISMATCH" || screenRes.stocks.some((s) => {
        if (plan.tradingData?.filters?.gainersOnly && s.changePercent <= 0) return true;
        if (plan.tradingData?.filters?.losersOnly && s.changePercent >= 0) return true;
        return false;
      });

      if (hasMismatch) {
        scannerState = "SCAN_INVALID_DATA_MISMATCH";
        summary = `🚨 SCAN INVALID — DATA MISMATCH: Screened candidates contradict requested filter criteria (${screenRes.filterSummary}). Action shortcuts disabled.`;
      } else if (screenRes.totalScreened === 0) {
        scannerState = "no_universe";
        summary = "⚠️ Scanner State: [No universe processed] (0 equities configured or retrieved). Data unavailable or scan not run.";
      } else if (screenRes.stocks.length === 0) {
        scannerState = "no_matches";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; 0 matched criteria] (${screenRes.filterSummary}).`;
      } else {
        scannerState = "matches_found";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; ${screenRes.stocks.length} passed criteria] (${screenRes.filterSummary}).`;
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_screener",
        count: screenRes.stocks.length,
        status: scannerState,
        summary,
        scanLedger: screenRes.ledger,
        movers: screenRes.movers,
        provenance: {
          scannerState,
          universeCount: screenRes.totalScreened,
          passedCount: screenRes.stocks.length,
          rejectedCount: screenRes.ledger?.rejectedCount ?? 0,
          rsiLookback: "14-Period Daily RSI",
          macdSettings: "12, 26, 9 EMA",
          quoteDelay: "Level 1 Quotes (E*TRADE Sandbox / FOSS Hybrid)",
          executedAt,
        },
        rows: screenRes.stocks.map((s) => {
          const rowMismatch =
            (plan.tradingData?.filters?.gainersOnly && s.changePercent <= 0) ||
            (plan.tradingData?.filters?.losersOnly && s.changePercent >= 0);
          return {
            symbol: s.symbol,
            companyName: s.companyName,
            sector: s.sector,
            exchange: s.listingExchange || (s as any).exchange || "N/A",
            price: `$${s.price.toFixed(2)}`,
            rawPrice: s.price,
            change: `${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%)`,
            changePercent: s.changePercent,
            changePeriod: s.changePeriod || "1D (Regular Trading Day)",
            priorClose: `$${(s.previousClose ?? (s.price - s.change)).toFixed(2)}`,
            rsi14: s.rsi14,
            rsiLookback: s.rsiLookback || "14-Period Daily RSI",
            macdSignal: s.macdSignal,
            calculationVersion: s.macdIndicatorVersion || "MACD (12, 26, 9 EMA)",
            marketCap: formatMarketCap(s.marketCap),
            peRatio: s.peRatio ? s.peRatio.toFixed(1) : "N/A",
            signal: s.signal,
            source: s.source || "Level 1 Quotes (E*TRADE Sandbox / FOSS Hybrid)",
            quoteTimestamp: s.timestamp || executedAt,
            validationStatus: rowMismatch ? "FAIL_MISMATCH" : (s.validationStatus || "PASS_CONFIRMED"),
            actionAvailable: (hasMismatch || rowMismatch) ? "DISABLED (DATA MISMATCH)" : `Preview Buy/Sell for ${s.symbol}`,
          };
        }),
        executedAt,
      };
    }

    if (action === "quote") {
      const sym = plan.tradingData?.symbol || plan.terms || "NVDA";
      const q = etrade.getQuote(sym);
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_quotes",
        count: 1,
        summary: formatTradingQuoteHeadline(q),
        rows: [
          {
            symbol: q.symbol,
            company: q.companyName,
            lastPrice: `$${q.lastPrice.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            changePeriod: "1D (Regular Trading Day)",
            priorClose: `$${(q.previousClose || (q.lastPrice - q.change)).toFixed(2)}`,
            bidAsk: formatTradingQuoteBidAsk(q),
            volume: q.volume.toLocaleString(),
            range52Week: `$${((q.low52 ?? q.week52Low) || 0).toFixed(2)} - ${((q.high52 ?? q.week52High) || 0).toFixed(2)}`,
            peRatio: q.peRatio ? q.peRatio.toFixed(1) : "N/A",
            marketCap: formatMarketCap(q.marketCap),
            source: q.source,
            quoteStatus: q.quoteStatus || "UNKNOWN",
            quoteTimestamp: q.timestamp || executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "preview_order") {
      const sym = (plan.tradingData?.symbol || "").trim().toUpperCase();
      if (!sym) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: "E*TRADE order preview requires a valid stock symbol (e.g. 'buy 10 shares of NVDA').",
          rows: [],
          executedAt,
        };
      }
      const qty = plan.tradingData?.quantity || 1;
      const orderAction = plan.tradingData?.orderAction || "BUY";
      const quote = etrade.getQuote(sym);
      const relativeOffset = plan.tradingData?.relativePriceOffsetPercent;
      const relativeDesc = plan.tradingData?.relativePriceDescription;

      let limitPrice = plan.tradingData?.limitPrice;
      let orderType = plan.tradingData?.orderType || (limitPrice !== undefined || relativeOffset !== undefined ? "LIMIT" : "MARKET");

      if (relativeOffset !== undefined && quote.lastPrice > 0) {
        orderType = "LIMIT";
        limitPrice = Number((quote.lastPrice * (1 + relativeOffset / 100)).toFixed(2));
      } else if (limitPrice !== undefined) {
        orderType = "LIMIT";
      }

      const draft = etrade.previewOrder({
        sessionId,
        symbol: sym,
        orderAction,
        quantity: qty,
        orderType,
        limitPrice,
      });

      const shareWord = draft.quantity === 1 ? "share" : "shares";
      const marketPriceStr = quote.lastPrice > 0 ? `$${quote.lastPrice.toFixed(2)}` : "Market";

      let pricingSummary = `at ~$${draft.estimatedPrice.toFixed(2)}`;
      if (draft.orderType === "LIMIT") {
        if (relativeDesc && quote.lastPrice > 0) {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)} (${relativeDesc} prevailing quote ${marketPriceStr})`;
        } else {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)}`;
        }
      }

      // Dispatch Pre-Trade Approval Ticket to Slack (Strict HITL Gate)
      if (env?.SLACK_WEBHOOK_URL || env?.SLACK_BOT_TOKEN) {
        try {
          const slackService = new ETradeSlackTradingService(env, orm, sessionId);
          slackService.sendPreTradeApprovalTicket({
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
            limitPrice: draft.limitPrice,
            estimatedPrice: draft.estimatedPrice,
            estimatedTotal: draft.estimatedTotal,
            commission: draft.estimatedCommission,
            proposerDid: draft.proposerDid,
            expiresAt: draft.expiresAt,
          }).catch(console.warn);
        } catch {
          // Non-blocking dispatch
        }
      }

      // Issue #118: if the preview was priced from a static fallback quote,
      // the summary (read verbatim by chat/voice) must say so.
      const pricingQuoteStatus = draft.pricingQuoteStatus ?? quote.quoteStatus;
      const nonLivePricingNote = isNonLivePricingQuoteStatus(pricingQuoteStatus)
        ? ` ${nonLivePricingNotice(pricingQuoteStatus)}`
        : "";

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} ${shareWord} of ${draft.symbol} ${pricingSummary}. Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.${nonLivePricingNote}`,
        rows: [
          {
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
            limitPrice: draft.limitPrice !== undefined ? `$${draft.limitPrice.toFixed(2)}` : "N/A (Market Order)",
            prevailingMarketPrice: marketPriceStr,
            pricingQuoteStatus: pricingQuoteStatus || "UNKNOWN",
            relativePricing: relativeDesc,
            estimatedPrice: `$${draft.estimatedPrice.toFixed(2)}`,
            estimatedTotal: `$${draft.estimatedTotal.toFixed(2)}`,
            commission: `$${draft.estimatedCommission.toFixed(2)}`,
            proposerDid: draft.proposerDid,
            status: draft.status.toUpperCase(),
            safetyGuarantee: "No live trade submitted. Human approval required.",
            authorizationPrompt: `Reply 'approve ${draft.orderId}' or execute via Trading Hub.`,
          },
        ],
        executedAt,
      };
    }

    if (action === "execute_order" || action === "approve_order") {
      const orderId = (plan.tradingData?.symbol || "").trim();
      const existingTrade = orm.trades?.findById(orderId.toLowerCase()) || orm.trades?.findById(orderId);

      if (!existingTrade) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: `Order draft '${orderId}' was not found. Orders must be previewed and drafted before authorization.`,
          rows: [],
          executedAt,
        };
      }

      if (existingTrade.status !== "previewed") {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 1,
          summary: `Order '${orderId}' cannot be executed. Current status is '${existingTrade.status.toUpperCase()}'. Only 'previewed' drafts may be authorized.`,
          rows: [{ ...existingTrade }],
          executedAt,
        };
      }

      const effectiveAuthorizer = userDid || `did:user:slack:approver`;
      const execRes = etrade.executeOrder(existingTrade.id, effectiveAuthorizer, "approved");

      // Auto-dispatch visual snap receipt to Slack
      if (execRes.status === "executed" || (execRes as any).success) {
        if (env?.SLACK_WEBHOOK_URL || env?.SLACK_BOT_TOKEN) {
          try {
            const browserService = new ETradeBrowserService(env);
            browserService.sendTransactionSnapToSlack({
              transactionId: existingTrade.id,
              symbol: existingTrade.symbol,
              action: existingTrade.action,
              quantity: existingTrade.quantity,
              price: existingTrade.price,
              orderType: existingTrade.orderType,
              status: "EXECUTED",
              totalValue: existingTrade.totalValue,
              environment: (env?.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
              timestamp: executedAt,
              // This dispatch runs inside the authorize_order action — the
              // user's explicit approval of a previewed draft (issue #120).
              humanApproved: true,
            }).catch(console.warn);
          } catch {
            // Non-blocking snap dispatch
          }
        }
      }

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `✅ E*TRADE order ${existingTrade.id} (${existingTrade.action} ${existingTrade.quantity} ${existingTrade.symbol}) APPROVED & EXECUTED. Broker Ref: ${execRes.executionId || "et_fill_confirmed"}. Stamped by ${effectiveAuthorizer}.`,
        rows: [
          {
            orderId: existingTrade.id,
            symbol: existingTrade.symbol,
            action: existingTrade.action,
            quantity: existingTrade.quantity,
            status: "EXECUTED",
            executionId: execRes.executionId,
            authorizerDid: effectiveAuthorizer,
            totalValue: `$${Number(existingTrade.totalValue || 0).toFixed(2)}`,
            executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "cancel_order") {
      const orderId = (plan.tradingData?.symbol || "").trim();
      const existingTrade = orm.trades?.findById(orderId.toLowerCase()) || orm.trades?.findById(orderId);
      const effectiveAuthorizer = userDid || `did:user:slack:canceller`;

      if (existingTrade && orm.trades) {
        orm.trades.update(existingTrade.id, {
          status: "rejected",
          authorizerDid: effectiveAuthorizer,
          updatedAt: executedAt,
        });
      }

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `❌ Order draft '${orderId}' CANCELLED by ${effectiveAuthorizer}. No broker order submitted.`,
        rows: [
          {
            orderId,
            status: "REJECTED",
            authorizerDid: effectiveAuthorizer,
            cancelledAt: executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "positions") {
      const posRes = etrade.getPositions();
      const posTotal = Number(posRes.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0).toFixed(2));
      const statedCash = Number((posRes.account.cashAvailableForInvestment || 0).toFixed(2));
      const calculatedTotal = Number((posTotal + statedCash).toFixed(2));
      const statedTotal = Number((posRes.account.totalAccountValue || posRes.account.netAccountValue || calculatedTotal).toFixed(2));
      const variance = Math.abs(Number((statedTotal - calculatedTotal).toFixed(2)));
      const isReconciled = variance <= 1.00;

      if (!isReconciled) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_portfolio_live",
          count: posRes.positions.length,
          status: "RECONCILIATION_FAILED",
          reconciled: false,
          summary: `⚠️ UNVERIFIED / POSSIBLE DEMO DATA: Portfolio result cannot be reconciled ($${variance.toFixed(2)} unexplained variance between stated total $${statedTotal.toFixed(2)} and positions+cash $${calculatedTotal.toFixed(2)})—no account conclusion shown.`,
          discrepancy: {
            statedAccountTotal: `$${statedTotal.toFixed(2)}`,
            positionsMarketValue: `$${posTotal.toFixed(2)}`,
            statedCash: `$${statedCash.toFixed(2)}`,
            calculatedTotal: `$${calculatedTotal.toFixed(2)}`,
            unexplainedVariance: `$${variance.toFixed(2)}`,
          },
          provenance: {
            dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
            environment: resolveEnvironmentConfig(env).name,
            accountKey: `••••${posRes.account.accountId.slice(-4)}`,
            reconciliationStatus: "FAIL_CLOSED",
            pricesObservedAt: executedAt,
            evaluatedAt: executedAt,
          },
          rows: [],
          executedAt,
        };
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_portfolio_live",
        count: posRes.positions.length,
        status: "RECONCILED",
        reconciled: true,
        summary: `E*TRADE Account ••••${posRes.account.accountId.slice(-4)}: Reconciled Total Value $${statedTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} (Holdings: $${posTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}, Cash: $${statedCash.toLocaleString("en-US", { minimumFractionDigits: 2 })}), Open Positions: ${posRes.positions.length}.`,
        provenance: {
          dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
          environment: resolveEnvironmentConfig(env).name,
          accountKey: `••••${posRes.account.accountId.slice(-4)}`,
          reconciliationStatus: "VERIFIED_EXACT",
          pricesObservedAt: executedAt,
          evaluatedAt: executedAt,
        },
        rows: posRes.positions.map((p) => ({
          symbol: p.symbol,
          description: p.description,
          shares: p.quantity,
          costBasis: `$${p.costBasis.toFixed(2)}`,
          lastPrice: `$${p.marketPrice.toFixed(2)}`,
          marketValue: `$${p.marketValue.toFixed(2)}`,
          unrealizedGainLoss: `${p.unrealizedGainLoss >= 0 ? "+" : ""}$${p.unrealizedGainLoss.toFixed(2)} (${p.unrealizedGainLossPercent.toFixed(2)}%)`,
        })),
        executedAt,
      };
    }

    if (action === "options_screen") {
      // Live chain screening requires upstream E*TRADE fetches and is handled by
      // executeNLQQueryAsync; the sync executor only guards against direct calls.
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_options_screener",
        count: 0,
        status: "error",
        summary: "Options Screener: this action requires the asynchronous NLQ executor (executeNLQQueryAsync).",
        rows: [],
        executedAt,
      };
    }

    if (action === "options_flow") {
      return {
        plan,
        domain: "trading",
        targetTable: "options_flows",
        count: 0,
        status: "info",
        summary: "Options Flow: this action requires the asynchronous NLQ executor (executeNLQQueryAsync).",
        rows: [],
        executedAt,
        planSource: plan.planSource || "fastpath",
      };
    }

    if (action === "watchlist_save") {
      const name = plan.tradingData?.watchlistName || "My Watchlist";
      let symbols = plan.tradingData?.symbols || [];
      if (symbols.length === 0) {
        const screened = etrade.screenStocks(plan.tradingData?.filters);
        symbols = screened.stocks.slice(0, 10).map((s) => s.symbol);
      }
      if (symbols.length === 0) {
        symbols = ["NVDA", "AAPL", "MSFT", "AMD"];
      }

      const saved = orm.saveWatchlist({
        name,
        userLogin: sessionId,
        symbols,
        source: "local_durable_sqlite",
      });

      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: symbols.length,
        summary: `Successfully saved ${symbols.length} symbol(s) into watchlist "${name}" (ID: ${saved.id}). Tickers: [${symbols.join(", ")}].`,
        rows: [
          {
            watchlistId: saved.id,
            name: saved.name,
            symbolCount: symbols.length,
            symbols: symbols.join(", "),
            source: saved.source,
            status: "SAVED",
            createdAt: saved.createdAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "watchlist_list") {
      const all = orm.getWatchlists(sessionId);
      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: all.length,
        summary: `Found ${all.length} saved watchlist(s) in durable storage.`,
        rows: all.map((w) => {
          let syms: string[] = [];
          try {
            syms = JSON.parse(w.symbolsJson);
          } catch {}
          return {
            watchlistId: w.id,
            name: w.name,
            symbolCount: syms.length,
            symbols: syms.join(", "),
            source: w.source,
            updatedAt: w.updatedAt,
          };
        }),
        executedAt,
      };
    }
  }

  // Handle FOSS Market Research & Quoting Domain (Yahoo Finance & Alpaca)
  if (plan.domain === "research") {
    const foss = new FossResearchService(env);
    const sym = plan.researchData?.symbol || plan.terms || "NVDA";
    const action = plan.researchData?.action || "report";
    const provider = plan.researchData?.provider || "hybrid";

    if (action === "fundamentals") {
      const f = foss.getFundamentalsSync(sym);
      // Issue #117: a non-live target is a profile estimate, never "consensus".
      const targetClause = f.provenance === "live"
        ? `Consensus Target: $${f.targetMeanPrice?.toFixed(2) || "N/A"} (${f.recommendationKey?.toUpperCase() || "BUY"}).`
        : `Profile Target Estimate: $${f.targetMeanPrice?.toFixed(2) || "N/A"} (${f.recommendationKey?.toUpperCase() || "BUY"}) — from ${f.provenance} FOSS data, not live analyst consensus.`;
      return {
        plan,
        domain: "research",
        targetTable: "yfinance_fundamentals",
        count: 1,
        summary: `FOSS Fundamental Analysis for ${f.companyName} (${f.symbol}) via Yahoo Finance: Market Cap $${(f.marketCap / 1e9).toFixed(1)}B, Trailing P/E ${f.peTrailing || "N/A"}, Forward P/E ${f.peForward || "N/A"}, PEG ${f.pegRatio || "N/A"}. ${targetClause}`,
        rows: [
          {
            symbol: f.symbol,
            company: f.companyName,
            sector: f.sector,
            marketCap: `$${(f.marketCap / 1e9).toFixed(1)}B`,
            peTrailing: f.peTrailing || "N/A",
            peForward: f.peForward || "N/A",
            pegRatio: f.pegRatio || "N/A",
            beta: f.beta || "N/A",
            range52Week: `$${f.fiftyTwoWeekLow.toFixed(2)} - $${f.fiftyTwoWeekHigh.toFixed(2)}`,
            targetPrice: `$${f.targetMeanPrice?.toFixed(2) || "N/A"}`,
            analystRating: f.recommendationKey?.toUpperCase() || "BUY",
            provenance: f.provenance,
            dataNote: f.note,
          },
        ],
        executedAt,
      };
    }

    if (action === "snapshot") {
      const s = foss.getAlpacaSnapshotSync(sym);
      return {
        plan,
        domain: "research",
        targetTable: "alpaca_snapshot",
        count: 1,
        // Issue #117: the sync snapshot comes from the FOSS profile — only
        // call it real-time when it was actually fetched live.
        summary: `Alpaca ${s.provenance === "live" ? "Real-time" : "FOSS Profile (non-live)"} Market Snapshot for ${s.symbol}: Latest Trade $${s.latestTrade.price.toFixed(2)} (${s.latestTrade.size} shs). Best Bid $${s.latestQuote.bidPrice.toFixed(2)} / Ask $${s.latestQuote.askPrice.toFixed(2)}. Daily High $${s.dailyBar.high.toFixed(2)} / Low $${s.dailyBar.low.toFixed(2)}.`,
        rows: [
          {
            symbol: s.symbol,
            assetClass: s.assetClass,
            lastPrice: `$${s.latestTrade.price.toFixed(2)}`,
            bidAskSpread: `$${s.latestQuote.bidPrice.toFixed(2)} / $${s.latestQuote.askPrice.toFixed(2)}`,
            dayRange: `$${s.dailyBar.low.toFixed(2)} - $${s.dailyBar.high.toFixed(2)}`,
            volume: s.dailyBar.volume.toLocaleString(),
            vwap: s.dailyBar.vwap ? `$${s.dailyBar.vwap.toFixed(2)}` : "N/A",
            provenance: s.provenance,
            dataNote: s.note,
          },
        ],
        executedAt,
      };
    }

    if (action === "quote") {
      const q = foss.getQuoteSync(sym, provider);
      return {
        plan,
        domain: "research",
        targetTable: "foss_quote",
        count: 1,
        // Issue #117: the sync quote path serves the FOSS profile — a
        // generated/static price must never be announced as real-time.
        summary: `${q.provenance === "live" ? "Real-time" : `Non-live FOSS profile (${q.provenance})`} quote for ${q.symbol} (${q.companyName || sym}) via ${q.provider}: $${q.price.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%). Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.${q.provenance === "live" ? "" : " This price is not live market data."}`,
        rows: [
          {
            symbol: q.symbol,
            provider: q.provider,
            price: `$${q.price.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            bidAsk: `$${q.bid.toFixed(2)} / $${q.ask.toFixed(2)}`,
            volume: q.volume.toLocaleString(),
            provenance: q.provenance,
            dataNote: q.note,
          },
        ],
        executedAt,
      };
    }

    if (action === "compare") {
      const syms = plan.researchData?.symbols || [sym, "AMD"];
      const comp = foss.compareStocksSync(syms);
      const anyNonLive = comp.some(
        (c) => weakestFossProvenance(c.quote.provenance, c.fundamentals.provenance) !== "live"
      );
      return {
        plan,
        domain: "research",
        targetTable: "foss_stock_comparison",
        count: comp.length,
        summary: `FOSS Multi-Stock Valuation Comparison across ${comp.map((c) => c.symbol).join(", ")}.${anyNonLive ? " Values include non-live FOSS profile data (see provenance per row) — targets are profile estimates, not analyst consensus." : ""}`,
        rows: comp.map((c) => ({
          symbol: c.symbol,
          company: c.fundamentals.companyName,
          price: `$${c.quote.price.toFixed(2)}`,
          peTrailing: c.fundamentals.peTrailing || "N/A",
          marketCap: `$${(c.fundamentals.marketCap / 1e9).toFixed(1)}B`,
          analystRating: c.fundamentals.recommendationKey?.toUpperCase() || "BUY",
          targetPrice: `$${c.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}`,
          provenance: weakestFossProvenance(c.quote.provenance, c.fundamentals.provenance),
        })),
        executedAt,
      };
    }

    // Default: full research report
    const rep = foss.generateResearchReportSync(sym);
    return {
      plan,
      domain: "research",
      targetTable: "foss_research_report",
      count: 1,
      // Issue #117: the rating comes from the FOSS profile on this sync path —
      // label it "Rating", never "Consensus"; the report's aiAnalysis carries
      // the full data notice for non-live inputs.
      summary: `Autonomous Research Synthesis for ${rep.fundamentals.companyName} (${rep.symbol}): Target: $${rep.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}, Rating: ${rep.analystRating}. ${rep.aiAnalysis}`,
      rows: [
        {
          symbol: rep.symbol,
          company: rep.fundamentals.companyName,
          price: `$${rep.quote.price.toFixed(2)}`,
          peRatio: rep.fundamentals.peTrailing || "N/A",
          marketCap: `$${(rep.fundamentals.marketCap / 1e9).toFixed(1)}B`,
          analystRating: rep.analystRating,
          targetPrice: `$${rep.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}`,
          rsi14: rep.technicalSummary.rsi14,
          technicalTrend: rep.technicalSummary.trend50vs200SMA,
          agentAttestationDid: rep.agentAttestation.did,
          provenance: rep.provenance,
        },
      ],
      executedAt,
    };
  }

  // 5. Default: Query Conversation History
  const messages = orm.messages.findMany({
    where: { sessionId },
    orderBy: "created_at DESC",
    limit: 100,
  });

  const cleanTerms = (plan.terms || "").replace(STOP_WORDS_REGEX, " ").trim().toLowerCase();
  const keywords = cleanTerms
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);

  let filtered = messages;
  if (plan.role && plan.role !== "any") {
    filtered = filtered.filter((m) => m.role === plan.role);
  }

  if (keywords.length > 0) {
    filtered = filtered.filter((m) => {
      const content = (m.content || "").toLowerCase();
      const agent = (m.agent || "").toLowerCase();
      return keywords.some((kw) => content.includes(kw) || agent.includes(kw));
    });
  }

  filtered = filtered.slice(0, plan.limit);

  return {
    plan,
    domain: "conversation",
    targetTable: "mas_messages",
    count: filtered.length,
    summary: `Found ${filtered.length} conversation records matching query.`,
    rows: filtered.map((m) => ({
      role: m.role,
      agent: m.agent,
      content: m.content,
      created_at: m.createdAt,
    })),
    executedAt,
  };
}

/**
 * Asynchronous NLQ execution pipeline for real-time live quoting and market screening
 */
/** Human-readable description for a real SDK schedule, used by the
 *  scheduling list action. Reminder schedules describe themselves via
 *  their payload message; the baseline system callbacks get stable
 *  labels so listings stay informative without hardcoding schedules
 *  that may not exist (issue #109). */
function describeScheduleItem(item: AgentScheduleItem): string {
  const payload: any = item.payload || {};
  if (typeof payload.message === "string" && payload.message) return payload.message;
  switch (item.callback) {
    case "autoRenewETradeTokens":
      return "Proactive E*TRADE OAuth token renewal";
    case "autonomousMarketScreen":
      return "Autonomous market screener";
    case "collectIvHistory":
      return "Daily IV history collection";
    case "autonomousOptionsAnalysis":
      return "Autonomous options analysis";
    case "expireStaleOrderDraft":
      return "Order draft auto-expiry (15-minute HITL window)";
    case "sendScheduledReminder":
      return "Scheduled reminder";
    default:
      return item.callback;
  }
}

/**
 * Issue #109: executes scheduling plans against the REAL Cloudflare
 * Agents scheduling API via the injected port. Every outcome is
 * truthful: creation returns the SDK-issued schedule id, cancellation
 * reports the SDK's actual verdict, listing reflects the Scheduler's
 * live rows (including the baseline system schedules), and any
 * missing port or API failure produces an explicit failure result —
 * never a fabricated success.
 */
async function executeSchedulingAction(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  port: NLQSchedulingPort | undefined,
  userLogin: string,
  executedAt: string
): Promise<NLQQueryResult> {
  const action = plan.scheduleData?.action || "list";
  const base = { plan, domain: "scheduling", targetTable: "cf_agent_schedules", executedAt };

  const failure = (summary: string): NLQQueryResult => ({
    ...base,
    count: 0,
    status: "error",
    summary,
    rows: [],
  });

  if (!port) {
    return failure(
      `Scheduling (${action}) unavailable: no live agent scheduling port is wired in this context, so the request was NOT executed. No schedule was created, cancelled, or listed.`
    );
  }

  const audit = (type: string, payload: Record<string, unknown>) => {
    if (!orm.events) return;
    try {
      orm.events.create({
        id: crypto.randomUUID(),
        sessionId,
        type,
        agent: "orchestrator",
        payload,
        createdAt: executedAt,
      });
    } catch {
      // Audit is best-effort; the Scheduler itself is the source of truth.
    }
  };

  if (action === "list") {
    let schedules: AgentScheduleItem[];
    try {
      schedules = await port.listSchedules();
    } catch (err) {
      return failure(
        `Failed to list schedules: ${err instanceof Error ? err.message : String(err)}. No schedule data could be read.`
      );
    }
    const rows = schedules.slice(0, plan.limit || 25).map((s) => ({
      id: s.id,
      callback: s.callback,
      type: s.type,
      ...(s.cron ? { cron: s.cron } : {}),
      ...(s.intervalSeconds ? { intervalSeconds: s.intervalSeconds } : {}),
      ...(s.delayInSeconds ? { delayInSeconds: s.delayInSeconds } : {}),
      description: describeScheduleItem(s),
      status: "ACTIVE",
      ...(s.time ? { nextRunAt: new Date(s.time * 1000).toISOString() } : {}),
    }));
    return {
      ...base,
      count: rows.length,
      status: rows.length > 0 ? "matches_found" : "no_matches",
      summary:
        rows.length > 0
          ? `Found ${rows.length} active scheduled task(s) registered with the Cloudflare Agent scheduler.`
          : "No active scheduled tasks are registered with the Cloudflare Agent scheduler.",
      rows,
    };
  }

  if (action === "cancel") {
    const scheduleId = plan.scheduleData?.scheduleId || "";
    if (!scheduleId) {
      return failure("Schedule cancellation failed: no schedule ID was provided, so nothing was cancelled.");
    }
    let cancelled: boolean;
    try {
      cancelled = await port.cancelSchedule(scheduleId);
    } catch (err) {
      return failure(
        `Failed to cancel schedule '${scheduleId}': ${err instanceof Error ? err.message : String(err)}. The schedule was NOT cancelled.`
      );
    }
    if (!cancelled) {
      return {
        ...base,
        count: 0,
        status: "not_found",
        summary: `Schedule '${scheduleId}' was not found among the agent's active schedules, so nothing was cancelled. It may have already fired or been cancelled.`,
        rows: [{ scheduleId, status: "NOT_FOUND", cancelledAt: executedAt }],
      };
    }
    audit("schedule.cancelled", { scheduleId, cancelledAt: executedAt });
    return {
      ...base,
      count: 1,
      status: "cancelled",
      summary: `Task schedule '${scheduleId}' cancelled successfully.`,
      rows: [{ scheduleId, status: "CANCELLED", cancelledAt: executedAt }],
    };
  }

  // action === "create"
  const sd: NonNullable<NLQPlan["scheduleData"]> = plan.scheduleData ?? { action: "create" };
  const callback = sd.callback || "sendScheduledReminder";
  const description = sd.description || "Scheduled task";
  const scheduleType =
    sd.scheduleType ||
    (sd.cron ? "cron" : sd.intervalSeconds ? "interval" : sd.date ? "scheduled" : "delayed");

  // Payload contracts are owned by the orchestrator callbacks:
  // sendScheduledReminder expects { reminderId, message, userLogin? }
  // (its reminderId is the dispatch/audit identifier, distinct from
  // the schedule id the SDK returns); autonomousMarketScreen takes the
  // same sector payload the onStart baseline registration uses.
  const payload: Record<string, unknown> =
    callback === "sendScheduledReminder"
      ? { reminderId: crypto.randomUUID(), message: description, userLogin }
      : callback === "autonomousMarketScreen"
        ? { sector: "Technology", maxItems: 5 }
        : { userLogin, description };

  let created: AgentScheduleItem;
  try {
    if (scheduleType === "interval") {
      if (!sd.intervalSeconds || sd.intervalSeconds <= 0) {
        return failure("Schedule creation failed: an interval schedule requires a positive intervalSeconds. The schedule was NOT created.");
      }
      created = await port.scheduleEvery(sd.intervalSeconds, callback, payload);
    } else if (scheduleType === "cron") {
      if (!sd.cron) {
        return failure("Schedule creation failed: a cron schedule requires a cron expression. The schedule was NOT created.");
      }
      created = await port.schedule(sd.cron, callback, payload, { idempotent: true });
    } else if (scheduleType === "scheduled") {
      if (!sd.date) {
        return failure("Schedule creation failed: a one-time schedule requires a date. The schedule was NOT created.");
      }
      const when = new Date(sd.date);
      if (Number.isNaN(when.getTime())) {
        return failure(`Schedule creation failed: '${sd.date}' is not a valid date. The schedule was NOT created.`);
      }
      created = await port.schedule(when, callback, payload);
    } else {
      // delayed
      if (!sd.delayInSeconds || sd.delayInSeconds <= 0) {
        return failure("Schedule creation failed: a delayed schedule requires a positive delayInSeconds. The schedule was NOT created.");
      }
      created = await port.schedule(sd.delayInSeconds, callback, payload);
    }
  } catch (err) {
    return failure(
      `Failed to create schedule: ${err instanceof Error ? err.message : String(err)}. The schedule was NOT created.`
    );
  }

  audit("schedule.created", {
    scheduleId: created.id,
    scheduleType: created.type,
    callback: created.callback,
    delayInSeconds: created.delayInSeconds,
    intervalSeconds: created.intervalSeconds,
    cron: created.cron,
    description,
    createdAt: executedAt,
  });

  return {
    ...base,
    count: 1,
    status: "scheduled",
    summary: `Task scheduled successfully [ID: ${created.id}]. Type: ${created.type}. Callback: ${created.callback}${description ? ` ("${description}")` : ""}.`,
    rows: [
      {
        id: created.id,
        callback: created.callback,
        type: created.type,
        ...(created.delayInSeconds ? { delayInSeconds: created.delayInSeconds } : {}),
        ...(created.intervalSeconds ? { intervalSeconds: created.intervalSeconds } : {}),
        ...(created.cron ? { cron: created.cron } : {}),
        description,
        status: "SCHEDULED",
        ...(created.time ? { nextRunAt: new Date(created.time * 1000).toISOString() } : {}),
        scheduledAt: executedAt,
      },
    ],
  };
}

export async function executeNLQQueryAsync(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userLogin?: string,
  userDid?: string,
  deps?: NLQExecutionDeps
): Promise<NLQQueryResult> {
  const executedAt = new Date().toISOString();
  const loginStr = typeof userLogin === "string" ? userLogin : undefined;
  const effectiveUserDid = userDid || (loginStr?.startsWith("did:") ? loginStr : undefined);

  if (plan.domain === "trading") {
    const login = userLogin || sessionId || "default_trader";
    const etrade = new ETradeService(orm, env, login);
    const action = plan.tradingData?.action || "screen";

    if (action === "capabilities") {
      const caps = getPlatformCapabilitiesDeskSummary();
      return {
        plan,
        domain: "trading",
        targetTable: "platform_capabilities",
        count: caps.workflows.length,
        status: "matches_found",
        summary: caps.spokenSummary,
        displayMarkdown: caps.markdownOverview,
        rows: caps.workflows as any,
        executedAt,
      };
    }

    if (action === "screen") {
      const screenRes = await etrade.screenMarketsAsync(plan.tradingData?.filters);
      let scannerState: "not_run" | "no_universe" | "data_unavailable" | "scan_failed" | "no_matches" | "matches_found" | "SCAN_INVALID_DATA_MISMATCH";
      let summary = "";

      const hasMismatch = screenRes.status === "SCAN_INVALID_DATA_MISMATCH" || screenRes.stocks.some((s) => {
        if (plan.tradingData?.filters?.gainersOnly && s.changePercent <= 0) return true;
        if (plan.tradingData?.filters?.losersOnly && s.changePercent >= 0) return true;
        return false;
      });

      if (screenRes.validationError) {
        scannerState = "data_unavailable";
        summary = screenRes.validationError;
      } else if (hasMismatch) {
        scannerState = "SCAN_INVALID_DATA_MISMATCH";
        summary = `🚨 SCAN INVALID — DATA MISMATCH: One or more returned rows contradicted requested screen filter (${screenRes.filterSummary}). Action shortcuts disabled.`;
      } else if (screenRes.totalScreened === 0) {
        scannerState = "no_universe";
        summary = screenRes.discovery?.message || "Dynamic all-exchange listings returned no equities.";
      } else if (screenRes.stocks.length === 0) {
        scannerState = "no_matches";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; 0 matched criteria] (${screenRes.filterSummary}).`;
      } else {
        scannerState = "matches_found";
        summary = `Market Scanner: [Scanned ${screenRes.totalScreened} equities; ${screenRes.stocks.length} passed criteria] (${screenRes.filterSummary}).`;
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_screener",
        count: screenRes.stocks.length,
        status: scannerState,
        summary,
        validationError: screenRes.validationError,
        discovery: screenRes.discovery,
        scanLedger: screenRes.ledger,
        movers: screenRes.movers,
        provenance: {
          scannerState,
          universeCount: screenRes.totalScreened,
          passedCount: screenRes.stocks.length,
          rejectedCount: screenRes.ledger?.rejectedCount ?? 0,
          dataSource: "Dynamic Nasdaq / NYSE / AMEX stock listings",
          quoteTimestamp: "Not provided by the listing endpoint",
          executedAt,
        },
        rows: screenRes.stocks.map((s) => {
          const rowMismatch =
            (plan.tradingData?.filters?.gainersOnly && s.changePercent <= 0) ||
            (plan.tradingData?.filters?.losersOnly && s.changePercent >= 0);
          return {
            symbol: s.symbol,
            companyName: s.companyName,
            sector: s.sector,
            exchange: s.listingExchange || (s as any).exchange || "N/A",
            price: `$${s.price.toFixed(2)}`,
            rawPrice: s.price,
            change: `${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%)`,
            changePercent: s.changePercent,
            marketCap: formatMarketCap(s.marketCap),
            source: s.source || "Dynamic stock listing",
            quoteTimestamp: s.timestamp || executedAt,
            validationStatus: rowMismatch ? "FAIL_MISMATCH" : (s.validationStatus || "PASS_CONFIRMED"),
            actionAvailable: (hasMismatch || rowMismatch) ? "DISABLED (DATA MISMATCH)" : `Preview Buy/Sell for ${s.symbol}`,
          };
        }),
        executedAt,
      };
    }

    if (action === "quote") {
      const sym = plan.tradingData?.symbol || plan.terms || "NVDA";
      const q = await etrade.fetchQuoteRemote(sym);
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_market_quotes",
        count: 1,
        summary: formatTradingQuoteHeadline(q),
        rows: [
          {
            symbol: q.symbol,
            company: q.companyName,
            lastPrice: `$${q.lastPrice.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            changePeriod: "1D (Regular Trading Day)",
            priorClose: `$${(q.previousClose || (q.lastPrice - q.change)).toFixed(2)}`,
            bidAsk: formatTradingQuoteBidAsk(q),
            volume: q.volume.toLocaleString(),
            range52Week: `$${((q.low52 ?? q.week52Low) || 0).toFixed(2)} - ${((q.high52 ?? q.week52High) || 0).toFixed(2)}`,
            peRatio: q.peRatio ? q.peRatio.toFixed(1) : "N/A",
            marketCap: formatMarketCap(q.marketCap),
            source: q.source,
            quoteStatus: q.quoteStatus || "UNKNOWN",
            quoteTimestamp: q.timestamp || executedAt,
          },
        ],
        executedAt,
      };
    }

    if (action === "preview_order") {
      const sym = (plan.tradingData?.symbol || "").trim().toUpperCase();
      if (!sym) {
        return {
          plan,
          domain: "trading",
          targetTable: "mas_trades",
          count: 0,
          summary: "E*TRADE order preview requires a valid stock symbol (e.g. 'buy 10 shares of NVDA').",
          rows: [],
          executedAt,
        };
      }
      const qty = plan.tradingData?.quantity || 1;
      const orderAction = plan.tradingData?.orderAction || "BUY";
      const quote = await etrade.fetchQuoteRemote(sym);
      const relativeOffset = plan.tradingData?.relativePriceOffsetPercent;
      const relativeDesc = plan.tradingData?.relativePriceDescription;

      let limitPrice = plan.tradingData?.limitPrice;
      let orderType = plan.tradingData?.orderType || (limitPrice !== undefined || relativeOffset !== undefined ? "LIMIT" : "MARKET");

      if (relativeOffset !== undefined && quote.lastPrice > 0) {
        orderType = "LIMIT";
        limitPrice = Number((quote.lastPrice * (1 + relativeOffset / 100)).toFixed(2));
      } else if (limitPrice !== undefined) {
        orderType = "LIMIT";
      }

      const draft = await etrade.previewOrderRemote({
        sessionId,
        symbol: sym,
        orderAction,
        quantity: qty,
        orderType,
        limitPrice,
      });

      const shareWord = draft.quantity === 1 ? "share" : "shares";
      const marketPriceStr = quote.lastPrice > 0 ? `$${quote.lastPrice.toFixed(2)}` : "Market";

      let pricingSummary = `at ~$${draft.estimatedPrice.toFixed(2)}`;
      if (draft.orderType === "LIMIT") {
        if (relativeDesc && quote.lastPrice > 0) {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)} (${relativeDesc} prevailing quote ${marketPriceStr})`;
        } else {
          pricingSummary = `at limit price $${draft.estimatedPrice.toFixed(2)}`;
        }
      }

      // Issue #118: same non-live pricing disclosure as the sync executor.
      const pricingQuoteStatus = draft.pricingQuoteStatus ?? quote.quoteStatus;
      const nonLivePricingNote = isNonLivePricingQuoteStatus(pricingQuoteStatus)
        ? ` ${nonLivePricingNotice(pricingQuoteStatus)}`
        : "";

      const summary = `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} ${shareWord} of ${draft.symbol} ${pricingSummary}. Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.${nonLivePricingNote}`;

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary,
        rows: [
          {
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
            limitPrice: draft.limitPrice !== undefined ? `$${draft.limitPrice.toFixed(2)}` : "N/A (Market Order)",
            prevailingMarketPrice: marketPriceStr,
            pricingQuoteStatus: pricingQuoteStatus || "UNKNOWN",
            relativePricing: relativeDesc,
            estimatedPrice: `$${draft.estimatedPrice.toFixed(2)}`,
            estimatedTotal: `$${draft.estimatedTotal.toFixed(2)}`,
            commission: `$${draft.estimatedCommission.toFixed(2)}`,
            proposerDid: draft.proposerDid,
            status: draft.status.toUpperCase(),
            safetyGuarantee: "No live trade submitted. Human approval required.",
            authorizationPrompt: `Reply 'approve ${draft.orderId}' or execute via Trading Hub.`,
          },
        ],
        executedAt,
      };
    }

    if (action === "positions") {
      const posRes = await etrade.fetchPortfolioRemote();
      const posTotal = Number(posRes.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0).toFixed(2));
      const statedCash = Number((posRes.account.cashAvailableForInvestment || 0).toFixed(2));
      const calculatedTotal = Number((posTotal + statedCash).toFixed(2));
      const statedTotal = Number((posRes.account.totalAccountValue || posRes.account.netAccountValue || calculatedTotal).toFixed(2));
      const variance = Math.abs(Number((statedTotal - calculatedTotal).toFixed(2)));
      const isReconciled = variance <= 1.00;

      if (!isReconciled) {
        return {
          plan,
          domain: "trading",
          targetTable: "etrade_portfolio_live",
          count: posRes.positions.length,
          status: "RECONCILIATION_FAILED",
          reconciled: false,
          summary: `⚠️ UNVERIFIED / POSSIBLE DEMO DATA: Portfolio result cannot be reconciled ($${variance.toFixed(2)} unexplained variance between stated total $${statedTotal.toFixed(2)} and positions+cash $${calculatedTotal.toFixed(2)})—no account conclusion shown.`,
          discrepancy: {
            statedAccountTotal: `$${statedTotal.toFixed(2)}`,
            positionsMarketValue: `$${posTotal.toFixed(2)}`,
            statedCash: `$${statedCash.toFixed(2)}`,
            calculatedTotal: `$${calculatedTotal.toFixed(2)}`,
            unexplainedVariance: `$${variance.toFixed(2)}`,
          },
          provenance: {
            dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
            environment: resolveEnvironmentConfig(env).name,
            accountKey: `••••${posRes.account.accountId.slice(-4)}`,
            reconciliationStatus: "FAIL_CLOSED",
            pricesObservedAt: executedAt,
            evaluatedAt: executedAt,
          },
          rows: [],
          executedAt,
        };
      }

      return {
        plan,
        domain: "trading",
        targetTable: "etrade_portfolio_live",
        count: posRes.positions.length,
        status: "RECONCILED",
        reconciled: true,
        summary: `E*TRADE Account ••••${posRes.account.accountId.slice(-4)}: Reconciled Total Value $${statedTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })} (Holdings: $${posTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}, Cash: $${statedCash.toLocaleString("en-US", { minimumFractionDigits: 2 })}), Open Positions: ${posRes.positions.length}.`,
        provenance: {
          dataSource: resolveEnvironmentConfig(env).isLive ? "E*TRADE Live REST API (/v1/accounts/portfolio.json)" : "E*TRADE Sandbox REST API (/v1/accounts/portfolio.json)",
          environment: resolveEnvironmentConfig(env).name,
          accountKey: `••••${posRes.account.accountId.slice(-4)}`,
          reconciliationStatus: "VERIFIED_EXACT",
          pricesObservedAt: executedAt,
          evaluatedAt: executedAt,
        },
        rows: posRes.positions.map((p) => ({
          symbol: p.symbol,
          description: p.description,
          shares: p.quantity,
          costBasis: `$${p.costBasis.toFixed(2)}`,
          lastPrice: `$${p.marketPrice.toFixed(2)}`,
          marketValue: `$${p.marketValue.toFixed(2)}`,
          unrealizedGainLoss: `${p.unrealizedGainLoss >= 0 ? "+" : ""}$${p.unrealizedGainLoss.toFixed(2)} (${p.unrealizedGainLossPercent.toFixed(2)}%)`,
        })),
        executedAt,
      };
    }

    if (action === "options_strategies" || action === "options_best_trade" || action === "options_opportunities") {
      const res = await runOptionsStrategyAction(etrade, action, plan.tradingData?.filters as OptionsStrategyIntent["filters"] | undefined, {
        scanRunStore: deps?.scanRunStore,
        profileStore: deps?.profileStore,
        // Issue #28: profile resolution is scoped to the session's
        // login — the same fallback chain the ETradeService above uses.
        userLogin: deps?.userLogin ?? login,
      });
      return {
        plan,
        domain: "trading",
        targetTable: action === "options_best_trade" ? "etrade_options_best_trade" : action === "options_opportunities" ? "etrade_options_opportunities" : "etrade_options_strategies",
        count: res.count,
        status: res.status,
        summary: res.summary,
        validationError: res.validationError,
        quoteQuality: res.quoteQuality as NLQQueryResult["quoteQuality"],
        rejections: res.rejections as NLQQueryResult["rejections"],
        provenance: res.bestTrade ? { bestTrade: res.bestTrade } : undefined,
        // Issue #27: surface the persisted scan run id (opportunities
        // scans only; undefined everywhere else).
        scanRunId: res.scanRunId,
        persisted: res.persisted,
        // Issue #28: surface the applied profile's provenance stamp.
        profileRef: res.profileRef,
        rows: res.rows,
        executedAt,
      };
    }

    if (action === "options_screen") {
      const rawFilters = plan.tradingData?.filters || {};
      const hasUniverse = (rawFilters.underlyingSymbols?.length ?? 0) > 0 || rawFilters.maxUnderlyings !== undefined;
      // Broad screens without an explicit universe get a visible, capped discovery limit so a
      // live scan never fans out over every U.S. listing (sanitize clamps it to MAX_SCAN_SYMBOLS).
      const DEFAULT_BROAD_SCAN_UNDERLYINGS = 10;
      const filters = hasUniverse ? rawFilters : { ...rawFilters, maxUnderlyings: DEFAULT_BROAD_SCAN_UNDERLYINGS };
      const screener = new DynamicOptionsScreener(etrade.client);
      const res = await screener.screenOptions(filters);
      const freshnessNote = res.quoteQuality?.staleContractsReturned || res.quoteQuality?.unknownFreshnessContracts
        ? ` Freshness: ${res.quoteQuality.staleContractsReturned} returned contracts are stale and ${res.quoteQuality.unknownFreshnessContracts} have unknown timestamps; freshest stale quote was ${Math.round(res.quoteQuality.freshestStaleQuoteAgeSeconds || 0)}s old (freshness reference ${res.quoteQuality.referenceAgeSeconds ?? res.quoteQuality.maxAgeSeconds ?? 60}s).`
        : "";
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_options_screener",
        count: res.contracts.length,
        status: res.status,
        summary: res.status === "error" && res.validationError
          ? `Options Screener: ${res.validationError}`
          : `Options Screener: [Evaluated ${res.totalContractsEvaluated} contracts across ${res.totalUnderlyingsScanned} symbols; ${res.contracts.length} matched criteria${typeof res.totalMatches === "number" && res.totalMatches > res.contracts.length ? ` (${res.totalMatches} total matches before limit)` : ""}] (${res.filterSummary}).${freshnessNote}`,
        validationError: res.validationError,
        quoteQuality: res.quoteQuality,
        rejections: (res.rejections || []).slice(0, 15),
        ...(res.fetchErrors && res.fetchErrors.length > 0 ? { fetchErrors: res.fetchErrors } : {}),
        ...(res.warnings && res.warnings.length > 0 ? { warnings: res.warnings } : {}),
        rows: res.contracts.map((c) => ({
          contractSymbol: c.osiKey || c.symbol,
          underlying: c.underlyingSymbol,
          underlyingPrice: `$${c.underlyingPrice.toFixed(2)}`,
          type: c.optionType,
          strike: `$${c.strikePrice.toFixed(2)}`,
          bidAsk: `$${c.bid.toFixed(2)} / $${c.ask.toFixed(2)}`,
          spreadPercent: `${c.spreadPct.toFixed(2)}%`,
          quoteAgeSeconds: c.quoteAgeSeconds !== undefined ? `${c.quoteAgeSeconds.toFixed(1)}s` : "N/A",
          quoteFreshness: c.quoteFreshness || "UNKNOWN",
          delta: c.delta !== undefined ? c.delta.toFixed(2) : "N/A",
          iv: c.impliedVolatility !== undefined ? `${(c.impliedVolatility * 100).toFixed(1)}%` : "N/A",
          volume: (c.volume || 0).toLocaleString(),
          openInterest: (c.openInterest || 0).toLocaleString(),
          volOiRatio: c.volumeOiRatio !== undefined ? `${c.volumeOiRatio.toFixed(2)}x` : "N/A",
          dte: `${c.daysToExpiration}d (${c.expirationDate})`,
          moneyness: c.moneyness,
          technicalSignal: c.technicalSignal,
        })),
        executedAt,
      };
    }

    if (action === "options_flow") {
      const sym = plan.tradingData?.symbol;
      const flows = await getDynamicLiveFlowItems(env, { tickers: sym ? [sym] : undefined });
      const filtered = flows.filter((f) => {
        if (plan.tradingData?.filters?.bullishOnly && f.sentiment !== "bullish") return false;
        if (plan.tradingData?.filters?.bearishOnly && f.sentiment !== "bearish") return false;
        if (plan.tradingData?.filters?.sweepsOnly && f.type !== "SWEEP") return false;
        if (plan.tradingData?.filters?.unusualOnly && !f.volOverOi) return false;
        return true;
      });

      return {
        plan,
        domain: "trading",
        targetTable: "options_flows",
        count: filtered.length,
        summary: sym
          ? `Options Flow: Found ${filtered.length} modelled flow estimates for ${sym} (${describeFlowProvenance(filtered)}). This product has no live options trade tape, so these are not real-time executed prints.`
          : `Options Flow: Found ${filtered.length} modelled flow estimates across the market universe (${describeFlowProvenance(filtered)}). This product has no live options trade tape, so these are not real-time executed prints.`,
        rows: filtered.slice(0, plan.limit || 25).map((f) => ({
          time: f.time,
          provenance: f.provenance,
          symbol: f.symbol,
          underlyingPrice: `$${f.underlyingPrice.toFixed(2)}`,
          strategy: f.strategy,
          type: f.type,
          side: f.side,
          sentiment: f.sentiment.toUpperCase(),
          premium: f.premiumFormatted,
          volume: f.volume.toLocaleString(),
          openInterest: f.openInterest.toLocaleString(),
          volOverOi: f.volOverOi ? "YES" : "NO",
          dte: `${f.dte}d`,
          reasoning: f.sentimentReasoning,
        })),
        executedAt,
      };
    }

    if (action === "watchlist_save") {
      const name = plan.tradingData?.watchlistName || "My Watchlist";
      let symbols = plan.tradingData?.symbols || [];
      if (symbols.length === 0) {
        const screened = await etrade.screenMarketsAsync(plan.tradingData?.filters);
        symbols = screened.stocks.slice(0, 10).map((s) => s.symbol);
      }
      if (symbols.length === 0) {
        symbols = ["NVDA", "AAPL", "MSFT", "AMD"];
      }

      const res = await etrade.saveScanAsWatchlist(name, symbols);
      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: res.symbolCount,
        summary: res.message,
        rows: [
          {
            watchlistId: res.watchlistId,
            name: res.name,
            symbolCount: res.symbolCount,
            symbols: res.symbols.join(", "),
            source: res.source === "etrade_api" ? "E*TRADE Live API" : "Local Durable SQLite",
            status: "SAVED",
            timestamp: res.timestamp,
          },
        ],
        executedAt,
      };
    }

    if (action === "watchlist_list") {
      const all = await etrade.getWatchlists();
      return {
        plan,
        domain: "trading",
        targetTable: "mas_watchlists",
        count: all.length,
        summary: `Found ${all.length} saved watchlist(s) across E*TRADE and local storage.`,
        rows: all.map((w) => ({
          watchlistId: w.watchlistId,
          name: w.name,
          symbolCount: w.symbols.length,
          symbols: w.symbols.join(", "),
          source: w.source || "etrade_api",
        })),
        executedAt,
      };
    }
  }

  if (plan.domain === "agentic_payments") {
    const paymentService = new ETradeAgenticPaymentService(orm, env, sessionId);
    const action = plan.agenticPaymentsData?.action || "wallet_status";

    if (action === "paid_scan") {
      const sym = plan.agenticPaymentsData?.symbol;
      const login = userLogin || sessionId || "default_trader";
      const etrade = new ETradeService(orm, env, login);
      const screener = new DynamicOptionsScreener(etrade.client);
      const res = await screener.screenOptions({
        underlyingSymbols: sym ? [sym] : undefined,
        maxUnderlyings: plan.agenticPaymentsData?.maxUnderlyings,
        contractType: plan.agenticPaymentsData?.contractType,
      });

      const tier = TRADING_PAID_SERVICES.OPTIONS_SCREENER;
      // Issue #122: no payment is collected or verified on this path — the
      // receipt is a simulated local record and must say so (never
      // status "verified", never a fabricated txHash).
      const receipt: any = {
        receiptId: `rcpt_${Date.now()}`,
        protocol: "x402",
        resource: tier.resource,
        amount: tier.priceUSD,
        currency: "USDC",
        network: env?.X402_NETWORK || "base-sepolia",
        payer: login,
        recipient: env?.X402_RECIPIENT_ADDRESS || "0x71C8363837918a211797E3c76A8B3C4258759550",
        status: "simulated",
        simulated: true,
        timestamp: executedAt,
        note: "Simulated local payment record for an NLQ paid-service invocation: no payment was collected or verified.",
      };
      await paymentService.recordPaymentTransaction(receipt, "inbound");

      return {
        plan,
        domain: "agentic_payments",
        targetTable: "etrade_premium_options",
        count: res.contracts.length,
        summary: res.validationError || `Paid Options Screener ($${tier.priceUSD.toFixed(2)} USDC): Scanned ${res.totalUnderlyingsScanned} dynamic underlying(s). Found ${res.contracts.length} contracts. ${res.quoteQuality?.staleContractsReturned || 0} returned contracts are marked stale. Receipt: ${receipt.receiptId}. Payment was SIMULATED (local record only — no real payment was collected or verified).`,
        rows: res.contracts.slice(0, 10).map((c) => ({
          contract: c.osiKey || c.displaySymbol || c.symbol,
          strike: `$${c.strikePrice.toFixed(2)}`,
          type: c.optionType,
          delta: c.delta?.toFixed(2) || "N/A",
          iv: c.impliedVolatility ? `${(c.impliedVolatility * 100).toFixed(1)}%` : "N/A",
          dte: c.daysToExpiration,
          lastPrice: `$${c.lastPrice.toFixed(2)}`,
        })),
        executedAt,
      };
    }

    if (action === "paid_research") {
      const sym = plan.agenticPaymentsData?.symbol || plan.terms || "NVDA";
      const foss = new FossResearchService(env);
      const report = await foss.generateResearchReport(sym);

      const tier = TRADING_PAID_SERVICES.MARKET_RESEARCH;
      // Issue #122: same rule as paid_scan — a simulated local record, never
      // a "verified" receipt with a fabricated txHash.
      const receipt: any = {
        receiptId: `rcpt_${Date.now()}`,
        protocol: "x402",
        resource: tier.resource,
        amount: tier.priceUSD,
        currency: "USDC",
        network: env?.X402_NETWORK || "base-sepolia",
        payer: userLogin || sessionId || "default_trader",
        recipient: env?.X402_RECIPIENT_ADDRESS || "0x71C8363837918a211797E3c76A8B3C4258759550",
        status: "simulated",
        simulated: true,
        timestamp: executedAt,
        note: "Simulated local payment record for an NLQ paid-service invocation: no payment was collected or verified.",
      };
      await paymentService.recordPaymentTransaction(receipt, "inbound");

      const companyName = report.quote.companyName || report.fundamentals.companyName || report.symbol;
      const targetPrice = report.fundamentals.targetMeanPrice ? `$${report.fundamentals.targetMeanPrice.toFixed(2)}` : "N/A";
      const currentPrice = `$${report.quote.price.toFixed(2)}`;

      return {
        plan,
        domain: "agentic_payments",
        targetTable: "etrade_premium_research",
        count: 1,
        // Issue #117: a paid report built on non-live inputs must say so —
        // the buyer is told what the data actually is.
        // Issue #122: and the "payment" is a simulated local record — the
        // summary must say no real payment was collected or verified.
        summary: `Paid Market Research ($${tier.priceUSD.toFixed(2)} USDC): Generated valuation report for ${sym}. Rating: ${report.analystRating}. Target: ${targetPrice}. Receipt: ${receipt.receiptId}. Payment was SIMULATED (local record only — no real payment was collected or verified).${report.provenance !== "live" ? ` Data provenance: ${report.provenance} — this report is based on non-live FOSS data, and its target is a profile estimate, not analyst consensus.` : ""}`,
        rows: [
          {
            symbol: report.symbol,
            companyName,
            analystRating: report.analystRating,
            targetPrice,
            currentPrice,
            receiptId: receipt.receiptId,
            paymentSimulated: true,
            provenance: report.provenance,
          },
        ],
        executedAt,
      };
    }
  }

  if (plan.domain === "scheduling") {
    // Issue #109: real Agent schedules via the injected port (see
    // executeSchedulingAction). Handled here, never by the sync
    // executor, which can only refuse honestly.
    return executeSchedulingAction(
      orm,
      sessionId,
      plan,
      deps?.schedulingPort,
      loginStr || sessionId || "default_trader",
      executedAt
    );
  }

  return executeNLQQuery(orm, sessionId, plan, env, effectiveUserDid);
}

export async function executeNaturalLanguageQuery(
  orm: DatabaseORM,
  sessionId: string,
  query: string,
  env: Env,
  userLoginOrOptions?: string | { context?: string; validateWithLLM?: boolean },
  userDid?: string,
  options?: { context?: string; validateWithLLM?: boolean; scanRunStore?: ScanRunStore; profileStore?: StrategyProfileStore; schedulingPort?: NLQSchedulingPort }
): Promise<{ plan: NLQPlan; result: NLQQueryResult }> {
  let userLogin: string | undefined;
  let resolvedOptions = options;
  if (typeof userLoginOrOptions === "object" && userLoginOrOptions !== null) {
    resolvedOptions = userLoginOrOptions;
    userLogin = undefined;
  } else {
    userLogin = userLoginOrOptions;
  }

  const plan = await planNLQ(env, query, { context: resolvedOptions?.context, preferLLM: resolvedOptions?.validateWithLLM });
  const validation = await validateNLQPlanWithLLM(env, query, plan, resolvedOptions?.context);
  const result = await executeNLQQueryAsync(
    orm,
    sessionId,
    plan,
    env,
    userLogin,
    userDid,
    resolvedOptions?.scanRunStore || resolvedOptions?.profileStore || resolvedOptions?.schedulingPort
      ? { scanRunStore: resolvedOptions?.scanRunStore, profileStore: resolvedOptions?.profileStore, userLogin, schedulingPort: resolvedOptions?.schedulingPort }
      : undefined,
  );
  if (!result.planSource && plan.planSource) {
    result.planSource = plan.planSource;
  }
  result.llmValidation = validation;
  return { plan, result };
}
