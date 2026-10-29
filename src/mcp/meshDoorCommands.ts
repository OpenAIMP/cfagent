/**
 * Issue #2341 (Agent Mesh S5, programme #2225 G1 batch A) — the
 * chat-turn commands over the mesh doors.
 *
 * Four thin commands, registered in McpToolFactory alongside (never
 * instead of) the existing catalog, each declaring exactly one
 * scope in MCP_TOOL_SCOPES (#1744):
 *   - `list_scheduled_goals`  (mcp:read)     — list/inspect the
 *     scheduled-goal catalogue through the ScheduledAgent door.
 *   - `trigger_scheduled_goal` (mcp:write)   — trigger one goal;
 *     the returned tick is the agent's real outcome.
 *   - `check_payment_budget`  (mcp:payments) — PaymentsAgent budget
 *     verdict for a proposed spend, against the orchestrator bucket.
 *   - `get_payments_overview` (mcp:payments) — today's spend +
 *     recent payments, read through PaymentsAgent.
 *
 * The commands are thin by design (doors-and-layers §11.1): resolve
 * identity -> gate -> dispatch. Identity comes ONLY from the tool
 * context's actingLogin carrier — populated server-side by the
 * chat-turn context owner and threaded through the async-job path —
 * never from tool arguments (a caller-supplied login argument would
 * be a forgery surface, and the schemas deliberately carry none).
 * Without an identified chat turn the door refuses (fail-closed);
 * external MCP callers reach these agents through the A2A doors
 * (#2223) instead. All behavior lives in the door module
 * (src/agents/orchestrator/meshDoors.ts); these classes validate
 * input shape, dispatch, and audit.
 *
 * Batch B (#2349) adds seven commands over the TradingAgent and
 * ReportAssetAgent doors, each also declaring exactly one scope:
 *   - `propose_stock_trade`   (mcp:trade) — create a stock trade
 *     proposal (preview only; the result is a pending-approval
 *     proposal, never a placed order).
 *   - `propose_options_trade` (mcp:trade) — create an options
 *     trade proposal (preview only).
 *   - `get_trading_accounts`  (mcp:read)  — the acting user's
 *     broker accounts through TradingAgent.
 *   - `get_trading_positions` (mcp:read)  — their positions.
 *   - `get_trading_quote`     (mcp:read)  — a symbol quote.
 *   - `list_report_assets`    (mcp:read)  — the acting user's
 *     report assets (metadata) through ReportAssetAgent.
 *   - `get_report_asset`      (mcp:read)  — one asset by key.
 * No command reaches TradingAgent's approval door: there is no
 * execute/approve/decide command in this family, by design — order
 * execution stays behind the existing approval door until S9/G4.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import {
  listScheduledGoalsViaDoor,
  triggerScheduledGoalViaDoor,
  checkPaymentBudgetViaDoor,
  getPaymentsOverviewViaDoor,
  proposeStockTradeViaDoor,
  proposeOptionsTradeViaDoor,
  getTradingAccountsViaDoor,
  getTradingPositionsViaDoor,
  getTradingQuoteViaDoor,
  listReportAssetsViaDoor,
  getReportAssetViaDoor,
  type ScheduledGoalsDoorResult,
  type ScheduledGoalTriggerDoorResult,
  type PaymentBudgetDoorResult,
  type PaymentsOverviewDoorResult,
  type TradeProposalDoorResult,
  type StockTradeProposalInput,
  type OptionsTradeProposalInput,
  type ReportAssetsDoorResult,
  type ReportAssetDoorResult,
} from "../agents/orchestrator/meshDoors";

/* ------------------------------------------------------------------ */
/* list_scheduled_goals                                                */
/* ------------------------------------------------------------------ */

export class ListScheduledGoalsCommand implements IMcpToolCommand<{
  goalId?: string;
}> {
  readonly name = "list_scheduled_goals";
  readonly description =
    "List the scheduled-goal catalogue through the ScheduledAgent door, or inspect one goal when goalId is given. Read-only. Requires the chat turn's acting identity; the catalogue is the shared operator catalogue the schedule routes expose to any signed-in user.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goalId: {
        type: "string",
        description: "Optional: return only the goal with this id (an unknown id is an error, not an empty list).",
      },
    },
  };
  readonly zodSchema = z.object({
    goalId: z.string().min(1).optional().describe("Optional goal id to inspect"),
  });

  async execute(
    input: { goalId?: string },
    context: McpToolContext,
  ): Promise<ScheduledGoalsDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await listScheduledGoalsViaDoor(context.env, actingLogin, input.goalId);
    context.audit("list_scheduled_goals", "mcp", {
      actingLogin: actingLogin ?? null,
      goalId: input.goalId ?? null,
      count: result.goals.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* trigger_scheduled_goal                                              */
/* ------------------------------------------------------------------ */

export class TriggerScheduledGoalCommand implements IMcpToolCommand<{
  goalId: string;
}> {
  readonly name = "trigger_scheduled_goal";
  readonly description =
    "Trigger one scheduled goal now through the ScheduledAgent door. Returns the agent's real tick outcome (jobs created/skipped, errors) — a budget-denied firing is reported in the tick, never as success. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      goalId: {
        type: "string",
        description: "The id of the scheduled goal to trigger.",
      },
    },
    required: ["goalId"],
  };
  readonly zodSchema = z.object({
    goalId: z.string().min(1).describe("The scheduled goal id"),
  });

  async execute(
    input: { goalId: string },
    context: McpToolContext,
  ): Promise<ScheduledGoalTriggerDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await triggerScheduledGoalViaDoor(context.env, actingLogin, input.goalId);
    context.audit("trigger_scheduled_goal", "mcp", {
      actingLogin: actingLogin ?? null,
      goalId: input.goalId,
      jobsCreated: result.tick.jobsCreated,
      jobsSkipped: result.tick.jobsSkipped,
      errors: result.tick.errors.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* check_payment_budget                                                */
/* ------------------------------------------------------------------ */

export class CheckPaymentBudgetCommand implements IMcpToolCommand<{
  operation: string;
  amountCents: number;
}> {
  readonly name = "check_payment_budget";
  readonly description =
    "Ask PaymentsAgent whether a proposed spend is within budget: evaluates the BudgetGuard against the orchestrator spend bucket (the bucket chat-executed spend is attributed to in the ledger). A check records nothing. The verdict, including a denial's reason, is the guard's own. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      operation: {
        type: "string",
        description: "The budget-guarded operation name (must be on the guard allowlist, e.g. search.query, nlq.execute).",
      },
      amountCents: {
        type: "number",
        description: "The proposed spend, in cents (positive integer).",
      },
    },
    required: ["operation", "amountCents"],
  };
  readonly zodSchema = z.object({
    operation: z.string().min(1).describe("The budget-guarded operation name"),
    amountCents: z.number().int().positive().describe("The proposed spend, in cents"),
  });

  async execute(
    input: { operation: string; amountCents: number },
    context: McpToolContext,
  ): Promise<PaymentBudgetDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await checkPaymentBudgetViaDoor(context.env, actingLogin, input);
    context.audit("check_payment_budget", "mcp", {
      actingLogin: actingLogin ?? null,
      operation: input.operation,
      amountCents: input.amountCents,
      agentId: result.agentId,
      allowed: result.allowed,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_payments_overview                                               */
/* ------------------------------------------------------------------ */

export class GetPaymentsOverviewCommand implements IMcpToolCommand<{
  limit?: number;
}> {
  readonly name = "get_payments_overview";
  readonly description =
    "Read the payments overview through PaymentsAgent: total spent today (cents) and the most recent payments from the ledger of record. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "How many recent payments to include (default 10).",
      },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().int().positive().max(50).optional().describe("Recent payments to include (default 10)"),
  });

  async execute(
    input: { limit?: number },
    context: McpToolContext,
  ): Promise<PaymentsOverviewDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await getPaymentsOverviewViaDoor(context.env, actingLogin, input.limit);
    context.audit("get_payments_overview", "mcp", {
      actingLogin: actingLogin ?? null,
      todaySpentCents: result.todaySpentCents,
      count: result.recentPayments.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* propose_stock_trade (#2349)                                         */
/* ------------------------------------------------------------------ */

const tradeActionSchema = z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]);
const tradeOrderTypeSchema = z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]);

export class ProposeStockTradeCommand implements IMcpToolCommand<StockTradeProposalInput> {
  readonly name = "propose_stock_trade";
  readonly description =
    "Create a stock trade PROPOSAL through the TradingAgent door: the broker preview for the acting user's own account, returned as a pending-approval proposal. Preview only — this command never places an order; placement happens only through TradingAgent's approval door with an explicit authorizer decision. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The stock symbol, e.g. AAPL." },
      action: { type: "string", description: "BUY, SELL, BUY_TO_COVER, or SELL_SHORT." },
      quantity: { type: "number", description: "Share quantity (positive)." },
      orderType: { type: "string", description: "MARKET, LIMIT, STOP, or STOP_LIMIT (optional)." },
      limitPrice: { type: "number", description: "Limit price for LIMIT/STOP_LIMIT orders (optional)." },
      stopPrice: { type: "number", description: "Stop price for STOP/STOP_LIMIT orders (optional)." },
      provider: { type: "string", description: "Broker provider id (optional; the agent's default otherwise)." },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("The stock symbol"),
    action: tradeActionSchema.describe("BUY, SELL, BUY_TO_COVER, or SELL_SHORT"),
    quantity: z.number().positive().describe("Share quantity"),
    orderType: tradeOrderTypeSchema.optional().describe("Order type (optional)"),
    limitPrice: z.number().positive().optional().describe("Limit price (optional)"),
    stopPrice: z.number().positive().optional().describe("Stop price (optional)"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: StockTradeProposalInput,
    context: McpToolContext,
  ): Promise<TradeProposalDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await proposeStockTradeViaDoor(context.env, actingLogin, input);
    context.audit("propose_stock_trade", "mcp", {
      actingLogin: actingLogin ?? null,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      status: result.status,
      orderId: result.proposal?.orderId ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* propose_options_trade (#2349)                                       */
/* ------------------------------------------------------------------ */

const optionLegSchema = z.object({
  underlyingSymbol: z.string().min(1).describe("The leg's underlying symbol"),
  securityType: z.literal("OPTN").describe("Leg security type (OPTN)"),
  side: z.enum(["BUY", "SELL"]).describe("Leg side"),
  quantity: z.number().positive().describe("Leg quantity"),
  optionType: z.enum(["CALL", "PUT"]).optional().describe("CALL or PUT (optional)"),
  strike: z.number().positive().optional().describe("Strike price (optional)"),
  expirationDate: z.string().optional().describe("Expiration date (optional)"),
});

export class ProposeOptionsTradeCommand implements IMcpToolCommand<OptionsTradeProposalInput> {
  readonly name = "propose_options_trade";
  readonly description =
    "Create an options trade PROPOSAL through the TradingAgent door: single-leg or multi-leg (spreads) via optionLegs, priced from the strategy net debit when given. Returns the broker preview as a pending-approval proposal. Preview only — this command never places an order; placement happens only through TradingAgent's approval door with an explicit authorizer decision. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The underlying symbol, e.g. AAPL." },
      action: { type: "string", description: "BUY, SELL, BUY_TO_COVER, or SELL_SHORT." },
      quantity: { type: "number", description: "Contract quantity (positive)." },
      optionLegs: {
        type: "array",
        description: "The option legs (at least one): underlyingSymbol, securityType OPTN, side, quantity, and optionally optionType, strike, expirationDate.",
      },
      orderType: { type: "string", description: "MARKET, LIMIT, STOP, or STOP_LIMIT (optional)." },
      limitPrice: { type: "number", description: "Limit price (optional)." },
      stopPrice: { type: "number", description: "Stop price (optional)." },
      strategyNetDebit: { type: "number", description: "Strategy net debit for spreads (optional)." },
      provider: { type: "string", description: "Broker provider id (optional)." },
    },
    required: ["symbol", "action", "quantity", "optionLegs"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("The underlying symbol"),
    action: tradeActionSchema.describe("BUY, SELL, BUY_TO_COVER, or SELL_SHORT"),
    quantity: z.number().positive().describe("Contract quantity"),
    optionLegs: z.array(optionLegSchema).min(1).describe("The option legs (at least one)"),
    orderType: tradeOrderTypeSchema.optional().describe("Order type (optional)"),
    limitPrice: z.number().positive().optional().describe("Limit price (optional)"),
    stopPrice: z.number().positive().optional().describe("Stop price (optional)"),
    strategyNetDebit: z.number().optional().describe("Strategy net debit (optional)"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: OptionsTradeProposalInput,
    context: McpToolContext,
  ): Promise<TradeProposalDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await proposeOptionsTradeViaDoor(context.env, actingLogin, input);
    context.audit("propose_options_trade", "mcp", {
      actingLogin: actingLogin ?? null,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      legs: input.optionLegs.length,
      status: result.status,
      orderId: result.proposal?.orderId ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trading_accounts (#2349)                                        */
/* ------------------------------------------------------------------ */

export class GetTradingAccountsCommand implements IMcpToolCommand<{ provider?: string }> {
  readonly name = "get_trading_accounts";
  readonly description =
    "Read the acting user's broker accounts through their own TradingAgent instance. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      provider: { type: "string", description: "Broker provider id (optional; the agent's default otherwise)." },
    },
  };
  readonly zodSchema = z.object({
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(input: { provider?: string }, context: McpToolContext): Promise<unknown> {
    const actingLogin = context.actingLogin?.();
    const result = await getTradingAccountsViaDoor(context.env, actingLogin, input.provider);
    context.audit("get_trading_accounts", "mcp", {
      actingLogin: actingLogin ?? null,
      provider: input.provider ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trading_positions (#2349)                                       */
/* ------------------------------------------------------------------ */

export class GetTradingPositionsCommand implements IMcpToolCommand<{
  accountKey?: string;
  provider?: string;
}> {
  readonly name = "get_trading_positions";
  readonly description =
    "Read the acting user's broker positions through their own TradingAgent instance, optionally for one account. Read-only — this is the broker's live view. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      accountKey: { type: "string", description: "Account key to read positions for (optional)." },
      provider: { type: "string", description: "Broker provider id (optional)." },
    },
  };
  readonly zodSchema = z.object({
    accountKey: z.string().min(1).optional().describe("Account key (optional)"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: { accountKey?: string; provider?: string },
    context: McpToolContext,
  ): Promise<unknown> {
    const actingLogin = context.actingLogin?.();
    const result = await getTradingPositionsViaDoor(context.env, actingLogin, input);
    context.audit("get_trading_positions", "mcp", {
      actingLogin: actingLogin ?? null,
      accountKey: input.accountKey ?? null,
      provider: input.provider ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_trading_quote (#2349)                                           */
/* ------------------------------------------------------------------ */

export class GetTradingQuoteCommand implements IMcpToolCommand<{
  symbol: string;
  provider?: string;
}> {
  readonly name = "get_trading_quote";
  readonly description =
    "Read a quote for one symbol through the acting user's own TradingAgent instance. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "The symbol to quote, e.g. AAPL." },
      provider: { type: "string", description: "Broker provider id (optional)." },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("The symbol to quote"),
    provider: z.string().min(1).optional().describe("Broker provider id (optional)"),
  });

  async execute(
    input: { symbol: string; provider?: string },
    context: McpToolContext,
  ): Promise<unknown> {
    const actingLogin = context.actingLogin?.();
    const result = await getTradingQuoteViaDoor(context.env, actingLogin, input);
    context.audit("get_trading_quote", "mcp", {
      actingLogin: actingLogin ?? null,
      symbol: input.symbol,
      provider: input.provider ?? null,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* list_report_assets (#2349)                                          */
/* ------------------------------------------------------------------ */

export class ListReportAssetsCommand implements IMcpToolCommand<{ limit?: number }> {
  readonly name = "list_report_assets";
  readonly description =
    "List the acting user's report assets through their own ReportAssetAgent instance: storage key, file name, and stored-at for each generated report PDF, newest first. Metadata only — no asset bytes. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "How many assets to list (default 20, max 200)." },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().int().positive().max(200).optional().describe("Assets to list (default 20)"),
  });

  async execute(
    input: { limit?: number },
    context: McpToolContext,
  ): Promise<ReportAssetsDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await listReportAssetsViaDoor(context.env, actingLogin, input.limit);
    context.audit("list_report_assets", "mcp", {
      actingLogin: actingLogin ?? null,
      count: result.assets.length,
    });
    return result;
  }
}

/* ------------------------------------------------------------------ */
/* get_report_asset (#2349)                                            */
/* ------------------------------------------------------------------ */

export class GetReportAssetCommand implements IMcpToolCommand<{ key: string }> {
  readonly name = "get_report_asset";
  readonly description =
    "Fetch one of the acting user's report assets by its storage key through their own ReportAssetAgent instance. Returns the file name, byte length, and the asset bytes base64-encoded (the shape the report-asset A2A door uses). An unknown key is an error, not an empty result. Read-only. Requires the chat turn's acting identity.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      key: { type: "string", description: "The asset's storage key (from list_report_assets)." },
    },
    required: ["key"],
  };
  readonly zodSchema = z.object({
    key: z.string().min(1).describe("The asset's storage key"),
  });

  async execute(
    input: { key: string },
    context: McpToolContext,
  ): Promise<ReportAssetDoorResult> {
    const actingLogin = context.actingLogin?.();
    const result = await getReportAssetViaDoor(context.env, actingLogin, input.key);
    context.audit("get_report_asset", "mcp", {
      actingLogin: actingLogin ?? null,
      key: input.key,
      fileName: result.fileName,
      byteLength: result.byteLength,
    });
    return result;
  }
}
