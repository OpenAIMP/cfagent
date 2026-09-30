/**
 * FOSS Market Research & Quoting Model Context Protocol (MCP) Tool Commands
 *
 * Implements:
 * - GoF Command Pattern: Encapsulates FOSS market operations (yfinance & Alpaca) as executable MCP commands.
 * - SOLID Single Responsibility Principle: Each command executes a discrete research or quoting capability.
 * - GoF Adapter Pattern: Directly adapted into Vercel AI SDK tools for agent self-consumption.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import { FossResearchService } from "../services/fossResearch";

/**
 * 1. FOSS Get Quote Command
 * Fetches real-time equity or crypto quote from Yahoo Finance, Alpaca, or Hybrid.
 */
export class FossGetQuoteCommand implements IMcpToolCommand {
  readonly name = "foss_get_quote";
  readonly description = "Retrieve real-time market quote, bid/ask spread, 24h change, and volume using FOSS engines (Yahoo Finance or Alpaca Market Data v2).";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker or crypto pair (e.g. NVDA, AAPL, MSFT, BTC/USD)" },
      provider: { type: "string", enum: ["yfinance", "alpaca", "hybrid"], description: "Market data provider (default: hybrid)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker or crypto pair"),
    provider: z.enum(["yfinance", "alpaca", "hybrid"]).default("hybrid").optional(),
  });

  async execute(input: { symbol: string; provider?: "yfinance" | "alpaca" | "hybrid" }, context: McpToolContext) {
    const service = new FossResearchService(context.env);
    const quote = await service.getQuote(input.symbol, input.provider || "hybrid");
    context.audit?.("foss.quote.fetched", "research", { symbol: input.symbol, provider: quote.provider, price: quote.price });
    return quote;
  }
}

/**
 * 2. FOSS Company Fundamentals Command
 * Retrieves institutional valuation metrics, P/E, PEG, P/B, Beta, and analyst price targets via Yahoo Finance.
 */
export class FossFundamentalsCommand implements IMcpToolCommand {
  readonly name = "foss_company_fundamentals";
  readonly description = "Extract comprehensive company fundamentals, valuation ratios (P/E, PEG, Price-to-Book, Beta), 52-week statistics, and Wall Street analyst targets via Yahoo Finance FOSS.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker symbol"),
  });

  async execute(input: { symbol: string }, context: McpToolContext) {
    const service = new FossResearchService(context.env);
    const fundamentals = await service.getFundamentals(input.symbol);
    context.audit?.("foss.fundamentals.fetched", "research", { symbol: input.symbol, marketCap: fundamentals.marketCap, pe: fundamentals.peTrailing });
    return fundamentals;
  }
}

/**
 * 3. FOSS Historical Bars Command
 * Retrieves daily or intraday OHLCV bars for technical chart analysis.
 */
export class FossHistoricalBarsCommand implements IMcpToolCommand {
  readonly name = "foss_historical_bars";
  readonly description = "Query historical OHLCV pricing bars, VWAP, and volume series for equities and crypto.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol or crypto pair" },
      timeframe: { type: "string", description: "Bar timeframe (default: '1D')" },
      limit: { type: "number", description: "Number of bars to return (default: 30, max: 90)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker or crypto pair"),
    timeframe: z.string().default("1D").optional(),
    limit: z.number().int().min(1).max(90).default(30).optional(),
  });

  async execute(input: { symbol: string; timeframe?: string; limit?: number }, context: McpToolContext) {
    const service = new FossResearchService(context.env);
    const bars = await service.getHistoricalBars(input.symbol, input.timeframe || "1D", input.limit || 30);
    context.audit?.("foss.bars.fetched", "research", { symbol: input.symbol, count: bars.length });
    return { symbol: input.symbol.toUpperCase(), count: bars.length, bars };
  }
}

/**
 * 4. FOSS Market Research Synthesis Command
 * Generates an end-to-end equity research report with AI analysis, technical indicators, and cryptographic Agent DID stamp.
 */
export class FossMarketResearchCommand implements IMcpToolCommand {
  readonly name = "foss_market_research";
  readonly description = "Generate an autonomous equity research report synthesizing real-time quoting, institutional valuation, technical RSI/MACD indicators, analyst consensus, and cryptographic W3C Agent DID attestation.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT, TSLA)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker symbol"),
  });

  async execute(input: { symbol: string }, context: McpToolContext) {
    const service = new FossResearchService(context.env);
    const report = await service.generateResearchReport(input.symbol);
    context.audit?.("foss.research.generated", "research", { symbol: input.symbol, rating: report.analystRating, did: report.agentAttestation.did });
    return report;
  }
}

/**
 * 5. FOSS Alpaca Market Snapshot Command
 * Retrieves Level 1/2 quotes, latest trade executions, and NBBO order book spread from Alpaca Market Data v2.
 */
export class FossAlpacaSnapshotCommand implements IMcpToolCommand {
  readonly name = "foss_alpaca_snapshot";
  readonly description = "Query real-time Level 1/2 market snapshot, NBBO bid/ask prices, trade prints, and daily volume via Alpaca Market Data v2.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol or crypto pair (e.g. NVDA, BTC/USD)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker or crypto pair"),
  });

  async execute(input: { symbol: string }, context: McpToolContext) {
    const service = new FossResearchService(context.env);
    const snapshot = await service.getAlpacaSnapshot(input.symbol);
    context.audit?.("foss.alpaca.snapshot", "research", { symbol: input.symbol, assetClass: snapshot.assetClass, tradePrice: snapshot.latestTrade.price });
    return snapshot;
  }
}
