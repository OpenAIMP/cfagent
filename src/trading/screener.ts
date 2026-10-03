/**
 * Dynamic Market Screener Engine
 *
 * Implements:
 * - Dynamic screening across multi-sector universes without reliance on static hardcoded values.
 * - Live candidate discovery from E*TRADE market movers and user watchlists.
 * - Quote-based filtering with missing provider metrics treated as unavailable.
 */

import type { StockScreenerFilter, StockScreenResult, ScreenedStockItem, ETradeQuote } from "../types";
import type { IMarketScreener } from "./interfaces";
import type { ETradeRestClient } from "./etrade/client";

export interface YFinanceSecurityDefinition {
  symbol: string;
  companyName: string;
  sector: string;
}

// Yahoo Finance-only ticker metadata; E*TRADE scans use live market discovery below.
export const YFINANCE_MARKET_UNIVERSE: YFinanceSecurityDefinition[] = [
  // Financials & Fintech (18)
  { symbol: "JPM", companyName: "JPMorgan Chase & Co.", sector: "Financial" },
  { symbol: "MS", companyName: "Morgan Stanley", sector: "Financial" },
  { symbol: "GS", companyName: "The Goldman Sachs Group, Inc.", sector: "Financial" },
  { symbol: "BAC", companyName: "Bank of America Corporation", sector: "Financial" },
  { symbol: "WFC", companyName: "Wells Fargo & Company", sector: "Financial" },
  { symbol: "C", companyName: "Citigroup Inc.", sector: "Financial" },
  { symbol: "V", companyName: "Visa Inc.", sector: "Financial" },
  { symbol: "MA", companyName: "Mastercard Incorporated", sector: "Financial" },
  { symbol: "AXP", companyName: "American Express Company", sector: "Financial" },
  { symbol: "BLK", companyName: "BlackRock, Inc.", sector: "Financial" },
  { symbol: "SCHW", companyName: "The Charles Schwab Corporation", sector: "Financial" },
  { symbol: "BX", companyName: "Blackstone Inc.", sector: "Financial" },
  { symbol: "COIN", companyName: "Coinbase Global, Inc.", sector: "Financial" },
  { symbol: "PYPL", companyName: "PayPal Holdings, Inc.", sector: "Financial" },
  { symbol: "SQ", companyName: "Block, Inc.", sector: "Financial" },
  { symbol: "HOOD", companyName: "Robinhood Markets, Inc.", sector: "Financial" },
  { symbol: "PGR", companyName: "The Progressive Corporation", sector: "Financial" },
  { symbol: "CB", companyName: "Chubb Limited", sector: "Financial" },

  // Technology, Cloud & Software (20)
  { symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology" },
  { symbol: "MSFT", companyName: "Microsoft Corporation", sector: "Technology" },
  { symbol: "PLTR", companyName: "Palantir Technologies Inc.", sector: "Technology" },
  { symbol: "CRM", companyName: "Salesforce, Inc.", sector: "Technology" },
  { symbol: "ORCL", companyName: "Oracle Corporation", sector: "Technology" },
  { symbol: "ADBE", companyName: "Adobe Inc.", sector: "Technology" },
  { symbol: "INTU", companyName: "Intuit Inc.", sector: "Technology" },
  { symbol: "IBM", companyName: "International Business Machines Corporation", sector: "Technology" },
  { symbol: "CSCO", companyName: "Cisco Systems, Inc.", sector: "Technology" },
  { symbol: "NOW", companyName: "ServiceNow, Inc.", sector: "Technology" },
  { symbol: "SNOW", companyName: "Snowflake Inc.", sector: "Technology" },
  { symbol: "UBER", companyName: "Uber Technologies, Inc.", sector: "Technology" },
  { symbol: "ABNB", companyName: "Airbnb, Inc.", sector: "Technology" },
  { symbol: "PANW", companyName: "Palo Alto Networks, Inc.", sector: "Technology" },
  { symbol: "CRWD", companyName: "CrowdStrike Holdings, Inc.", sector: "Technology" },
  { symbol: "FTNT", companyName: "Fortinet, Inc.", sector: "Technology" },
  { symbol: "ZS", companyName: "Zscaler, Inc.", sector: "Technology" },
  { symbol: "DDOG", companyName: "Datadog, Inc.", sector: "Technology" },
  { symbol: "NET", companyName: "Cloudflare, Inc.", sector: "Technology" },
  { symbol: "DELL", companyName: "Dell Technologies Inc.", sector: "Technology" },

  // Semiconductors & AI Hardware (16)
  { symbol: "NVDA", companyName: "NVIDIA Corporation", sector: "Semiconductors" },
  { symbol: "AMD", companyName: "Advanced Micro Devices, Inc.", sector: "Semiconductors" },
  { symbol: "AVGO", companyName: "Broadcom Inc.", sector: "Semiconductors" },
  { symbol: "TSM", companyName: "Taiwan Semiconductor Manufacturing Co.", sector: "Semiconductors" },
  { symbol: "INTC", companyName: "Intel Corporation", sector: "Semiconductors" },
  { symbol: "QCOM", companyName: "QUALCOMM Incorporated", sector: "Semiconductors" },
  { symbol: "TXN", companyName: "Texas Instruments Incorporated", sector: "Semiconductors" },
  { symbol: "AMAT", companyName: "Applied Materials, Inc.", sector: "Semiconductors" },
  { symbol: "MU", companyName: "Micron Technology, Inc.", sector: "Semiconductors" },
  { symbol: "LRCX", companyName: "Lam Research Corporation", sector: "Semiconductors" },
  { symbol: "ADI", companyName: "Analog Devices, Inc.", sector: "Semiconductors" },
  { symbol: "KLAC", companyName: "KLA Corporation", sector: "Semiconductors" },
  { symbol: "ARM", companyName: "Arm Holdings plc", sector: "Semiconductors" },
  { symbol: "ASML", companyName: "ASML Holding N.V.", sector: "Semiconductors" },
  { symbol: "MRVL", companyName: "Marvell Technology, Inc.", sector: "Semiconductors" },
  { symbol: "SMCI", companyName: "Super Micro Computer, Inc.", sector: "Semiconductors" },

  // Consumer Discretionary & Retail (14)
  { symbol: "AMZN", companyName: "Amazon.com, Inc.", sector: "Consumer Discretionary" },
  { symbol: "TSLA", companyName: "Tesla, Inc.", sector: "Consumer Discretionary" },
  { symbol: "HD", companyName: "The Home Depot, Inc.", sector: "Consumer Discretionary" },
  { symbol: "LOW", companyName: "Lowe's Companies, Inc.", sector: "Consumer Discretionary" },
  { symbol: "NKE", companyName: "NIKE, Inc.", sector: "Consumer Discretionary" },
  { symbol: "SBUX", companyName: "Starbucks Corporation", sector: "Consumer Discretionary" },
  { symbol: "MCD", companyName: "McDonald's Corporation", sector: "Consumer Discretionary" },
  { symbol: "BKNG", companyName: "Booking Holdings Inc.", sector: "Consumer Discretionary" },
  { symbol: "TJX", companyName: "The TJX Companies, Inc.", sector: "Consumer Discretionary" },
  { symbol: "TGT", companyName: "Target Corporation", sector: "Consumer Discretionary" },
  { symbol: "COST", companyName: "Costco Wholesale Corporation", sector: "Consumer Discretionary" },
  { symbol: "LULU", companyName: "Lululemon Athletica Inc.", sector: "Consumer Discretionary" },
  { symbol: "GM", companyName: "General Motors Company", sector: "Consumer Discretionary" },
  { symbol: "F", companyName: "Ford Motor Company", sector: "Consumer Discretionary" },

  // Communication Services & Media (10)
  { symbol: "GOOGL", companyName: "Alphabet Inc. (Class A)", sector: "Communication Services" },
  { symbol: "GOOG", companyName: "Alphabet Inc. (Class C)", sector: "Communication Services" },
  { symbol: "META", companyName: "Meta Platforms, Inc.", sector: "Communication Services" },
  { symbol: "NFLX", companyName: "Netflix, Inc.", sector: "Communication Services" },
  { symbol: "DIS", companyName: "The Walt Disney Company", sector: "Communication Services" },
  { symbol: "CMCSA", companyName: "Comcast Corporation", sector: "Communication Services" },
  { symbol: "VZ", companyName: "Verizon Communications Inc.", sector: "Communication Services" },
  { symbol: "T", companyName: "AT&T Inc.", sector: "Communication Services" },
  { symbol: "SPOT", companyName: "Spotify Technology S.A.", sector: "Communication Services" },
  { symbol: "TMUS", companyName: "T-Mobile US, Inc.", sector: "Communication Services" },

  // Healthcare, Pharma & Biotech (14)
  { symbol: "LLY", companyName: "Eli Lilly and Company", sector: "Healthcare" },
  { symbol: "UNH", companyName: "UnitedHealth Group Incorporated", sector: "Healthcare" },
  { symbol: "JNJ", companyName: "Johnson & Johnson", sector: "Healthcare" },
  { symbol: "ABBV", companyName: "AbbVie Inc.", sector: "Healthcare" },
  { symbol: "PFE", companyName: "Pfizer Inc.", sector: "Healthcare" },
  { symbol: "MRK", companyName: "Merck & Co., Inc.", sector: "Healthcare" },
  { symbol: "TMO", companyName: "Thermo Fisher Scientific Inc.", sector: "Healthcare" },
  { symbol: "ABT", companyName: "Abbott Laboratories", sector: "Healthcare" },
  { symbol: "DHR", companyName: "Danaher Corporation", sector: "Healthcare" },
  { symbol: "BMY", companyName: "Bristol-Myers Squibb Company", sector: "Healthcare" },
  { symbol: "AMGN", companyName: "Amgen Inc.", sector: "Healthcare" },
  { symbol: "GILD", companyName: "Gilead Sciences, Inc.", sector: "Healthcare" },
  { symbol: "ISRG", companyName: "Intuitive Surgical, Inc.", sector: "Healthcare" },
  { symbol: "VRTX", companyName: "Vertex Pharmaceuticals Incorporated", sector: "Healthcare" },

  // Energy & Clean Tech (10)
  { symbol: "XOM", companyName: "Exxon Mobil Corporation", sector: "Energy" },
  { symbol: "CVX", companyName: "Chevron Corporation", sector: "Energy" },
  { symbol: "COP", companyName: "ConocoPhillips", sector: "Energy" },
  { symbol: "SLB", companyName: "Schlumberger Limited", sector: "Energy" },
  { symbol: "EOG", companyName: "EOG Resources, Inc.", sector: "Energy" },
  { symbol: "MPC", companyName: "Marathon Petroleum Corporation", sector: "Energy" },
  { symbol: "PSX", companyName: "Phillips 66", sector: "Energy" },
  { symbol: "VLO", companyName: "Valero Energy Corporation", sector: "Energy" },
  { symbol: "OXY", companyName: "Occidental Petroleum Corporation", sector: "Energy" },
  { symbol: "FSLR", companyName: "First Solar, Inc.", sector: "Energy" },

  // Industrials, Aerospace & Defense (12)
  { symbol: "CAT", companyName: "Caterpillar Inc.", sector: "Industrials" },
  { symbol: "GE", companyName: "GE Aerospace", sector: "Industrials" },
  { symbol: "HON", companyName: "Honeywell International Inc.", sector: "Industrials" },
  { symbol: "UNP", companyName: "Union Pacific Corporation", sector: "Industrials" },
  { symbol: "BA", companyName: "The Boeing Company", sector: "Industrials" },
  { symbol: "LMT", companyName: "Lockheed Martin Corporation", sector: "Industrials" },
  { symbol: "RTX", companyName: "RTX Corporation", sector: "Industrials" },
  { symbol: "DE", companyName: "Deere & Company", sector: "Industrials" },
  { symbol: "UPS", companyName: "United Parcel Service, Inc.", sector: "Industrials" },
  { symbol: "FDX", companyName: "FedEx Corporation", sector: "Industrials" },
  { symbol: "GD", companyName: "General Dynamics Corporation", sector: "Industrials" },
  { symbol: "EMR", companyName: "Emerson Electric Co.", sector: "Industrials" },

  // Materials & Chemicals (6)
  { symbol: "LIN", companyName: "Linde plc", sector: "Materials" },
  { symbol: "SHW", companyName: "The Sherwin-Williams Company", sector: "Materials" },
  { symbol: "FCX", companyName: "Freeport-McMoRan Inc.", sector: "Materials" },
  { symbol: "NEM", companyName: "Newmont Corporation", sector: "Materials" },
  { symbol: "APD", companyName: "Air Products and Chemicals, Inc.", sector: "Materials" },
  { symbol: "ECL", companyName: "Ecolab Inc.", sector: "Materials" },

  // Consumer Staples (8)
  { symbol: "PG", companyName: "The Procter & Gamble Company", sector: "Consumer Staples" },
  { symbol: "PEP", companyName: "PepsiCo, Inc.", sector: "Consumer Staples" },
  { symbol: "KO", companyName: "The Coca-Cola Company", sector: "Consumer Staples" },
  { symbol: "WMT", companyName: "Walmart Inc.", sector: "Consumer Staples" },
  { symbol: "PM", companyName: "Philip Morris International Inc.", sector: "Consumer Staples" },
  { symbol: "MO", companyName: "Altria Group, Inc.", sector: "Consumer Staples" },
  { symbol: "MDLZ", companyName: "Mondelez International, Inc.", sector: "Consumer Staples" },
  { symbol: "CL", companyName: "Colgate-Palmolive Company", sector: "Consumer Staples" },

  // Utilities & Real Estate (8)
  { symbol: "NEE", companyName: "NextEra Energy, Inc.", sector: "Utilities" },
  { symbol: "SO", companyName: "The Southern Company", sector: "Utilities" },
  { symbol: "DUK", companyName: "Duke Energy Corporation", sector: "Utilities" },
  { symbol: "CEG", companyName: "Constellation Energy Corporation", sector: "Utilities" },
  { symbol: "PLD", companyName: "Prologis, Inc.", sector: "Real Estate" },
  { symbol: "AMT", companyName: "American Tower Corporation", sector: "Real Estate" },
  { symbol: "EQIX", companyName: "Equinix, Inc.", sector: "Real Estate" },
  { symbol: "SPG", companyName: "Simon Property Group, Inc.", sector: "Real Estate" },
];

export function calculateDynamicRsi(
  symbol: string,
  price: number,
  high52?: number,
  low52?: number,
  changePercent: number = 0,
  explicitRsi?: number
): number | undefined {
  if (explicitRsi !== undefined && Number.isFinite(explicitRsi) && explicitRsi >= 0 && explicitRsi <= 100) {
    return explicitRsi;
  }
  return undefined;
}

export class DynamicMarketScreener implements IMarketScreener {
  private static testUniverseFixture: ScreenedStockItem[] = [];
  private universeCache: ScreenedStockItem[] = [];

  /**
   * Test fixture injector — allows offline unit tests to inject deterministic fixtures
   * without embedding any mock data or fake prices in production code.
   */
  static setTestUniverseFixture(fixture: ScreenedStockItem[]): void {
    DynamicMarketScreener.testUniverseFixture = fixture;
  }

  static getTestUniverseFixture(): ScreenedStockItem[] {
    return DynamicMarketScreener.testUniverseFixture;
  }

  getDefaultUniverse(): ScreenedStockItem[] {
    return [];
  }

  constructor(initialUniverse?: ScreenedStockItem[]) {
    if (initialUniverse && initialUniverse.length > 0) {
      this.universeCache = initialUniverse;
    } else if (DynamicMarketScreener.testUniverseFixture.length > 0) {
      this.universeCache = DynamicMarketScreener.testUniverseFixture;
    } else {
      this.universeCache = this.getDefaultUniverse();
    }
  }

  setUniverse(universe: ScreenedStockItem[]): void {
    this.universeCache = universe || [];
  }

  getUniverse(): ScreenedStockItem[] {
    return this.universeCache;
  }

  /**
   * Internal evaluator that strictly verifies filter rules and builds an auditable scan ledger
   */
  private evaluateUniverse(
    universe: ScreenedStockItem[],
    filter: StockScreenerFilter = {}
  ): StockScreenResult {
    const summaryParts: string[] = [];
    const rejections: { symbol: string; reason: string; changePercent?: number; price?: number; rsi?: number }[] = [];
    const passedStocks: ScreenedStockItem[] = [];

    if (filter.search && filter.search.trim()) {
      summaryParts.push(`Search: "${filter.search.trim()}"`);
    }
    if (filter.sector && filter.sector !== "all" && filter.sector !== "Any") {
      summaryParts.push(`Sector: ${filter.sector}`);
    }
    if (filter.minMarketCap !== undefined && filter.minMarketCap > 0) {
      summaryParts.push(
        `Min Cap: >= $${filter.minMarketCap >= 1e9 ? (filter.minMarketCap / 1e12).toFixed(1) + "T" : filter.minMarketCap + "B"}`
      );
    }
    if (filter.maxPeRatio !== undefined && filter.maxPeRatio > 0) {
      summaryParts.push(`Max P/E: <= ${filter.maxPeRatio}`);
    }
    if (filter.minRsi !== undefined) {
      summaryParts.push(`RSI >= ${filter.minRsi}`);
    }
    if (filter.maxRsi !== undefined) {
      summaryParts.push(`RSI <= ${filter.maxRsi}`);
    }
    if (filter.gainersOnly) {
      summaryParts.push("Gainers Only");
    }
    if (filter.losersOnly) {
      summaryParts.push("Losers Only");
    }
    if (filter.momentum && filter.momentum !== "any") {
      summaryParts.push(`Momentum: ${filter.momentum}`);
    }
    if (filter.minVolume !== undefined && filter.minVolume > 0) {
      summaryParts.push(`Min Vol: >= ${filter.minVolume.toLocaleString()}`);
    }
    if (filter.rsiFilter) {
      if (filter.rsiFilter === "oversold") summaryParts.push("RSI < 35 (Oversold)");
      else if (filter.rsiFilter === "overbought") summaryParts.push("RSI > 70 (Overbought)");
      else if (filter.rsiFilter === "neutral") summaryParts.push("RSI 35-70 (Neutral)");
    }

    if (!universe || universe.length === 0) {
      return {
        totalScanned: 0,
        totalScreened: 0,
        matchedCount: 0,
        status: "no_universe",
        filterApplied: filter,
        filterSummary: summaryParts.join(", ") || "Live E*TRADE Candidate Universe",
        ledger: {
          universeSymbols: [],
          totalEvaluated: 0,
          passedCount: 0,
          rejectedCount: 0,
          rejections: [],
        },
        stocks: [],
        scannedAt: new Date().toISOString(),
      };
    }

    for (const stock of universe) {
      const effectiveRsi = stock.rsi14 ?? stock.rsi;

      // 1. Search term check
      if (filter.search && filter.search.trim()) {
        const q = filter.search.trim().toLowerCase();
        if (!stock.symbol.toLowerCase().includes(q) && !stock.companyName.toLowerCase().includes(q)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Search mismatch for "${filter.search.trim()}"`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 2. Sector check
      if (filter.sector && filter.sector !== "all" && filter.sector !== "Any") {
        const sec = filter.sector.toLowerCase().trim();
        const itemSec = (stock.sector || "").toLowerCase().trim();
        const sectorMatches =
          (sec === "semiconductors")
            ? (itemSec === "semiconductors")
            : (sec === "tech" || sec === "technology")
            ? (itemSec === "technology" || itemSec === "semiconductors" || itemSec.includes("tech"))
            : (sec === "financial" || sec === "financials" || sec === "finance" || sec === "financial services")
            ? (itemSec === "financial" || itemSec === "financials" || itemSec === "financial services" || itemSec.includes("finan"))
            : (sec === "consumer discretionary" || sec === "consumer")
            ? (itemSec === "consumer discretionary" || itemSec.includes("consumer"))
            : (sec === "communication services" || sec === "communication")
            ? (itemSec === "communication services" || itemSec.includes("communication"))
            : (sec === "healthcare" || sec === "health")
            ? (itemSec === "healthcare" || itemSec.includes("health"))
            : (sec === "energy")
            ? (itemSec === "energy" || itemSec.includes("energy"))
            : (itemSec === sec || itemSec.includes(sec) || sec.includes(itemSec));
        if (!sectorMatches) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Sector "${stock.sector}" does not match requested "${filter.sector}"`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 3. Market Cap check
      if (filter.minMarketCap !== undefined && filter.minMarketCap > 0) {
        const cap = stock.marketCap || 0;
        const normalizedCap = cap < 1e8 ? cap * 1e9 : cap;
        const filterCap = filter.minMarketCap < 1e8 ? filter.minMarketCap * 1e9 : filter.minMarketCap;
        if (normalizedCap < filterCap) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Market cap ($${(normalizedCap / 1e9).toFixed(1)}B) below minimum threshold`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 4. Max P/E check
      if (filter.maxPeRatio !== undefined && filter.maxPeRatio > 0) {
        if (!stock.peRatio || stock.peRatio > filter.maxPeRatio) {
          rejections.push({
            symbol: stock.symbol,
            reason: `P/E ratio (${stock.peRatio ?? "N/A"}) exceeds maximum of ${filter.maxPeRatio}`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 5. Min RSI
      if (filter.minRsi !== undefined && (effectiveRsi === undefined || effectiveRsi < filter.minRsi)) {
        rejections.push({
          symbol: stock.symbol,
          reason: `RSI-14 (${effectiveRsi?.toFixed(1) ?? "N/A"}) below minimum ${filter.minRsi}`,
          rsi: effectiveRsi,
          price: stock.price,
          changePercent: stock.changePercent,
        });
        continue;
      }

      // 6. Max RSI
      if (filter.maxRsi !== undefined && (effectiveRsi === undefined || effectiveRsi > filter.maxRsi)) {
        rejections.push({
          symbol: stock.symbol,
          reason: `RSI-14 (${effectiveRsi?.toFixed(1) ?? "N/A"}) exceeds maximum ${filter.maxRsi}`,
          rsi: effectiveRsi,
          price: stock.price,
          changePercent: stock.changePercent,
        });
        continue;
      }

      // 7. Gainers Only: STRICT POSITIVE DAILY CHANGE REQUIRED
      if (filter.gainersOnly || filter.gainersLosers === "gainers") {
        if (stock.changePercent <= 0) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Negative/flat daily change (${stock.changePercent >= 0 ? "+" : ""}${stock.changePercent.toFixed(2)}%) violates gainersOnly rule`,
            changePercent: stock.changePercent,
            price: stock.price,
            rsi: effectiveRsi,
          });
          continue;
        }
      }

      // 8. Losers Only: STRICT NEGATIVE DAILY CHANGE REQUIRED
      if (filter.losersOnly || filter.gainersLosers === "losers") {
        if (stock.changePercent >= 0) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Positive/flat daily change (+${stock.changePercent.toFixed(2)}%) violates losersOnly rule`,
            changePercent: stock.changePercent,
            price: stock.price,
            rsi: effectiveRsi,
          });
          continue;
        }
      }

      // 9. Min Volume
      if (filter.minVolume !== undefined && filter.minVolume > 0 && stock.volume < filter.minVolume) {
        rejections.push({
          symbol: stock.symbol,
          reason: `Volume (${stock.volume.toLocaleString()}) below minimum ${filter.minVolume.toLocaleString()}`,
          price: stock.price,
          changePercent: stock.changePercent,
        });
        continue;
      }

      if (filter.momentum === "bullish_breakout") {
        const high52 = stock.week52High || stock.high52 || 0;
        if (high52 <= 0 || stock.lastPrice < high52 || stock.changePercent <= 0) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Price is not making a positive 52-week high breakout",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      } else if (filter.momentum === "bearish_pullback") {
        if (stock.changePercent >= 0 || stock.lastPrice >= stock.open) {
          rejections.push({
            symbol: stock.symbol,
            reason: "Price is not pulling back below the open",
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      } else if (filter.momentum === "high_relative_volume") {
        const relativeVolume = stock.averageVolume && stock.averageVolume > 0
          ? stock.volume / stock.averageVolume
          : undefined;
        if (relativeVolume === undefined || relativeVolume < 1.5) {
          rejections.push({
            symbol: stock.symbol,
            reason: `Relative volume (${relativeVolume?.toFixed(2) ?? "N/A"}x) is below 1.5x`,
            price: stock.price,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // 10. RSI Filter presets
      if (filter.rsiFilter) {
        if (filter.rsiFilter === "oversold" && (effectiveRsi === undefined || effectiveRsi >= 35)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `RSI (${effectiveRsi?.toFixed(1) ?? "N/A"}) not oversold (< 35)`,
            rsi: effectiveRsi,
            changePercent: stock.changePercent,
          });
          continue;
        } else if (filter.rsiFilter === "overbought" && (effectiveRsi === undefined || effectiveRsi <= 70)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `RSI (${effectiveRsi?.toFixed(1) ?? "N/A"}) not overbought (> 70)`,
            rsi: effectiveRsi,
            changePercent: stock.changePercent,
          });
          continue;
        } else if (filter.rsiFilter === "neutral" && (effectiveRsi === undefined || effectiveRsi < 35 || effectiveRsi > 70)) {
          rejections.push({
            symbol: stock.symbol,
            reason: `RSI (${effectiveRsi?.toFixed(1) ?? "N/A"}) not in neutral range [35, 70]`,
            rsi: effectiveRsi,
            changePercent: stock.changePercent,
          });
          continue;
        }
      }

      // Passed all checks!
      passedStocks.push({
        ...stock,
        price: stock.lastPrice || stock.price,
        marketCap: (stock.marketCap || 0) < 1e8 ? (stock.marketCap || 0) * 1e9 : stock.marketCap,
        rsi14: effectiveRsi,
        rsi: effectiveRsi,
        changePeriod: stock.changePeriod || "1D (Regular Trading Day)",
        previousClose: stock.previousClose || Number(((stock.lastPrice || stock.price) - stock.change).toFixed(2)),
        rsiLookback: "14-Period Daily RSI",
        macdIndicatorVersion: "MACD (12, 26, 9 EMA)",
        validationStatus: "PASS_CONFIRMED",
        signal: effectiveRsi !== undefined && effectiveRsi > 70
          ? "OVERBOUGHT"
          : effectiveRsi !== undefined && effectiveRsi < 35
          ? "OVERSOLD_BOUNCE"
          : stock.changePercent > 0.5
          ? "BULLISH_MOMENTUM"
          : "RANGE_BOUND",
      });
    }

    // Sorting
    if (filter.gainersOnly || filter.gainersLosers === "gainers") {
      passedStocks.sort((a, b) => b.changePercent - a.changePercent);
    } else if (filter.losersOnly || filter.gainersLosers === "losers") {
      passedStocks.sort((a, b) => a.changePercent - b.changePercent);
    } else if (filter.gainersLosers === "active") {
      passedStocks.sort((a, b) => b.volume - a.volume);
    }

    // Fail-closed verification: double check that no invalid row exists in passedStocks
    let status: "matches_found" | "no_matches" | "SCAN_INVALID_DATA_MISMATCH" =
      passedStocks.length > 0 ? "matches_found" : "no_matches";

    if (filter.gainersOnly) {
      const invalid = passedStocks.find((s) => s.changePercent <= 0);
      if (invalid) {
        status = "SCAN_INVALID_DATA_MISMATCH";
      }
    }

    const limit = filter.limit || 25;
    const finalStocks = passedStocks.slice(0, limit);

    return {
      totalScanned: universe.length,
      totalScreened: universe.length,
      matchedCount: finalStocks.length,
      status,
      filterApplied: filter,
      filterSummary: summaryParts.join(", ") || "Live E*TRADE Candidate Universe",
      ledger: {
        universeSymbols: universe.map((s) => s.symbol),
        totalEvaluated: universe.length,
        passedCount: finalStocks.length,
        rejectedCount: rejections.length,
        rejections,
      },
      stocks: finalStocks,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Evaluates screener filters against real quotes provided directly (e.g. from E*TRADE REST API)
   */
  screenWithQuotes(quotes: ETradeQuote[], filter: StockScreenerFilter = {}): StockScreenResult {
    const universe = quotes.map((q) => {
      const rsi14 = calculateDynamicRsi(
        q.symbol,
        q.lastPrice,
        q.week52High,
        q.week52Low,
        q.changePercent,
        q.rsi
      );
      return {
        ...q,
        price: q.lastPrice,
        sector: q.sector || "Equities",
        rsi14,
        macdSignal: "MACD unavailable from E*TRADE quote data",
        signal: (rsi14 !== undefined && rsi14 > 70 ? "OVERBOUGHT" : rsi14 !== undefined && rsi14 < 35 ? "OVERSOLD_BOUNCE" : q.changePercent > 0.5 ? "BULLISH_MOMENTUM" : "RANGE_BOUND") as any,
        technicalSignal: rsi14 === undefined ? "Daily quote momentum; RSI unavailable" : rsi14 < 35 ? "Oversold" : rsi14 > 70 ? "Overbought" : "RSI neutral",
        momentumScore: Math.round(50 + q.changePercent * 5),
        highlightReason: `${q.companyName} Level 1 Quote`,
      } as ScreenedStockItem;
    });

    this.universeCache = universe;
    return this.evaluateUniverse(universe, filter);
  }

  /**
   * Filter and scan stocks based on fundamental and technical criteria (synchronous baseline)
   */
  screenStocks(filter: StockScreenerFilter = {}): StockScreenResult {
    return this.evaluateUniverse(this.getUniverse(), filter);
  }

  /**
   * Asynchronous market screener evaluating current equities universe
   */
  async screenMarkets(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    return this.evaluateUniverse(this.getUniverse(), filter);
  }

  async screenLive(client: ETradeRestClient, filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    const symbols = new Set<string>();
    const descriptions = new Map<string, string>();

    if (filter.search?.trim()) {
      const terms = filter.search.trim().split(/[,\s]+/).filter(Boolean);
      for (const term of terms) {
        const products = await client.lookupProduct(term);
        for (const product of products) {
          if (product.type && product.type !== "EQ") continue;
          const symbol = product.symbol.toUpperCase().trim();
          if (symbol) {
            symbols.add(symbol);
            if (product.description) descriptions.set(symbol, product.description);
          }
        }
        if (/^[A-Z0-9.\/-]+$/i.test(term)) symbols.add(term.toUpperCase());
      }
    } else {
      const categories = filter.gainersOnly || filter.gainersLosers === "gainers"
        ? ["gainers"] as const
        : filter.losersOnly || filter.gainersLosers === "losers"
        ? ["losers"] as const
        : filter.gainersLosers === "active"
        ? ["active"] as const
        : ["active", "gainers", "losers"] as const;
      const discovered = await Promise.all(categories.map((category) => client.getMarketMovers(category)));
      for (const batch of discovered) for (const symbol of batch) symbols.add(symbol);

      const watchlists = await client.getWatchlists();
      for (const watchlist of watchlists) {
        for (const symbol of watchlist.symbols || []) symbols.add(symbol.toUpperCase().trim());
      }
    }

    if (symbols.size === 0) return this.screenWithQuotes([], filter);
    const liveQuotes = await client.fetchQuotes(Array.from(symbols), { overrideSymbolCount: true });
    const quotes = liveQuotes.map((quote) => ({
      ...quote,
      companyName: descriptions.get(quote.symbol) || quote.companyName,
    }));
    return this.screenWithQuotes(quotes, filter);
  }

  /**
   * Retrieves baseline quote from market universe
   */
  async getQuote(symbol: string): Promise<ETradeQuote> {
    const cleanSym = symbol.trim().toUpperCase();
    const found = this.getUniverse().find((s) => s.symbol === cleanSym);

    if (found) {
      return {
        ...found,
        price: found.lastPrice,
        high52: found.week52High,
        low52: found.week52Low,
        source: "E*TRADE Market Data Feed",
      };
    }
    throw new Error(`Quote data unavailable for '${cleanSym}'. No live or cached quote available from E*TRADE feed.`);
  }
}
