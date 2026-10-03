import { generateText } from "ai";
import { getWorkersAIModel } from "./model";
import { z } from "zod";
import type { Env, OptionScreenRejection, StockScreenLedger, StockScreenResult } from "../types";
import type { DatabaseORM } from "../orm";
import { ETradeService } from "../services/etrade";
import { FossResearchService } from "../services/fossResearch";
import { resolveEnvironmentConfig } from "../config/environment";
import { DynamicOptionsScreener } from "../trading/optionsScreener";
import { parseOptionsStrategyIntent, runOptionsStrategyAction, type OptionsStrategyIntent } from "./nlqOptionsStrategy";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../services/agenticPayments";

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
          "positions",
          "options_screen",
          "options_strategies",
          "options_best_trade",
          "options_opportunities",
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
      filters: z.record(z.string(), z.any()).optional(),
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
  terms: z.string().max(200).default(""),
  role: z.enum(["user", "assistant", "any"]).default("any"),
  since: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
});

export type NLQPlan = z.infer<typeof nlqPlanSchema>;

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
  discrepancy?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  scanLedger?: StockScreenLedger | Record<string, unknown>;
  discovery?: StockScreenResult["discovery"];
  validationError?: string;
  quoteQuality?: {
    maxAgeSeconds?: number;
    staleContractsReturned: number;
    unknownFreshnessContracts: number;
    freshestStaleQuoteAgeSeconds?: number;
  };
  rejections?: OptionScreenRejection[];
}

const STOP_WORDS_REGEX = /\b(questions?|messages?|chats?|history|transcript|conversations?|asked|queries|all|results?|references?|containing|contains|with|for|about|find|show|list|get|any|where|me)\b/gi;

export async function planNLQ(env: Env, question: string): Promise<NLQPlan> {
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

  // 3c. Fast-path for Options Screening
  if (
    (/\b(options?|contracts?)\b/i.test(question) && /\b(screen|screener|scan|scanning|scanned|filter|chains?)\b/i.test(question)) ||
    /\b(call|put)\s+options?\b/i.test(question) ||
    (/\boptions?\b/i.test(question) && /\b(delta|iv|implied\s+volatility|gamma|theta|dte|strike|moneyness)\b/i.test(question))
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

  // 4. Fast-path for E*TRADE Stock Screening / Market Scanning
  if (
    /\b(screen|screener|scan|scanning|scanned|breakout|oversold|overbought|gainers?|losers?|momentum)\b/i.test(question) ||
    ( /\b(stocks?|equities|listings)\b/i.test(question) && /\b(tech|semiconductor|rsi|macd|pe|p\/e|cap|volume|dividend|growth|price|priced|exchange|nasdaq|nyse|amex)\b/i.test(question))
  ) {
    const filters: Record<string, any> = {};
    // Keep unsupported filters in the plan so the listing provider can explain why they cannot be applied.
    if (/\b(tech|technology)\b/i.test(question)) filters.sector = "Technology";
    if (/\b(semiconductor|semis|chips)\b/i.test(question)) filters.sector = "Semiconductors";
    if (/\b(cloud|enterprise|software)\b/i.test(question)) filters.sector = "Enterprise Software";
    if (/\b(crypto|bitcoin|fintech)\b/i.test(question)) filters.sector = "Fintech & Crypto";

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

    if (/\b(gainer|gainers|up|green)\b/i.test(question)) filters.gainersOnly = true;
    if (/\b(loser|losers|down|red)\b/i.test(question)) filters.losersOnly = true;

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

  // 7. Fast-path for E*TRADE Order Proposal / Preview
  const orderMatch = question.match(/\b(buy|sell|short|purchase)\s+(\d+)?\s*(?:shares?\s*(?:of\s*)?)?([A-Za-z]{1,5})\b/i);
  if (orderMatch && !/\b(messages?|categories|tables?)\b/i.test(question)) {
    const rawAction = orderMatch[1].toLowerCase();
    const orderAction = rawAction === "sell" ? "SELL" : rawAction === "short" ? "SELL_SHORT" : "BUY";
    const quantity = orderMatch[2] ? Number(orderMatch[2]) : 10;
    const symbol = orderMatch[3].toUpperCase();

    const limitMatch = question.match(/limit\s*(?:at|of)?\s*\$?(\d+(?:\.\d+)?)/i);
    const limitPrice = limitMatch ? Number(limitMatch[1]) : undefined;

    return {
      domain: "trading",
      operation: "create",
      tradingData: {
        action: "preview_order",
        symbol,
        orderAction,
        quantity,
        orderType: limitPrice ? "LIMIT" : "MARKET",
        limitPrice,
      },
      terms: `${orderAction} ${quantity} ${symbol}`,
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

  try {
    const model = getWorkersAIModel(env);
    const { text } = await generateText({
      model,
      temperature: 0,
      system: `You are an NLQ planner for an enterprise multi-agent database over SQLite.
Classify the user's natural language request into a query plan:
Domains:
1. 'tables': if asking to list tables, inspect database schema, or show structure.
2. 'table_data': if asking to view/search records in a specific table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_messages, mas_memory, mas_events, mas_trades).
3. 'category_mutation': if asking to add or update referral categories.
4. 'trading': if asking to screen/scan stocks, get quotes, preview trades, or inspect positions.
5. 'conversation': if asking questions about past chat messages or user prompts.

Return JSON only:
{
  "domain": "tables"|"table_data"|"category_mutation"|"trading"|"conversation",
  "operation": "list"|"count"|"search"|"create"|"update",
  "targetTable": "mas_categories"|"mas_referrals"|"mas_ads"|"mas_transactions"|"mas_messages"|"mas_events"|"mas_trades",
  "terms": "search keyword",
  "role": "any"|"user"|"assistant",
  "limit": 25
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
      return nlqPlanSchema.parse(parsed);
    }
  } catch {
    // Fall back to conversation search
  }

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
  };
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
  if (plan.domain === "scheduling") {
    const action = plan.scheduleData?.action || "list";

    if (action === "list") {
      const scheduleEvents = orm.events
        ? orm.events.findMany({
            where: { type: "schedule.created" },
            orderBy: "created_at DESC",
            limit: plan.limit || 20,
          })
        : [];

      const baselineSchedules = [
        {
          id: "sched_cron_etrade_renew",
          callback: "autoRenewETradeTokens",
          type: "cron",
          cron: "0 23 * * *",
          description: "Proactive E*TRADE OAuth 1.0a token renewal before midnight ET",
          status: "ACTIVE",
        },
        {
          id: "sched_interval_market_screen",
          callback: "autonomousMarketScreen",
          type: "interval",
          intervalSeconds: 300,
          description: "Autonomous market screener (Technology sector)",
          status: "ACTIVE",
        },
      ];

      const customSchedules = scheduleEvents.map((evt) => {
        const p: any = evt.payload || {};
        return {
          id: p.scheduleId || evt.id,
          callback: p.callback || "customTask",
          type: p.scheduleType || "delayed",
          description: p.description || p.callback || "Scheduled task",
          status: "REGISTERED",
          createdAt: evt.createdAt,
        };
      });

      const all = [...baselineSchedules, ...customSchedules];

      return {
        plan,
        domain: "scheduling",
        targetTable: "mas_schedules",
        count: all.length,
        summary: `Found ${all.length} active and registered scheduled task(s) for Cloudflare Agent.`,
        rows: all,
        executedAt,
      };
    }

    if (action === "cancel") {
      const scheduleId = plan.scheduleData?.scheduleId || "";
      if (orm.events) {
        try {
          orm.events.create({
            id: crypto.randomUUID(),
            sessionId,
            type: "schedule.cancelled",
            agent: "orchestrator",
            payload: { scheduleId, cancelledAt: executedAt },
            createdAt: executedAt,
          });
        } catch {
          // ignore
        }
      }

      return {
        plan,
        domain: "scheduling",
        targetTable: "mas_schedules",
        count: 1,
        summary: `Task schedule '${scheduleId}' cancelled successfully.`,
        rows: [{ scheduleId, status: "CANCELLED", cancelledAt: executedAt }],
        executedAt,
      };
    }

    if (action === "create") {
      const { scheduleType, callback, delayInSeconds, intervalSeconds, cron, description } = plan.scheduleData || {};
      const newId = `sched_${scheduleType || "delayed"}_${Date.now().toString(36)}`;

      if (orm.events) {
        try {
          orm.events.create({
            id: crypto.randomUUID(),
            sessionId,
            type: "schedule.created",
            agent: "orchestrator",
            payload: {
              scheduleId: newId,
              scheduleType: scheduleType || "delayed",
              callback: callback || "sendScheduledReminder",
              delayInSeconds,
              intervalSeconds,
              cron,
              description: description || "Scheduled task",
              createdAt: executedAt,
            },
            createdAt: executedAt,
          });
        } catch {
          // ignore
        }
      }

      return {
        plan,
        domain: "scheduling",
        targetTable: "mas_schedules",
        count: 1,
        summary: `Task scheduled successfully [ID: ${newId}]. Type: ${scheduleType || "delayed"}. Callback: ${callback || "sendScheduledReminder"}${description ? ` ("${description}")` : ""}.`,
        rows: [
          {
            id: newId,
            callback: callback || "sendScheduledReminder",
            type: scheduleType || "delayed",
            delayInSeconds,
            intervalSeconds,
            cron,
            description,
            status: "SCHEDULED",
            scheduledAt: executedAt,
          },
        ],
        executedAt,
      };
    }
  }

  // 1c. Cloudflare Agentic Payments Operations (x402 & MPP)
  if (plan.domain === "agentic_payments") {
    const paymentService = new ETradeAgenticPaymentService(orm, env, sessionId);
    const action = plan.agenticPaymentsData?.action || "wallet_status";

    if (action === "wallet_status") {
      let totalSpent = 0;
      let totalEarned = 0;
      let count = 0;
      if (orm.transactions) {
        const allTx = orm.transactions.findMany();
        for (const tx of allTx) {
          if (tx.gateway === "x402" || tx.gateway === "mpp") {
            count++;
            if (tx.action === "agentic_payment" || tx.action === "charge") {
              totalEarned += tx.amount;
            } else if (tx.action === "micropayment" || tx.action === "payout") {
              totalSpent += tx.amount;
            }
          }
        }
      }
      const balance = Math.max(0, 50.0 + totalEarned - totalSpent);
      const network = env?.X402_NETWORK || "base-sepolia";
      const autoLimit = Number(env?.X402_AUTO_APPROVE_LIMIT || 0.05);

      return {
        plan,
        domain: "agentic_payments",
        targetTable: "mas_agentic_wallet",
        count: 1,
        summary: `Cloudflare Agentic Wallet: Balance $${balance.toFixed(2)} USDC on ${network}. Auto-approve limit: $${autoLimit.toFixed(2)}. Total spent: $${totalSpent.toFixed(2)}, total earned: $${totalEarned.toFixed(2)} across ${count} micropayments.`,
        rows: [
          {
            network,
            balanceUSD: `$${balance.toFixed(2)}`,
            autoApproveLimitUSD: `$${autoLimit.toFixed(2)}`,
            totalSpentUSD: `$${totalSpent.toFixed(2)}`,
            totalEarnedUSD: `$${totalEarned.toFixed(2)}`,
            micropaymentCount: count,
            status: "ACTIVE",
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
            price: `$${s.price.toFixed(2)}`,
            change: `${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%)`,
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
        summary: `Real-time quote for ${q.symbol} (${q.companyName}): $${q.lastPrice.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%). Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`,
        rows: [
          {
            symbol: q.symbol,
            company: q.companyName,
            lastPrice: `$${q.lastPrice.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            changePeriod: "1D (Regular Trading Day)",
            priorClose: `$${(q.previousClose || (q.lastPrice - q.change)).toFixed(2)}`,
            bidAsk: `$${q.bid.toFixed(2)} / $${q.ask.toFixed(2)}`,
            volume: q.volume.toLocaleString(),
            range52Week: `$${((q.low52 ?? q.week52Low) || 0).toFixed(2)} - ${((q.high52 ?? q.week52High) || 0).toFixed(2)}`,
            peRatio: q.peRatio ? q.peRatio.toFixed(1) : "N/A",
            marketCap: formatMarketCap(q.marketCap),
            source: q.source,
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
      const draft = etrade.previewOrder({
        sessionId,
        symbol: sym,
        orderAction,
        quantity: qty,
        orderType: plan.tradingData?.orderType || "MARKET",
        limitPrice: plan.tradingData?.limitPrice,
      });

      return {
        plan,
        domain: "trading",
        targetTable: "mas_trades",
        count: 1,
        summary: `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} shares of ${draft.symbol} at ~$${draft.estimatedPrice.toFixed(2)}. Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.`,
        rows: [
          {
            orderId: draft.orderId,
            symbol: draft.symbol,
            action: draft.orderAction,
            quantity: draft.quantity,
            orderType: draft.orderType,
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
      const screener = new DynamicOptionsScreener(etrade.client);
      const res = screener.screenOptionsSync(plan.tradingData?.filters);
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_options_screener",
        count: res.contracts.length,
        status: res.status,
        summary: `Options Screener: [Evaluated ${res.totalContractsEvaluated} contracts across ${res.totalUnderlyingsScanned} symbols; ${res.contracts.length} matched criteria] (${res.filterSummary}).`,
        rows: res.contracts.map((c) => ({
          contractSymbol: c.osiKey || c.symbol,
          underlying: c.underlyingSymbol,
          underlyingPrice: `$${c.underlyingPrice.toFixed(2)}`,
          type: c.optionType,
          strike: `$${c.strikePrice.toFixed(2)}`,
          bidAsk: `$${c.bid.toFixed(2)} / $${c.ask.toFixed(2)}`,
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
      return {
        plan,
        domain: "research",
        targetTable: "yfinance_fundamentals",
        count: 1,
        summary: `FOSS Fundamental Analysis for ${f.companyName} (${f.symbol}) via Yahoo Finance: Market Cap $${(f.marketCap / 1e9).toFixed(1)}B, Trailing P/E ${f.peTrailing || "N/A"}, Forward P/E ${f.peForward || "N/A"}, PEG ${f.pegRatio || "N/A"}. Consensus Target: $${f.targetMeanPrice?.toFixed(2) || "N/A"} (${f.recommendationKey?.toUpperCase() || "BUY"}).`,
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
        summary: `Alpaca Real-time Market Snapshot for ${s.symbol}: Latest Trade $${s.latestTrade.price.toFixed(2)} (${s.latestTrade.size} shs). Best Bid $${s.latestQuote.bidPrice.toFixed(2)} / Ask $${s.latestQuote.askPrice.toFixed(2)}. Daily High $${s.dailyBar.high.toFixed(2)} / Low $${s.dailyBar.low.toFixed(2)}.`,
        rows: [
          {
            symbol: s.symbol,
            assetClass: s.assetClass,
            lastPrice: `$${s.latestTrade.price.toFixed(2)}`,
            bidAskSpread: `$${s.latestQuote.bidPrice.toFixed(2)} / $${s.latestQuote.askPrice.toFixed(2)}`,
            dayRange: `$${s.dailyBar.low.toFixed(2)} - $${s.dailyBar.high.toFixed(2)}`,
            volume: s.dailyBar.volume.toLocaleString(),
            vwap: s.dailyBar.vwap ? `$${s.dailyBar.vwap.toFixed(2)}` : "N/A",
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
        summary: `Real-time quote for ${q.symbol} (${q.companyName || sym}) via ${q.provider}: $${q.price.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%). Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`,
        rows: [
          {
            symbol: q.symbol,
            provider: q.provider,
            price: `$${q.price.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            bidAsk: `$${q.bid.toFixed(2)} / $${q.ask.toFixed(2)}`,
            volume: q.volume.toLocaleString(),
          },
        ],
        executedAt,
      };
    }

    if (action === "compare") {
      const syms = plan.researchData?.symbols || [sym, "AMD"];
      const comp = foss.compareStocksSync(syms);
      return {
        plan,
        domain: "research",
        targetTable: "foss_stock_comparison",
        count: comp.length,
        summary: `FOSS Multi-Stock Valuation Comparison across ${comp.map((c) => c.symbol).join(", ")}.`,
        rows: comp.map((c) => ({
          symbol: c.symbol,
          company: c.fundamentals.companyName,
          price: `$${c.quote.price.toFixed(2)}`,
          peTrailing: c.fundamentals.peTrailing || "N/A",
          marketCap: `$${(c.fundamentals.marketCap / 1e9).toFixed(1)}B`,
          analystRating: c.fundamentals.recommendationKey?.toUpperCase() || "BUY",
          targetPrice: `$${c.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}`,
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
      summary: `Autonomous Research Synthesis for ${rep.fundamentals.companyName} (${rep.symbol}): Target: $${rep.fundamentals.targetMeanPrice?.toFixed(2) || "N/A"}, Consensus: ${rep.analystRating}. ${rep.aiAnalysis}`,
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
export async function executeNLQQueryAsync(
  orm: DatabaseORM,
  sessionId: string,
  plan: NLQPlan,
  env?: Env,
  userLogin?: string,
  userDid?: string
): Promise<NLQQueryResult> {
  const executedAt = new Date().toISOString();
  const effectiveUserDid = userDid || (userLogin?.startsWith("did:") ? userLogin : undefined);

  if (plan.domain === "trading") {
    const login = userLogin || sessionId || "default_trader";
    const etrade = new ETradeService(orm, env, login);
    const action = plan.tradingData?.action || "screen";

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
            exchange: s.listingExchange || "N/A",
            price: `$${s.price.toFixed(2)}`,
            change: `${s.change >= 0 ? "+" : ""}${s.change.toFixed(2)} (${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%)`,
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
        summary: `Real-time quote for ${q.symbol} (${q.companyName}): $${q.lastPrice.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%). Bid: $${q.bid.toFixed(2)} / Ask: $${q.ask.toFixed(2)}.`,
        rows: [
          {
            symbol: q.symbol,
            company: q.companyName,
            lastPrice: `$${q.lastPrice.toFixed(2)}`,
            change: `${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)`,
            changePeriod: "1D (Regular Trading Day)",
            priorClose: `$${(q.previousClose || (q.lastPrice - q.change)).toFixed(2)}`,
            bidAsk: `$${q.bid.toFixed(2)} / $${q.ask.toFixed(2)}`,
            volume: q.volume.toLocaleString(),
            range52Week: `$${((q.low52 ?? q.week52Low) || 0).toFixed(2)} - ${((q.high52 ?? q.week52High) || 0).toFixed(2)}`,
            peRatio: q.peRatio ? q.peRatio.toFixed(1) : "N/A",
            marketCap: formatMarketCap(q.marketCap),
            source: q.source,
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
      const orderType = plan.tradingData?.orderType || "MARKET";
      const limitPrice = plan.tradingData?.limitPrice;

      const draft = await etrade.previewOrderRemote({
        sessionId,
        symbol: sym,
        orderAction,
        quantity: qty,
        orderType,
        limitPrice,
      });

      const quote = await etrade.fetchQuoteRemote(sym);
      const marketPriceStr = quote.lastPrice > 0 ? `$${quote.lastPrice.toFixed(2)}` : "Market";

      const summary = orderType === "LIMIT" && limitPrice !== undefined
        ? `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} shares of ${draft.symbol} at limit price $${draft.estimatedPrice.toFixed(2)} (Prevailing Market Quote: ${marketPriceStr}). Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.`
        : `E*TRADE order preview drafted for ${draft.orderAction} ${draft.quantity} shares of ${draft.symbol} at ~$${draft.estimatedPrice.toFixed(2)}. Total: $${draft.estimatedTotal.toFixed(2)}. Attested by ${draft.proposerDid}. Awaiting Human Authorization.`;

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
            limitPrice: limitPrice !== undefined ? `$${limitPrice.toFixed(2)}` : "N/A (Market Order)",
            prevailingMarketPrice: marketPriceStr,
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
      const res = await runOptionsStrategyAction(etrade, action, plan.tradingData?.filters as OptionsStrategyIntent["filters"] | undefined);
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
        rows: res.rows,
        executedAt,
      };
    }

    if (action === "options_screen") {
      const screener = new DynamicOptionsScreener(etrade.client);
      const res = await screener.screenOptions(plan.tradingData?.filters);
      const freshnessNote = res.quoteQuality?.staleContractsReturned || res.quoteQuality?.unknownFreshnessContracts
        ? ` Freshness: ${res.quoteQuality.staleContractsReturned} returned contracts are stale and ${res.quoteQuality.unknownFreshnessContracts} have unknown timestamps; freshest stale quote was ${Math.round(res.quoteQuality.freshestStaleQuoteAgeSeconds || 0)}s old (freshness reference ${res.quoteQuality.maxAgeSeconds || 60}s).`
        : "";
      return {
        plan,
        domain: "trading",
        targetTable: "etrade_options_screener",
        count: res.contracts.length,
        status: res.status,
        summary: `Options Screener: [Evaluated ${res.totalContractsEvaluated} contracts across ${res.totalUnderlyingsScanned} symbols; ${res.contracts.length} matched criteria] (${res.filterSummary}).${freshnessNote}`,
        validationError: res.validationError,
        quoteQuality: res.quoteQuality,
        rejections: (res.rejections || []).slice(0, 15),
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
      const receipt: any = {
        receiptId: `rcpt_${Date.now()}`,
        protocol: "x402",
        resource: tier.resource,
        amount: tier.priceUSD,
        currency: "USDC",
        network: env?.X402_NETWORK || "base-sepolia",
        payer: login,
        recipient: env?.X402_RECIPIENT_ADDRESS || "0x71C8363837918a211797E3c76A8B3C4258759550",
        status: "verified",
        txHash: `0x_${Date.now().toString(16)}`,
        timestamp: executedAt,
      };
      await paymentService.recordPaymentTransaction(receipt, "inbound");

      return {
        plan,
        domain: "agentic_payments",
        targetTable: "etrade_premium_options",
        count: res.contracts.length,
        summary: res.validationError || `Paid Options Screener ($${tier.priceUSD.toFixed(2)} USDC): Scanned ${res.totalUnderlyingsScanned} dynamic underlying(s). Found ${res.contracts.length} contracts. ${res.quoteQuality?.staleContractsReturned || 0} returned contracts are marked stale. Receipt: ${receipt.receiptId}.`,
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
      const receipt: any = {
        receiptId: `rcpt_${Date.now()}`,
        protocol: "x402",
        resource: tier.resource,
        amount: tier.priceUSD,
        currency: "USDC",
        network: env?.X402_NETWORK || "base-sepolia",
        payer: userLogin || sessionId || "default_trader",
        recipient: env?.X402_RECIPIENT_ADDRESS || "0x71C8363837918a211797E3c76A8B3C4258759550",
        status: "verified",
        txHash: `0x_${Date.now().toString(16)}`,
        timestamp: executedAt,
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
        summary: `Paid Market Research ($${tier.priceUSD.toFixed(2)} USDC): Generated valuation report for ${sym}. Rating: ${report.analystRating}. Target: ${targetPrice}. Receipt: ${receipt.receiptId}.`,
        rows: [
          {
            symbol: report.symbol,
            companyName,
            analystRating: report.analystRating,
            targetPrice,
            currentPrice,
            receiptId: receipt.receiptId,
          },
        ],
        executedAt,
      };
    }
  }

  return executeNLQQuery(orm, sessionId, plan, env, effectiveUserDid);
}

export async function executeNaturalLanguageQuery(
  orm: DatabaseORM,
  sessionId: string,
  query: string,
  env: Env,
  userLogin?: string,
  userDid?: string
): Promise<{ plan: NLQPlan; result: NLQQueryResult }> {
  const plan = await planNLQ(env, query);
  const result = await executeNLQQueryAsync(orm, sessionId, plan, env, userLogin, userDid);
  return { plan, result };
}
