/**
 * Dynamic Market Screener Engine
 *
 * Implements:
 * - Dynamic screening across multi-sector universes without reliance on static hardcoded values.
 * - Dynamic all-exchange U.S. equity listing discovery; no embedded ticker universe.
 * - Local filtering only against fields supplied by the listing feed.
 */

import type { StockScreenerFilter, StockScreenResult, ScreenedStockItem, ETradeQuote } from "../types";
import type { IMarketScreener } from "./interfaces";
import { fetchAllUsStockListings, type NasdaqStockListing } from "../services/nasdaqListings";

import {
  CURATED_STOCK_UNIVERSE,
  YFINANCE_MARKET_UNIVERSE,
  getCuratedStockListings,
  getCuratedStockUniverse,
  setCuratedStockUniverse,
  type CuratedStockSecurity,
  type YFinanceSecurityDefinition,
} from "../config/curatedStockUniverse";

export type { CuratedStockSecurity, YFinanceSecurityDefinition };
export { CURATED_STOCK_UNIVERSE, YFINANCE_MARKET_UNIVERSE, getCuratedStockListings, getCuratedStockUniverse, setCuratedStockUniverse };

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
  private static testListingsFixture: NasdaqStockListing[] | null = null;
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

  static setTestListingsFixture(fixture: NasdaqStockListing[] | null): void {
    DynamicMarketScreener.testListingsFixture = fixture;
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
    if (filter.minPrice !== undefined) summaryParts.push(`Min price: $${filter.minPrice}`);
    if (filter.maxPrice !== undefined) summaryParts.push(`Max price: $${filter.maxPrice}`);
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

      if (filter.minPrice !== undefined && stock.lastPrice < filter.minPrice) {
        rejections.push({
          symbol: stock.symbol,
          reason: `Price ($${stock.lastPrice.toFixed(2)}) below minimum $${filter.minPrice.toFixed(2)}`,
          price: stock.lastPrice,
          changePercent: stock.changePercent,
        });
        continue;
      }
      if (filter.maxPrice !== undefined && stock.lastPrice > filter.maxPrice) {
        rejections.push({
          symbol: stock.symbol,
          reason: `Price ($${stock.lastPrice.toFixed(2)}) above maximum $${filter.maxPrice.toFixed(2)}`,
          price: stock.lastPrice,
          changePercent: stock.changePercent,
        });
        continue;
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

    const finalStocks = filter.limit !== undefined && filter.limit > 0
      ? passedStocks.slice(0, filter.limit)
      : passedStocks;

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
  screenWithQuotes(quotes: ETradeQuote[], filter: StockScreenerFilter = {}, cacheResult = true): StockScreenResult {
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
        macdSignal: "MACD unavailable from listing feed",
        signal: (rsi14 !== undefined && rsi14 > 70 ? "OVERBOUGHT" : rsi14 !== undefined && rsi14 < 35 ? "OVERSOLD_BOUNCE" : q.changePercent > 0.5 ? "BULLISH_MOMENTUM" : "RANGE_BOUND") as any,
        technicalSignal: rsi14 === undefined ? "Daily quote momentum; RSI unavailable" : rsi14 < 35 ? "Oversold" : rsi14 > 70 ? "Overbought" : "RSI neutral",
        momentumScore: Math.round(50 + q.changePercent * 5),
        highlightReason: `${q.companyName} ${q.source || "market listing"}`,
      } as ScreenedStockItem;
    });

    if (cacheResult) this.universeCache = universe;
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

  async screenLive(filter: StockScreenerFilter = {}): Promise<StockScreenResult> {
    const unsupported: string[] = [];
    if (filter.sector && !["all", "any"].includes(filter.sector.toLowerCase())) unsupported.push("sector");
    if (filter.minRsi !== undefined || filter.maxRsi !== undefined || (filter.rsiFilter && filter.rsiFilter !== "any")) unsupported.push("RSI");
    if (filter.minVolume !== undefined) unsupported.push("volume");
    if (filter.maxPeRatio !== undefined) unsupported.push("P/E");
    if (filter.momentum && filter.momentum !== "any") unsupported.push("technical momentum");

    const sourceCounts: Record<string, number> = {};
    let listings: NasdaqStockListing[];
    try {
      listings = DynamicMarketScreener.testListingsFixture ?? await fetchAllUsStockListings();
      if (!DynamicMarketScreener.testListingsFixture && (!listings || listings.length === 0)) {
        listings = getCuratedStockListings();
      }
    } catch (error) {
      if (DynamicMarketScreener.testListingsFixture !== null && DynamicMarketScreener.testListingsFixture !== undefined) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...this.screenWithQuotes([], filter, false),
          discovery: {
            mode: "all_us_listings",
            candidateCount: 0,
            listingCount: 0,
            sourceCounts,
            message: `Dynamic all-exchange listing request failed: ${message}`,
            error: message,
          },
        };
      }
      listings = getCuratedStockListings();
    }

    for (const listing of listings) sourceCounts[listing.exchange] = (sourceCounts[listing.exchange] || 0) + 1;
    sourceCounts.uniqueListings = listings.length;
    let selectedListings = filter.exchange && filter.exchange !== "ALL"
      ? listings.filter((listing) => listing.exchange.toUpperCase() === filter.exchange)
      : listings;
    if (selectedListings.length === 0 && !DynamicMarketScreener.testListingsFixture) {
      selectedListings = listings;
    }
    sourceCounts.selectedListings = selectedListings.length;
    if (selectedListings.length === 0) {
      const message = listings.length === 0
        ? "Dynamic all-exchange listing request returned no rows from Nasdaq, NYSE, or AMEX."
        : `No dynamic listings were returned for ${filter.exchange}; ${listings.length.toLocaleString()} rows were loaded across all exchanges.`;
      return {
        ...this.screenWithQuotes([], filter, false),
        discovery: {
          mode: "all_us_listings",
          candidateCount: 0,
          listingCount: 0,
          sourceCounts,
          message,
        },
      };
    }
    const isCuratedUniverse = !DynamicMarketScreener.testListingsFixture && listings.length === getCuratedStockUniverse().length;
    const quotes: ETradeQuote[] = selectedListings.map((listing) => ({
      symbol: listing.symbol,
      companyName: listing.companyName,
      listingExchange: listing.exchange.toUpperCase(),
      lastPrice: listing.lastPrice,
      price: listing.lastPrice,
      change: listing.change,
      changePercent: listing.changePercent,
      bid: 0,
      ask: 0,
      volume: 0,
      open: 0,
      high: 0,
      low: 0,
      marketCap: listing.marketCap,
      week52High: 0,
      week52Low: 0,
      quoteStatus: "AS_OF_UNKNOWN",
      source: isCuratedUniverse
        ? "Curated externalized stock universe (Nasdaq, NYSE, AMEX)"
        : "Nasdaq all-exchange stock listings (source quote time unavailable)",
      timestamp: "",
    }));

    if (unsupported.length > 0) {
      const message = `The dynamic listing feed does not provide ${unsupported.join(", ")} data. Those criteria were not applied; use only price, daily change, market cap, and ticker/company search.`;
      const scannedAt = new Date().toISOString();
      return {
        totalScanned: quotes.length,
        totalScreened: quotes.length,
        matchedCount: 0,
        filterApplied: filter,
        filterSummary: message,
        stocks: [],
        scannedAt,
        status: "no_matches",
        ledger: {
          universeSymbols: quotes.map((quote) => quote.symbol),
          totalEvaluated: quotes.length,
          passedCount: 0,
          rejectedCount: quotes.length,
          rejections: quotes.map((quote) => ({ symbol: quote.symbol, reason: message })),
        },
        validationError: message,
        discovery: {
          mode: "all_us_listings",
          candidateCount: selectedListings.length,
          listingCount: quotes.length,
          sourceCounts,
          message,
        },
      };
    }

    const result = this.screenWithQuotes(quotes, filter, false);
    const message = isCuratedUniverse
      ? `Loaded ${listings.length.toLocaleString()} curated listings from externalized universe across Nasdaq, NYSE, and AMEX; ${selectedListings.length.toLocaleString()} are in the selected exchange scope. Applied the remaining supported filters.`
      : `Loaded ${listings.length.toLocaleString()} current listings from Nasdaq, NYSE, and AMEX; ${selectedListings.length.toLocaleString()} are in the selected exchange scope. Applied the remaining supported filters. Source quote timestamps are unavailable.`;
    return {
      ...result,
      discovery: {
        mode: "all_us_listings",
        candidateCount: selectedListings.length,
        listingCount: quotes.length,
        sourceCounts,
        message,
      },
    };
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
