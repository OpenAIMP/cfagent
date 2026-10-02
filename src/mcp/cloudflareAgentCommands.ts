/**
 * MCP Tool Commands for Cloudflare Agents Advanced Capabilities
 *
 * Implements:
 * - browser_inspect_page & browser_screenshot (Browser Agent)
 * - dispatch_trading_webhook (Trading Webhooks)
 * - run_sandbox_command & run_quant_backtest (Sandbox Container)
 * - think_trade_validation (Think Harness)
 * - ai_search_financial_docs (AI Search)
 * - execute_durable_twap (Durable Fibers)
 */

import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import { z } from "zod";
import { ETradeBrowserService } from "../services/browserAgent";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import { ETradeSandboxService } from "../services/sandboxAgent";
import { ETradeThinkHarness } from "../services/thinkHarness";
import { ETradeAISearchService } from "../services/aiSearch";
import { ETradeDurableFiberService } from "../services/durableFibers";
import { ETradeService } from "../services/etrade";

/**
 * 1. Browser Inspect Page Command
 */
export class BrowserInspectCommand implements IMcpToolCommand<{ url: string; selector?: string }> {
  readonly name = "browser_inspect_page";
  readonly description = "Inspect rendered web page or financial portal using Cloudflare Browser Agent";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL to inspect" },
      selector: { type: "string", description: "Optional CSS selector to target" },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({
    url: z.string(),
    selector: z.string().optional(),
  });

  async execute(input: { url: string; selector?: string }, context: McpToolContext) {
    const browser = new ETradeBrowserService(context.env);
    const result = await browser.inspectPage({ url: input.url, selector: input.selector });
    context.audit("browser.inspect", "browser", { url: input.url, success: result.success });
    return result;
  }
}

/**
 * 2. Browser Screenshot Command
 */
export class BrowserScreenshotCommand implements IMcpToolCommand<{ url: string }> {
  readonly name = "browser_screenshot";
  readonly description = "Capture screenshot of financial charts or brokerage confirmations using Cloudflare Browser Agent";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL of the page/chart to screenshot" },
    },
    required: ["url"],
  };
  readonly zodSchema = z.object({ url: z.string() });

  async execute(input: { url: string }, context: McpToolContext) {
    const browser = new ETradeBrowserService(context.env);
    const result = await browser.captureScreenshot(input.url);
    context.audit("browser.screenshot", "browser", { url: input.url, success: result.success });
    return result;
  }
}

/**
 * 3. Dispatch Trading Webhook Command
 */
export class DispatchTradingWebhookCommand implements IMcpToolCommand<{
  eventType: string;
  data: Record<string, any>;
  targetUrl?: string;
}> {
  readonly name = "dispatch_trading_webhook";
  readonly description = "Dispatch HMAC-SHA256 signed trading webhook event to subscriber URL";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      eventType: { type: "string", description: "Event name e.g. order.executed or alert.triggered" },
      data: { type: "object", description: "Payload data dictionary" },
      targetUrl: { type: "string", description: "Optional target webhook URL" },
    },
    required: ["eventType", "data"],
  };
  readonly zodSchema = z.object({
    eventType: z.string(),
    data: z.record(z.string(), z.unknown()),
    targetUrl: z.string().optional(),
  });

  async execute(input: { eventType: string; data: Record<string, any>; targetUrl?: string }, context: McpToolContext) {
    const webhookService = new ETradeWebhookService(context.orm, context.env, context.sessionId);
    const result = await webhookService.dispatchOutboundWebhook(input.eventType, input.data, input.targetUrl);
    context.audit("webhook.dispatch", "webhook", { eventType: input.eventType, success: result.success });
    return result;
  }
}

/**
 * 4. Sandbox Run Command
 */
export class SandboxRunCommand implements IMcpToolCommand<{ command: string; timeoutMs?: number }> {
  readonly name = "run_sandbox_command";
  readonly description = "Execute shell command in Cloudflare Linux container sandbox for financial computing";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
    },
    required: ["command"],
  };
  readonly zodSchema = z.object({
    command: z.string(),
    timeoutMs: z.number().optional(),
  });

  async execute(input: { command: string; timeoutMs?: number }, context: McpToolContext) {
    const sandbox = new ETradeSandboxService(undefined, context.env);
    const result = await sandbox.runCommand({ command: input.command, timeoutMs: input.timeoutMs });
    context.audit("sandbox.execute", "sandbox", { command: input.command, exitCode: result.exitCode });
    return result;
  }
}

/**
 * 5. Quant Backtest Command
 */
export class QuantBacktestCommand implements IMcpToolCommand<{
  symbol: string;
  strategy?: "sma_crossover" | "rsi_reversal" | "mean_reversion" | "breakout";
  startBars?: number;
}> {
  readonly name = "run_quant_backtest";
  readonly description = "Execute quantitative algorithmic strategy backtest (Sharpe, Drawdown, Win Rate)";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol to backtest e.g. NVDA" },
      strategy: { type: "string", enum: ["sma_crossover", "rsi_reversal", "mean_reversion", "breakout"] },
      startBars: { type: "number", description: "Number of historical bars (default: 100)" },
    },
    required: ["symbol"],
  };
  readonly zodSchema = z.object({
    symbol: z.string(),
    strategy: z.enum(["sma_crossover", "rsi_reversal", "mean_reversion", "breakout"]).optional(),
    startBars: z.number().optional(),
  });

  async execute(input: { symbol: string; strategy?: any; startBars?: number }, context: McpToolContext) {
    const sandbox = new ETradeSandboxService(undefined, context.env);
    const result = await sandbox.runQuantBacktest({
      symbol: input.symbol,
      strategy: input.strategy || "sma_crossover",
      startBars: input.startBars || 100,
    });
    context.audit("quant.backtest", "sandbox", { symbol: input.symbol, sharpe: result.sharpeRatio });
    return result;
  }
}

/**
 * 6. Think Trade Validation Command
 */
export class ThinkTradeValidationCommand implements IMcpToolCommand<{
  symbol: string;
  action: "BUY" | "SELL";
  quantity: number;
  orderType?: "MARKET" | "LIMIT" | "STOP";
  price?: number;
}> {
  readonly name = "think_trade_validation";
  readonly description = "Run Cloudflare Think extended reasoning harness on proposed trade across 5 risk & regulatory phases";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker e.g. NVDA" },
      action: { type: "string", enum: ["BUY", "SELL"] },
      quantity: { type: "number", description: "Number of shares" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP"] },
      price: { type: "number", description: "Optional limit price" },
    },
    required: ["symbol", "action", "quantity"],
  };
  readonly zodSchema = z.object({
    symbol: z.string(),
    action: z.enum(["BUY", "SELL"]),
    quantity: z.number(),
    orderType: z.enum(["MARKET", "LIMIT", "STOP"]).optional(),
    price: z.number().optional(),
  });

  async execute(input: { symbol: string; action: "BUY" | "SELL"; quantity: number; orderType?: any; price?: number }, context: McpToolContext) {
    const thinkHarness = new ETradeThinkHarness(context.orm, context.env);
    const result = await thinkHarness.evaluateTradeWithThinking({
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      orderType: input.orderType || "MARKET",
      price: input.price,
      userLogin: context.sessionId,
    });
    context.audit("think.evaluated", "think", {
      symbol: input.symbol,
      approved: result.approved,
      recommendation: result.recommendation,
    });
    return result;
  }
}

/**
 * 7. AI Search Financial Docs Command
 */
export class AISearchFinancialDocsCommand implements IMcpToolCommand<{ query: string; limit?: number }> {
  readonly name = "ai_search_financial_docs";
  readonly description = "Perform semantic search across SEC 10-K/10-Q filings, broker rules, and options disclosures";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language query e.g. NVDA data center revenue or PDT margin rules" },
      limit: { type: "number", description: "Maximum documents to return (default: 5)" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string(),
    limit: z.number().optional(),
  });

  async execute(input: { query: string; limit?: number }, context: McpToolContext) {
    const aiSearch = new ETradeAISearchService(context.env);
    const result = await aiSearch.searchFinancialDocs(input.query, input.limit || 5);
    context.audit("ai_search.query", "search", { query: input.query, matches: result.totalMatches });
    return result;
  }
}

/**
 * 8. Durable TWAP Order Command
 */
export class DurableTWAPOrderCommand implements IMcpToolCommand<{
  symbol: string;
  action: "BUY" | "SELL";
  totalQuantity: number;
  slices: number;
  intervalSeconds?: number;
}> {
  readonly name = "execute_durable_twap";
  readonly description = "Execute a durable TWAP order across slices with Cloudflare durable execution and checkpointing";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker e.g. NVDA" },
      action: { type: "string", enum: ["BUY", "SELL"] },
      totalQuantity: { type: "number", description: "Total shares to execute" },
      slices: { type: "number", description: "Number of execution slices" },
      intervalSeconds: { type: "number", description: "Interval in seconds between slices" },
    },
    required: ["symbol", "action", "totalQuantity", "slices"],
  };
  readonly zodSchema = z.object({
    symbol: z.string(),
    action: z.enum(["BUY", "SELL"]),
    totalQuantity: z.number(),
    slices: z.number(),
    intervalSeconds: z.number().optional(),
  });

  async execute(input: { symbol: string; action: "BUY" | "SELL"; totalQuantity: number; slices: number; intervalSeconds?: number }, context: McpToolContext) {
    const fiberService = new ETradeDurableFiberService(context.orm, context.env, context.sessionId);
    const tradingService = new ETradeService(context.orm, context.env, context.sessionId);

    const result = await fiberService.executeDurableTWAP(
      {
        symbol: input.symbol,
        action: input.action,
        totalQuantity: input.totalQuantity,
        slices: input.slices,
        intervalSeconds: input.intervalSeconds || 1,
      },
      async (_sliceNum, sliceQty) => {
        return tradingService.previewOrder({
          symbol: input.symbol,
          action: input.action,
          quantity: sliceQty,
          orderType: "MARKET",
          sessionId: context.sessionId,
        });
      }
    );

    context.audit("twap.executed", "trading", { symbol: input.symbol, totalFilled: result.totalFilled });
    return result;
  }
}
