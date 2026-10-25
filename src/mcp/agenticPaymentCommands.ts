/**
 * Cloudflare Agentic Payments MCP Tools (x402 & MPP paidTool patterns)
 * Implements paid MCP tools matching Cloudflare Agents SDK specification:
 * https://developers.cloudflare.com/agents/tools/payments/x402/charge-for-mcp-tools/
 */

import { z } from "zod";
import { optionScreenerFilterFields, parseOptionScreenerFilter } from "../trading";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../services/agenticPayments";
import { UnifiedOptionsService } from "../trading";
import { FossResearchService } from "../services/fossResearch";

/**
 * 1. Paid Options Screener Command ($0.05 USDC)
 */
export class PaidOptionsScreenerCommand implements IMcpToolCommand<{
  underlying?: string;
  maxUnderlyings?: number;
  contractType?: "CALL" | "PUT" | "BOTH";
  minDelta?: number;
  maxDelta?: number;
  minDte?: number;
  maxDte?: number;
  minVolume?: number;
  minOpenInterest?: number;
  maxSpreadPct?: number;
  maxQuoteAgeSeconds?: number;
  limit?: number;
  paymentSignature?: string;
}> {
  readonly name = "paid_options_screener";
  readonly description =
    "Screen live option chains with explicit DTE, Greeks, liquidity, spread, and quote-age inputs. Supply an underlying or a maximum-underlyings limit. Requires Cloudflare Agentic Payment ($0.05 USDC).";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      underlying: { type: "string", description: "Optional underlying ticker; omit to discover from current all-exchange listings" },
      maxUnderlyings: { type: "number", description: "Required for broad scans; maximum underlying symbols to query (clamped to 20)" },
      contractType: { type: "string", enum: ["CALL", "PUT", "BOTH"], description: "Optional option type; omitted screens both" },
      minDelta: { type: "number", description: "Minimum absolute delta (0.0 to 1.0)" },
      maxDelta: { type: "number", description: "Maximum absolute delta (0.0 to 1.0)" },
      minDte: { type: "number", description: "Minimum days to expiration" },
      maxDte: { type: "number", description: "Maximum days to expiration (defaults to 90 when no DTE bounds are supplied)" },
      minVolume: { type: "number", description: "Minimum daily contract volume" },
      minOpenInterest: { type: "number", description: "Minimum open interest" },
      maxSpreadPct: { type: "number", description: "Maximum bid/ask spread as percent of midpoint" },
      maxQuoteAgeSeconds: { type: "number", description: "Quote age reference for freshness labels; does not discard stale rows" },
      limit: { type: "number", description: "Maximum contracts to return (clamped to 500); omitted returns up to 500 matches" },
      paymentSignature: { type: "string", description: "x402 PAYMENT-SIGNATURE proof (base64 JSON or hex)" },
    },
  };
  // Issue #959: the filter constraints are composed from the ONE
  // shared options-filter definition (optionScreenerFilterFields in
  // src/trading/screeningSchemas.ts); this command's own tighter
  // bounds (0..1 deltas, positive maxDte, integer open interest) are
  // layered on the shared field schemas, not re-declared.
  readonly zodSchema = z.object({
    underlying: z.string().optional(),
    maxUnderlyings: optionScreenerFilterFields.maxUnderlyings,
    contractType: optionScreenerFilterFields.contractType,
    minDelta: optionScreenerFilterFields.minDelta.unwrap().min(0).max(1).optional(),
    maxDelta: optionScreenerFilterFields.maxDelta.unwrap().min(0).max(1).optional(),
    minDte: optionScreenerFilterFields.minDte,
    maxDte: optionScreenerFilterFields.maxDte.unwrap().min(1).optional(),
    minVolume: optionScreenerFilterFields.minVolume,
    minOpenInterest: optionScreenerFilterFields.minOpenInterest.unwrap().int().min(0).optional(),
    maxSpreadPct: optionScreenerFilterFields.maxSpreadPct,
    maxQuoteAgeSeconds: optionScreenerFilterFields.maxQuoteAgeSeconds,
    limit: optionScreenerFilterFields.limit,
    paymentSignature: z.string().optional(),
  });

  async execute(
    input: {
      underlying?: string;
      maxUnderlyings?: number;
      contractType?: "CALL" | "PUT" | "BOTH";
      minDelta?: number;
      maxDelta?: number;
      minDte?: number;
      maxDte?: number;
      minVolume?: number;
      minOpenInterest?: number;
      maxSpreadPct?: number;
      maxQuoteAgeSeconds?: number;
      limit?: number;
      paymentSignature?: string;
    },
    context: McpToolContext
  ) {
    const paymentService = new ETradeAgenticPaymentService(context.orm, context.env, context.sessionId);
    const serviceDef = TRADING_PAID_SERVICES.OPTIONS_SCREENER;
    const extractedNonce = paymentService.extractNonce(input.paymentSignature);
    const challenge = paymentService.createX402Challenge(serviceDef.resource, serviceDef.priceUSD, serviceDef.description, extractedNonce);

    // If no payment proof supplied, return 402 challenge
    if (!input.paymentSignature) {
      return {
        status: 402,
        paid: false,
        error: "Payment Required",
        priceUSD: serviceDef.priceUSD,
        currency: challenge.currency,
        challenge,
        paymentHeader: "PAYMENT-SIGNATURE",
        message: `Tool 'paid_options_screener' requires $${serviceDef.priceUSD.toFixed(2)} ${challenge.currency}. Sign the challenge and retry with paymentSignature.`,
      };
    }

    // Verify payment signature
    const verification = await paymentService.verifyPayment(
      { "PAYMENT-SIGNATURE": input.paymentSignature },
      challenge
    );

    if (!verification.valid || !verification.receipt) {
      return {
        status: 402,
        error: "Payment Verification Failed",
        reason: verification.reason || "Invalid payment signature.",
        challenge,
      };
    }

    // Payment verified: execute options screen. Issue #959: the
    // assembled filter validates through the ONE shared options-filter
    // schema before the engine sees it.
    const parsedFilter = parseOptionScreenerFilter({
      underlyingSymbols: input.underlying ? [input.underlying.toUpperCase().trim()] : undefined,
      maxUnderlyings: input.maxUnderlyings,
      contractType: input.contractType,
      minDelta: input.minDelta,
      maxDelta: input.maxDelta,
      minDte: input.minDte,
      maxDte: input.maxDte,
      minVolume: input.minVolume,
      minOpenInterest: input.minOpenInterest,
      maxSpreadPct: input.maxSpreadPct,
      maxQuoteAgeSeconds: input.maxQuoteAgeSeconds,
      limit: input.limit,
    });
    if (!parsedFilter.ok) {
      return { status: 400, error: parsedFilter.error };
    }
    // Issue #982: the paid tool executes through UnifiedOptionsService
    // (the service the REST routes call); its screen data is the raw
    // screen result the response below is built from.
    const service = new UnifiedOptionsService(context.env, context.sessionId || "default_trader", undefined, context.orm);
    const serviceResponse = await service.execute({
      action: "screen",
      channel: "mcp",
      filter: parsedFilter.value,
      symbols: parsedFilter.value.underlyingSymbols,
      limit: parsedFilter.value.limit,
    });
    const result = serviceResponse.data;

    context.audit("agentic_payment.tool_executed", "trading", {
      tool: "paid_options_screener",
      price: serviceDef.priceUSD,
      receiptId: verification.receipt.receiptId,
      txHash: verification.receipt.txHash,
    });

    return {
      status: 200,
      paid: true,
      receipt: verification.receipt,
      matchesCount: result.matchedCount,
      totalMatches: result.totalMatches,
      screenStatus: result.status,
      rejectionCount: result.rejectionCount,
      ...(result.status === "error"
        ? {
            error:
              result.validationError ||
              result.fetchErrors?.[0]?.reason ||
              "Options screen failed upstream; no data could be fetched.",
          }
        : {}),
      ...(result.fetchErrors && result.fetchErrors.length > 0 ? { fetchErrors: result.fetchErrors } : {}),
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      quoteQuality: result.quoteQuality,
      contracts: result.contracts,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 2. Paid Market Research Command ($0.10 USDC)
 */
export class PaidMarketResearchCommand implements IMcpToolCommand<{
  symbol?: string;
  paymentSignature?: string;
}> {
  readonly name = "paid_market_research";
  readonly description =
    "Generate deep institutional equity research report. Requires Cloudflare Agentic Payment ($0.10 USDC). Supply paymentSignature or call without to receive 402 challenge.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL)" },
      paymentSignature: { type: "string", description: "x402 PAYMENT-SIGNATURE proof (base64 JSON or hex)" },
    },
  };
  readonly zodSchema = z.object({
    symbol: z.string().optional().default("NVDA"),
    paymentSignature: z.string().optional(),
  });

  async execute(input: { symbol?: string; paymentSignature?: string }, context: McpToolContext) {
    const paymentService = new ETradeAgenticPaymentService(context.orm, context.env, context.sessionId);
    const serviceDef = TRADING_PAID_SERVICES.MARKET_RESEARCH;
    const extractedNonce = paymentService.extractNonce(input.paymentSignature);
    const challenge = paymentService.createX402Challenge(serviceDef.resource, serviceDef.priceUSD, serviceDef.description, extractedNonce);

    if (!input.paymentSignature) {
      return {
        status: 402,
        paid: false,
        error: "Payment Required",
        priceUSD: serviceDef.priceUSD,
        currency: challenge.currency,
        challenge,
        paymentHeader: "PAYMENT-SIGNATURE",
        message: `Tool 'paid_market_research' requires $${serviceDef.priceUSD.toFixed(2)} ${challenge.currency}. Sign the challenge and retry with paymentSignature.`,
      };
    }

    const verification = await paymentService.verifyPayment(
      { "PAYMENT-SIGNATURE": input.paymentSignature },
      challenge
    );

    if (!verification.valid || !verification.receipt) {
      return {
        status: 402,
        error: "Payment Verification Failed",
        reason: verification.reason || "Invalid payment signature.",
        challenge,
      };
    }

    const foss = new FossResearchService(context.env);
    const report = await foss.generateResearchReport(input.symbol || "NVDA");

    context.audit("agentic_payment.tool_executed", "research", {
      tool: "paid_market_research",
      price: serviceDef.priceUSD,
      receiptId: verification.receipt.receiptId,
      symbol: input.symbol || "NVDA",
    });

    return {
      status: 200,
      paid: true,
      receipt: verification.receipt,
      report,
    };
  }
}

/**
 * 3. Agentic Wallet Status Command
 */
export class AgenticWalletStatusCommand implements IMcpToolCommand<{
  action?: "status" | "set_limit";
  limitUSD?: number;
}> {
  readonly name = "agentic_wallet_status";
  readonly description =
    "Check Cloudflare Agentic Payments (x402/MPP) wallet status, auto-approval threshold, and transaction metrics. NOTE: the balance is a SIMULATED local-ledger figure (a $50.00 local starting credit plus/minus locally recorded entries) — this service does not read any on-chain wallet balance.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["status", "set_limit"], description: "Action to perform" },
      limitUSD: { type: "number", description: "New auto-approval threshold in USD (e.g. 0.10)" },
    },
  };
  readonly zodSchema = z.object({
    action: z.enum(["status", "set_limit"]).optional().default("status"),
    limitUSD: z.number().optional(),
  });

  async execute(input: { action?: "status" | "set_limit"; limitUSD?: number }, context: McpToolContext) {
    const paymentService = new ETradeAgenticPaymentService(context.orm, context.env, context.sessionId);

    if (input.action === "set_limit" && input.limitUSD !== undefined) {
      paymentService.setAutoApproveLimit(input.limitUSD);
      return {
        success: true,
        message: `Agentic payment auto-approval limit set to $${input.limitUSD.toFixed(2)} USD.`,
        autoApproveLimitUSD: input.limitUSD,
      };
    }

    const status = await paymentService.getWalletStatus();
    return {
      success: true,
      ...status,
    };
  }
}
