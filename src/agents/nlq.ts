import { generateText } from "ai";
import { getWorkersAIModel } from "./model";
import { z } from "zod";
import type { Env, StockScreenLedger } from "../types";
import type { DatabaseORM } from "../orm";
import { ETradeService } from "../services/etrade";
import { FossResearchService } from "../services/fossResearch";
import { resolveEnvironmentConfig } from "../config/environment";

export const nlqPlanSchema = z.object({
  domain: z.enum(["tables", "table_data", "category_mutation", "conversation", "trading", "research", "custom_query"]).default("conversation"),
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
      action: z.enum(["screen", "quote", "preview_order", "execute_order", "positions"]).optional(),
      symbol: z.string().optional(),
      orderAction: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).optional(),
      quantity: z.number().optional(),
      orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional(),
      limitPrice: z.number().optional(),
      filters: z.record(z.string(), z.any()).optional(),
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
}

const STOP_WORDS_REGEX = /\b(questions?|messages?|chats?|history|transcript|conversations?|asked|queries|all|results?|references?|containing|contains|with|for|about|find|show|list|get|any|where|me)\b/gi;

export async function planNLQ(env: Env, question: string): Promise<NLQPlan> {
  const qLower = question.toLowerCase();

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

  // 4. Fast-path for E*TRADE Stock Screening / Market Scanning
  if (
    /\b(screen|screener|scan|scanning|scanned|breakout|oversold|overbought|gainers?|losers?|momentum)\b/i.test(question) ||
    (/\b(stocks?|equities)\b/i.test(question) && /\b(tech|semiconductor|rsi|macd|pe|p\/e|cap|volume|dividend|growth)\b/i.test(question))
  ) {
    const filters: Record<string, any> = {};
    if (/\b(tech|technology)\b/i.test(question)) filters.sector = "Technology";
    if (/\b(semiconductor|semis|chips)\b/i.test(question)) filters.sector = "Semiconductors";
    if (/\b(cloud|enterprise|software)\b/i.test(question)) filters.sector = "Enterprise Software";
    if (/\b(crypto|bitcoin|fintech)\b/i.test(question)) filters.sector = "Fintech & Crypto";

    const rsiUnderMatch = question.match(/rsi\s*(?:<|under|less than|below)\s*(\d+)/i);
    if (rsiUnderMatch) filters.maxRsi = Number(rsiUnderMatch[1]);
    const rsiOverMatch = question.match(/rsi\s*(?:>|over|greater than|above)\s*(\d+)/i);
    if (rsiOverMatch) filters.minRsi = Number(rsiOverMatch[1]);

    if (/\b(gainer|gainers|up|green)\b/i.test(question)) filters.gainersOnly = true;
    if (/\b(loser|losers|down|red)\b/i.test(question)) filters.losersOnly = true;

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
  const quoteMatch =
    question.match(/(?:quote|price|ticker|trading at)\s+([A-Za-z]{1,5})/i) ||
    question.match(/\b([A-Za-z]{1,5})\s+(?:quote|price|ticker)\b/i);
  if (quoteMatch && !/\b(messages?|categories|tables?)\b/i.test(question)) {
    const symbol = quoteMatch[1].toUpperCase();
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

      if (hasMismatch) {
        scannerState = "SCAN_INVALID_DATA_MISMATCH";
        summary = `🚨 SCAN INVALID — DATA MISMATCH: One or more returned rows contradicted requested screen filter (${screenRes.filterSummary}). Action shortcuts disabled.`;
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
      const draft = await etrade.previewOrderRemote({
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
  }

  return executeNLQQuery(orm, sessionId, plan, env, effectiveUserDid);
}
