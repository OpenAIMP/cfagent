/**
 * Shared screener pipeline (issue #259).
 *
 * Single entry point for ALL stock screening — manual ("Run stock screen")
 * and scheduled (5-min autonomous). Reusability is a core architecture
 * tenet: trigger-specific code lives in the trigger (endpoint handler /
 * scheduled job); everything else — universe acquisition, screening,
 * result shaping — lives here, exactly once.
 *
 * Capability union (all preserved, none lost):
 * - Manual: full listings universe (6,629), user filters (search/limit/
 *   exchange/price-range/trend), unsupported-filter detection, discovery
 *   metadata, ledger.
 * - Scheduled: keyword-filtered symbols, E*TRADE-primary live quotes with
 *   per-symbol Nasdaq fallback + retries, standout detection, full scanned
 *   set with provenance, event publishing inputs.
 *
 * Both triggers already shared DynamicMarketScreener.evaluateUniverse
 * (via screenWithQuotes); this module unifies everything above it.
 */

import { DynamicMarketScreener, inferSectorFromCompanyName } from "./screener";
import {
  fetchTechnologySymbols,
  fetchLiveQuotes,
  withRetries,
  type LiveScreenerDeps,
} from "./liveScreener";
import { computeScreeningIndicators } from "./screeningIndicators";
import {
  computeFactorGrades,
  EMPTY_GRADES,
  type FactorGrades,
  type GradeableStock,
} from "./factorGrades";
import {
  fetchAllUsStockListings,
  type NasdaqStockListing,
} from "../services/nasdaqListings";
import {
  getCuratedStockListings,
  getCuratedStockUniverse,
  getCuratedStockBySymbol,
} from "../config/curatedStockUniverse";
import type {
  ETradeQuote,
  ScreenedStockItem,
  StockScreenerFilter,
  StockScreenResult,
} from "../types";

// ---------------------------------------------------------------------------
// Serializable shapes — single source of truth for every consumer
// (panel, retained runs, events, publishers).
// ---------------------------------------------------------------------------

/** One scanned symbol, JSON-safe. Superset of what the panel needs. */
/** Screening indicators (issue #261) — E*TRADE-honest, methodology-labeled. */
export interface ScreenedIndicators {
  sentiment: string;
  directional: boolean;
  rangeZone: string;
  valueZone: string;
  screenScore: number;
  intradayPosition: number | null;
  rangePosition: number | null;
  summary: string;
}

export interface ScannedStock {
  symbol: string;
  companyName: string;
  signal: string;
  momentumScore: number;
  lastPrice: number;
  changePercent: number;
  rsi14: number | null;
  source: string;
  indicators: ScreenedIndicators;
  /** SA-style factor grades (issue #266). Attached via attachFactorGrades. */
  factorGrades: FactorGrades;
  /** Grading inputs (not displayed). */
  peRatio?: number | null;
  sector?: string;
}

/** One standout opportunity, JSON-safe. */
export interface OpportunityStock {
  symbol: string;
  companyName: string;
  signal: string;
  momentumScore: number;
  lastPrice: number;
  changePercent: number;
  indicators: ScreenedIndicators;
  factorGrades: FactorGrades;
}

// ---------------------------------------------------------------------------
// Universe acquisition — the ONLY stage that varies by trigger.
// ---------------------------------------------------------------------------

export type UniverseMode = "all-listings" | "live-quotes" | "etrade-only";

export interface AcquireUniverseOptions {
  mode: UniverseMode;
  /** all-listings: exchange scope filter ("ALL" or exchange code). */
  exchange?: string;
  /** live-quotes / etrade-only: pre-filtered listings (default: tech-keyword filter). */
  symbols?: NasdaqStockListing[];
  /** live-quotes / etrade-only: cap on symbols quoted (default 50). */
  maxSymbols?: number;
  /** live-quotes / etrade-only: E*TRADE fetcher (required for these modes). */
  liveDeps?: LiveScreenerDeps;
}

export interface AcquiredUniverse {
  quotes: ETradeQuote[];
  discovery: {
    mode: "all_us_listings" | "live_quotes";
    candidateCount: number;
    listingCount: number;
    sourceCounts?: Record<string, number>;
    message: string;
    isCuratedUniverse?: boolean;
    error?: string;
  };
  /** Set when acquisition failed under a test fixture (screenLive parity). */
  error?: string;
}

/**
 * Acquire the screening universe. Manual uses all-listings; the scheduled
 * job uses live-quotes. Returns quotes ready for screenWithQuotes plus
 * discovery metadata for the UI.
 */
export async function acquireUniverse(
  opts: AcquireUniverseOptions
): Promise<AcquiredUniverse> {
  if (opts.mode === "live-quotes") {
    if (!opts.liveDeps) {
      throw new Error("live-quotes mode requires liveDeps.fetchETradeQuote");
    }
    const symbols =
      opts.symbols ?? (await fetchTechnologySymbols());
    const quotes = await fetchLiveQuotes(
      symbols,
      opts.liveDeps,
      opts.maxSymbols ?? 50
    );
    return {
      quotes,
      discovery: {
        mode: "live_quotes",
        candidateCount: symbols.length,
        listingCount: quotes.length,
        message: `E*TRADE-primary live quotes with Nasdaq fallback; ${quotes.length} of ${symbols.length} symbols quoted.`,
      },
    };
  }

  // Issue #261: etrade-only mode — market data comes from E*TRADE or
  // nothing. No Nasdaq fallback, no zero-filled substitute rows. If
  // E*TRADE cannot quote a symbol it is skipped; if it cannot quote
  // any, the screen fails honestly instead of presenting fake data.
  if (opts.mode === "etrade-only") {
    if (!opts.liveDeps) {
      throw new Error("etrade-only mode requires liveDeps.fetchETradeQuote");
    }
    const symbols = opts.symbols ?? (await fetchTechnologySymbols());
    const limited = symbols.slice(0, opts.maxSymbols ?? 50);
    const quotes: ETradeQuote[] = [];
    const failed: string[] = [];
    const CONCURRENCY = 10;
    for (let i = 0; i < limited.length; i += CONCURRENCY) {
      const batch = limited.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (listing) => {
          const live = await withRetries(
            () => opts.liveDeps!.fetchETradeQuote(listing.symbol),
            "E*TRADE",
            listing.symbol
          );
          if (!live || !(live.lastPrice > 0)) {
            throw new Error(`E*TRADE returned no quote for ${listing.symbol}`);
          }
          return {
            ...live,
            symbol: listing.symbol,
            companyName: live.companyName || listing.companyName,
            source: "E*TRADE live",
            quoteStatus: "LIVE",
          } as ETradeQuote;
        })
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled") quotes.push(r.value);
        else failed.push(batch[j].symbol);
      }
    }
    if (quotes.length === 0) {
      throw new Error(
        `E*TRADE unavailable: no live quotes returned for ${limited.length} symbols` +
          (failed.length > 0 ? ` (failed: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : "") +
          ". No fallback data substituted."
      );
    }
    return {
      quotes,
      discovery: {
        mode: "live_quotes",
        candidateCount: symbols.length,
        listingCount: quotes.length,
        message:
          `E*TRADE-only live quotes; ${quotes.length} of ${limited.length} symbols quoted` +
          (failed.length > 0 ? ` (${failed.length} failed, no fallback substituted)` : "") +
          ".",
      },
    };
  }

  // all-listings mode (extracted from DynamicMarketScreener.screenLive —
  // behavior preserved exactly, including test fixture + curated fallback).
  const sourceCounts: Record<string, number> = {};
  let listings: NasdaqStockListing[];
  try {
    listings =
      DynamicMarketScreener.getTestListingsFixture() ??
      (await fetchAllUsStockListings());
    if (
      !DynamicMarketScreener.getTestListingsFixture() &&
      (!listings || listings.length === 0)
    ) {
      listings = getCuratedStockListings();
    }
  } catch (error) {
    if (
      DynamicMarketScreener.getTestListingsFixture() !== null &&
      DynamicMarketScreener.getTestListingsFixture() !== undefined
    ) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        quotes: [],
        discovery: {
          mode: "all_us_listings",
          candidateCount: 0,
          listingCount: 0,
          sourceCounts,
          message: `Dynamic all-exchange listing request failed: ${message}`,
          error: message,
        },
        error: message,
      };
    }
    listings = getCuratedStockListings();
  }

  for (const listing of listings)
    sourceCounts[listing.exchange] = (sourceCounts[listing.exchange] || 0) + 1;
  sourceCounts.uniqueListings = listings.length;
  let selectedListings =
    opts.exchange && opts.exchange !== "ALL"
      ? listings.filter(
          (listing) => listing.exchange.toUpperCase() === opts.exchange
        )
      : listings;
  if (
    selectedListings.length === 0 &&
    !DynamicMarketScreener.getTestListingsFixture()
  ) {
    selectedListings = listings;
  }
  sourceCounts.selectedListings = selectedListings.length;
  if (selectedListings.length === 0) {
    // Valid empty result (not a failure): screenLive returns the discovery
    // message with an empty screen. No top-level error set.
    const message =
      listings.length === 0
        ? "Dynamic all-exchange listing request returned no rows from Nasdaq, NYSE, or AMEX."
        : `No dynamic listings were returned for ${opts.exchange}; ${listings.length.toLocaleString()} rows were loaded across all exchanges.`;
    return {
      quotes: [],
      discovery: {
        mode: "all_us_listings",
        candidateCount: 0,
        listingCount: 0,
        sourceCounts,
        message,
      },
    };
  }

  const isCuratedUniverse =
    !DynamicMarketScreener.getTestListingsFixture() &&
    listings.length === getCuratedStockUniverse().length;
  const quotes: ETradeQuote[] = selectedListings.map((listing) => {
    const curated = getCuratedStockBySymbol(listing.symbol);
    const sector =
      curated?.sector ||
      inferSectorFromCompanyName(listing.companyName) ||
      "Equities";
    return {
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
      sector,
      quoteStatus: "AS_OF_UNKNOWN",
      source: isCuratedUniverse
        ? "Curated externalized stock universe (Nasdaq, NYSE, AMEX)"
        : "Nasdaq all-exchange stock listings (source quote time unavailable)",
      timestamp: "",
    };
  });

  const message = isCuratedUniverse
    ? `Loaded ${listings.length.toLocaleString()} curated listings from externalized universe across Nasdaq, NYSE, and AMEX; ${selectedListings.length.toLocaleString()} are in the selected exchange scope. Applied the remaining supported filters.`
    : `Loaded ${listings.length.toLocaleString()} current listings from Nasdaq, NYSE, and AMEX; ${selectedListings.length.toLocaleString()} are in the selected exchange scope. Applied the remaining supported filters. Source quote timestamps are unavailable.`;

  return {
    quotes,
    discovery: {
      mode: "all_us_listings",
      candidateCount: selectedListings.length,
      listingCount: quotes.length,
      sourceCounts,
      message,
      isCuratedUniverse,
    },
  };
}

// ---------------------------------------------------------------------------
// Screening — shared by both triggers.
// ---------------------------------------------------------------------------

export function screenUniverse(
  screener: DynamicMarketScreener,
  acquired: AcquiredUniverse,
  filter: StockScreenerFilter = {}
): StockScreenResult {
  return screener.screenWithQuotes(acquired.quotes, filter, false);
}

// ---------------------------------------------------------------------------
// Result shaping — single implementations, used by every consumer.
// ---------------------------------------------------------------------------

/**
 * Map one quote (+ optional screened fields) to the serializable shape.
 * The ONLY place this mapping lives.
 */
export function toScannedStock(
  quote: Pick<
    ETradeQuote,
    | "symbol"
    | "companyName"
    | "lastPrice"
    | "changePercent"
    | "source"
    | "open"
    | "high"
    | "low"
    | "week52High"
    | "week52Low"
    | "peRatio"
    | "volume"
    | "averageVolume"
    | "sector"
  >,
  screened?: Pick<ScreenedStockItem, "signal" | "momentumScore" | "rsi14"> | null
): ScannedStock {
  const ind = computeScreeningIndicators({
    lastPrice: quote.lastPrice || 0,
    changePercent: quote.changePercent || 0,
    open: quote.open || 0,
    high: quote.high || 0,
    low: quote.low || 0,
    week52High: quote.week52High || 0,
    week52Low: quote.week52Low || 0,
    peRatio: quote.peRatio,
    volume: quote.volume || 0,
    averageVolume: quote.averageVolume,
  });
  return {
    symbol: quote.symbol,
    companyName: quote.companyName || quote.symbol,
    signal: screened?.signal || "unknown",
    momentumScore: screened?.momentumScore ?? 0,
    lastPrice: quote.lastPrice || 0,
    changePercent: quote.changePercent || 0,
    rsi14: screened?.rsi14 ?? null,
    source: quote.source || "unknown",
    indicators: {
      sentiment: ind.sentiment,
      directional: ind.directional,
      rangeZone: ind.rangeZone,
      valueZone: ind.valueZone,
      screenScore: ind.screenScore,
      intradayPosition: ind.intradayPosition,
      rangePosition: ind.rangePosition,
      summary: ind.summary,
    },
    // Issue #266: default grades; attachFactorGrades() replaces with the
    // universe-relative computation.
    factorGrades: EMPTY_GRADES,
    peRatio: quote.peRatio ?? null,
    sector: quote.sector,
  };
}

/**
 * Attach SA-style factor grades (issue #266), computed percentile-relative
 * across the given universe. Returns new objects; input is not mutated.
 */
export function attachFactorGrades(stocks: ScannedStock[]): ScannedStock[] {
  const gradeable: GradeableStock[] = stocks.map((s) => ({
    symbol: s.symbol,
    sector: s.sector,
    peRatio: s.peRatio ?? null,
    rangePosition: s.indicators.rangePosition,
    changePercent: s.changePercent,
    intradayPosition: s.indicators.intradayPosition,
    screenScore: s.indicators.screenScore,
  }));
  const grades = computeFactorGrades(gradeable);
  return stocks.map((s) => ({
    ...s,
    factorGrades: grades.get(s.symbol) ?? EMPTY_GRADES,
  }));
}

/** Map one screened stock to the opportunity shape. The ONLY place. */
export function toOpportunityStock(s: ScreenedStockItem): OpportunityStock {
  const scanned = toScannedStock(
    {
      symbol: s.symbol,
      companyName: s.companyName,
      lastPrice: s.lastPrice,
      changePercent: s.changePercent,
      source: (s as any).source,
      open: (s as any).open ?? 0,
      high: (s as any).high ?? 0,
      low: (s as any).low ?? 0,
      week52High: (s as any).week52High ?? 0,
      week52Low: (s as any).week52Low ?? 0,
      peRatio: (s as any).peRatio,
      volume: (s as any).volume ?? 0,
      averageVolume: (s as any).averageVolume,
      sector: (s as any).sector,
    },
    s
  );
  return {
    symbol: scanned.symbol,
    companyName: scanned.companyName,
    signal: scanned.signal,
    momentumScore: scanned.momentumScore,
    lastPrice: scanned.lastPrice,
    changePercent: scanned.changePercent,
    indicators: scanned.indicators,
    factorGrades: scanned.factorGrades,
  };
}

/**
 * Standout filter — the ONLY place this predicate lives.
 * (OVERSOLD_BOUNCE / BULLISH_MOMENTUM / momentumScore >= 60, top N.)
 */
export function selectStandouts(
  stocks: ScreenedStockItem[],
  maxItems = 5
): ScreenedStockItem[] {
  return stocks
    .filter(
      (s) =>
        s.signal === "OVERSOLD_BOUNCE" ||
        s.signal === "BULLISH_MOMENTUM" ||
        s.momentumScore >= 60
    )
    .slice(0, maxItems);
}

/**
 * Full scanned set: every acquired quote, enriched with screened fields
 * where the symbol survived filtering. Backs the panel's "all scanned"
 * table (#253).
 */
export function buildAllStocks(
  quotes: ETradeQuote[],
  screened: ScreenedStockItem[]
): ScannedStock[] {
  const screenedBySymbol = new Map(screened.map((s) => [s.symbol, s]));
  return quotes.map((q) => toScannedStock(q, screenedBySymbol.get(q.symbol) ?? null));
}
