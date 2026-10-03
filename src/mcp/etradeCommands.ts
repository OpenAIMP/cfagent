/**
 * GoF Command Pattern: E*TRADE Trading & Screening MCP Tools
 *
 * Implements:
 * - GoF Command Pattern: IMcpToolCommand encapsulation for each trading capability.
 * - Human-in-the-Loop (HITL) Order Safety with Agent DID attestation.
 * - Multi-turn agent dogfooding for stock scanning, quote inspection, and order placement.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import { ETradeService } from "../services/etrade";
import { getUserDid } from "../agents/did";

/**
 * 1. E*TRADE Market Scan & Screener Command
 */
export class ETradeMarketScanCommand implements IMcpToolCommand<{
  exchange?: "ALL" | "NASDAQ" | "NYSE" | "AMEX";
  minPrice?: number;
  maxPrice?: number;
  minMarketCap?: number;
  gainersOnly?: boolean;
  losersOnly?: boolean;
  search?: string;
  limit?: number;
}> {
  readonly name = "etrade_market_scan";
  readonly description = "Screen all current Nasdaq, NYSE, and AMEX listings using price, exchange, market cap, daily change, and ticker/company search filters.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      exchange: { type: "string", enum: ["ALL", "NASDAQ", "NYSE", "AMEX"], description: "Listing exchange; defaults to all three" },
      minPrice: { type: "number", description: "Minimum last-sale price in USD" },
      maxPrice: { type: "number", description: "Maximum last-sale price in USD" },
      minMarketCap: { type: "number", description: "Minimum market capitalization in billions of USD" },
      gainersOnly: { type: "boolean", description: "Only listings with positive daily change" },
      losersOnly: { type: "boolean", description: "Only listings with negative daily change" },
      search: { type: "string", description: "Search term or keyword to match symbol or company name" },
      limit: { type: "number", description: "Maximum rows to return; omit to return all matches" },
    },
  };
  readonly zodSchema = z.object({
    exchange: z.enum(["ALL", "NASDAQ", "NYSE", "AMEX"]).optional().describe("Listing exchange"),
    minPrice: z.number().nonnegative().optional().describe("Minimum last-sale price"),
    maxPrice: z.number().positive().optional().describe("Maximum last-sale price"),
    minMarketCap: z.number().nonnegative().optional().describe("Minimum market cap in billions"),
    gainersOnly: z.boolean().optional().describe("Only positive daily change"),
    losersOnly: z.boolean().optional().describe("Only negative daily change"),
    search: z.string().optional().describe("Ticker or company name search"),
    limit: z.number().int().positive().optional().describe("Maximum rows to return; omitted means all matches"),
  });

  async execute(input: any, context: McpToolContext) {
    const etrade = new ETradeService(context.orm, context.env);
    const result = await etrade.screenMarketsAsync(input);

    context.audit("etrade.market_scanned", "trading", {
      matchedCount: result.matchedCount,
      exchange: input.exchange,
      minPrice: input.minPrice,
      maxPrice: input.maxPrice,
    });

    return result;
  }
}

/**
 * 2. E*TRADE Get Quote Command
 */
export class ETradeGetQuoteCommand implements IMcpToolCommand<{ symbol: string }> {
  readonly name = "etrade_get_quote";
  readonly description = "Fetch a live market quote, bid/ask depth, daily and average volume, valuation fields, and 52-week range for an equity ticker.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The stock ticker symbol (e.g. NVDA, AAPL, MSFT, TSLA, PLTR)" },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(10).describe("Stock ticker symbol (e.g. NVDA, AAPL, TSLA)"),
  });

  async execute(input: { symbol: string }, context: McpToolContext) {
    const symbol = input.symbol.trim().toUpperCase();
    const etrade = new ETradeService(context.orm, context.env);
    const quote = await etrade.getQuoteAsync(symbol);

    context.audit("etrade.quote_fetched", "trading", {
      symbol: quote.symbol,
      lastPrice: quote.lastPrice,
      changePercent: quote.changePercent,
    });

    return quote;
  }
}

/**
 * 3. E*TRADE Preview Order Command (Draft with Agent DID Stamp)
 */
export class ETradePreviewOrderCommand implements IMcpToolCommand<{
  symbol: string;
  action: "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP" | "STOP_LIMIT";
  limitPrice?: number;
  notes?: string;
}> {
  readonly name = "etrade_preview_order";
  readonly description = "Preview an E*TRADE equity order draft (BUY, SELL, BUY_TO_COVER, SELL_SHORT) with Agent Decentralized Identifier (DID) cryptographic attestation. Safety guarantee: NO SHARES ARE BOUGHT OR SOLD. Awaiting human confirmation.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, PLTR)" },
      action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"], description: "Order action" },
      quantity: { type: "number", description: "Number of shares to trade" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"], description: "Execution order type (default: MARKET)" },
      limitPrice: { type: "number", description: "Limit price for limit orders" },
      notes: { type: "string", description: "Optional trade notes or strategy rationale" },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("Stock ticker symbol"),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).describe("Order action"),
    quantity: z.number().positive().describe("Number of shares"),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional().default("MARKET").describe("Order type"),
    limitPrice: z.number().optional().describe("Limit price"),
    notes: z.string().optional().describe("Trade notes"),
  });

  async execute(input: any, context: McpToolContext) {
    const etrade = new ETradeService(context.orm, context.env);
    const draft = etrade.previewOrder({
      symbol: input.symbol,
      action: input.action || input.orderAction,
      orderAction: input.orderAction || input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      sessionId: context.sessionId,
      notes: input.notes,
    });

    context.audit("etrade.order_previewed", "trading", {
      orderId: draft.orderId,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      estimatedTotal: draft.estimatedTotal,
      proposerDid: draft.proposerDid,
    });

    return {
      orderId: draft.orderId,
      status: "previewed",
      requiresConfirmation: true,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      orderType: draft.orderType,
      limitPrice: draft.limitPrice,
      estimatedTotal: draft.estimatedTotal,
      estimatedCommission: draft.estimatedCommission,
      proposerDid: draft.proposerDid,
      authorizerDid: draft.authorizerDid,
      proofSignature: draft.proofSignature,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      securityGuarantee: "NO MONEY HAS BEEN MOVED & NO SHARES TRADED. Stamped with Agent DID. Requires human confirmation via etrade_execute_order.",
      previewMessage: draft.previewMessage,
    };
  }
}

/**
 * 4. E*TRADE Execute Order Command (Human-In-The-Loop Confirmation)
 */
export class ETradeExecuteOrderCommand implements IMcpToolCommand<{
  orderId: string;
  decision: "approved" | "rejected";
  note?: string;
}> {
  readonly name = "etrade_execute_order";
  readonly description = "Authorize and execute a previously previewed E*TRADE order draft (etrade_ord_xxxx) using explicit Human-in-the-Loop confirmation with authorizer DID verification.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      orderId: { type: "string", description: "The unique order preview ID (e.g. etrade_ord_12345)" },
      decision: { type: "string", enum: ["approved", "rejected"], description: "Human authorization decision" },
      note: { type: "string", description: "Optional review note or execution rationale" },
    },
    required: ["orderId", "decision"],
  };
  readonly zodSchema = z.object({
    orderId: z.string().describe("Order draft ID (etrade_ord_xxxx)"),
    decision: z.enum(["approved", "rejected"]).describe("Human confirmation decision"),
    note: z.string().optional().describe("Review note"),
  });

  async execute(input: { orderId: string; decision: "approved" | "rejected"; note?: string }, context: McpToolContext) {
    const { orderId, decision, note } = input;
    const etrade = new ETradeService(context.orm, context.env);
    const result = etrade.executeOrder(orderId, context.sessionId, decision);

    context.audit(decision === "approved" ? "etrade.order_executed" : "etrade.order_rejected", "trading", {
      orderId,
      decision,
      status: result.status,
      executionId: result.executionId,
      note,
    });

    return result;
  }
}

/**
 * 5. E*TRADE Get Positions & Account Balance Command
 */
export class ETradeGetPositionsCommand implements IMcpToolCommand<{}> {
  readonly name = "etrade_get_positions";
  readonly description = "Query open E*TRADE brokerage account balances, purchasing power, active stock positions, and unrealized profit/loss metrics.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const etrade = new ETradeService(context.orm, context.env);
    const { account, positions } = await etrade.fetchPortfolioRemote();
    const accounts = await etrade.fetchAccountsRemote();

    return {
      account,
      accounts,
      positions,
      totalPortfolioValue: account.totalAccountValue,
      totalCash: account.cashAvailableForInvestment,
      positionsCount: positions.length,
      asOf: new Date().toISOString(),
    };
  }
}

/**
 * 6. E*TRADE Authentication Status Command (Agentic Token Guardian)
 */
export class ETradeAuthStatusCommand implements IMcpToolCommand<{}> {
  readonly name = "etrade_auth_status";
  readonly description = "Check E*TRADE 3-legged OAuth 1.0a authentication status, midnight ET expiration cutoff, token renewal eligibility, and active environment (TEST/PROD).";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const etrade = new ETradeService(context.orm, context.env, context.sessionId);
    const status = await etrade.getStatusAsync();
    return status;
  }
}

/**
 * 7. E*TRADE Account Discovery Command
 */
export class ETradeAccountDiscoveryCommand implements IMcpToolCommand<{}> {
  readonly name = "etrade_account_discovery";
  readonly description = "Discover and inspect active E*TRADE brokerage accounts by dynamically calling GET /v1/accounts/list to resolve authentic accountIdKey values.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const etrade = new ETradeService(context.orm, context.env, context.sessionId);
    const accounts = await etrade.fetchAccountsRemote();
    return {
      count: accounts.length,
      accounts,
      asOf: new Date().toISOString(),
    };
  }
}

