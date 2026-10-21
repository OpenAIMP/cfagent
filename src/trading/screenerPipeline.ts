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
import { DEFAULT_SCREENER_CONFIG, type ScreenerConfig } from "./screenerConfig";
import type { YahooTechnicals } from "./yahooHistory";
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

/** Yahoo-complement technicals (issue #269) — real RSI/MACD/gaps from history. */
export interface StockTechnicals {
  rsi14: number | null;
  macdLine: number | null;
  macdSignalLine: number | null;
  macdHistogram: number | null;
  macdSignal: string | null;
  gapPercent: number | null;
  gapDirection: "up" | "down" | "flat" | null;
  historyBars: number;
  historySource: string | null;
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
  /** Yahoo technicals (issue #269). Attached via attachTechnicals. */
  technicals: StockTechnicals;
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
  technicals: StockTechnicals;
}

// ---------------------------------------------------------------------------
// Universe acquisition — the ONLY stage that varies by trigger.
// ---------------------------------------------------------------------------

export type UniverseMode = "all-listings" | "live-quotes" | "etrade-only";

export interface AcquireUniverseOptions {
  mode: UniverseMode;
  /** Tunables (defaults to DEFAULT_SCREENER_CONFIG). */
  config?: ScreenerConfig;
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
  /**
   * Issue #462: set when E*TRADE quoted only part of the requested universe.
   * The pipeline returns the successful quotes and the screen runs on them;
   * the result is published as a *qualified partial* report (never as a
   * complete screen, and never as a failure). No fallback data is substituted.
   */
  partial?: PartialQuoteQualification;
  /** Set when acquisition failed under a test fixture (screenLive parity). */
  error?: string;
}

/**
 * Issue #462: qualification metadata for a screen run on an incomplete
 * quote set. Carried on AcquiredUniverse -> ScreenerRunResult ->
 * ScreenerCompletedEvent -> PDF/publishers so every delivery shows the
 * qualification prominently.
 */
export interface PartialQuoteQualification {
  /** Symbols successfully quoted (the subset the screen ran on). */
  quotedCount: number;
  /** Symbols requested from the universe (the full target). */
  requestedCount: number;
  /** Symbols that failed to quote (no fallback substituted). */
  failedSymbols: string[];
  /** Categorized failure counts (e.g. { other: 53 }). */
  failureReasons: Record<string, number>;
  /** Up to 3 redacted failure samples for diagnostics. */
  failureSamples: string[];
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
    const cfg = opts.config ?? DEFAULT_SCREENER_CONFIG;
    const quotes = await fetchLiveQuotes(
      symbols,
      opts.liveDeps,
      opts.maxSymbols ?? cfg.acquisition.defaultMaxSymbols
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
  // Categorize an E*TRADE quote failure for diagnostics.
  function categorizeQuoteFailure(reason: unknown): string {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const lower = msg.toLowerCase();
    if (lower.includes("rate") || lower.includes("429") || lower.includes("throttl")) {
      return "rate-limited";
    }
    // Cloudflare Workers cap subrequests per invocation. Batch acquisition
    // exists to stay under that cap; a run that still exceeds it must say so
    // instead of reporting a broker outage.
    if (lower.includes("too many subrequests") || lower.includes("subrequest")) {
      return "request-budget";
    }
    if (
      lower.includes("auth") ||
      lower.includes("oauth") ||
      lower.includes("signature") ||
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("token")
    ) {
      return "auth";
    }
    if (lower.includes("null-response")) {
      return "api-empty-response";
    }
    if (lower.includes("http 200 empty response") || lower.includes("returned no quote data")) {
      return "api-empty-response";
    }
    if (lower.includes("zero-price")) {
      return "api-zero-price";
    }
    // Issue #462: the E*TRADE client's actual error strings (previously
    // unrecognized, so every one of these landed in "other"):
    // "contained no positive trade or bid price" is E*TRADE's zero-price.
    if (lower.includes("no positive trade or bid price")) {
      return "api-zero-price";
    }
    // "Quote API Error [HTTP <n>]" with 5xx is an upstream E*TRADE failure
    // (4xx statuses are caught above by their digits: 401/403 → auth,
    // 429 → rate-limited).
    const httpStatus = lower.match(/quote api error \[http (\d{3})\]/);
    if (httpStatus) {
      return Number(httpStatus[1]) >= 500 ? "api-http-5xx" : "api-http-error";
    }
    if (lower.includes("symbol mismatch") || lower.includes("mismatched sandbox quote")) {
      return "symbol-mismatch";
    }
    if (lower.includes("batch quote omitted")) {
      return "batch-omitted";
    }
    if (
      lower.includes("no live quote") ||
      lower.includes("no quote") ||
      lower.includes("not found") ||
      lower.includes("invalid symbol")
    ) {
      return "symbol-not-quotable";
    }
    if (lower.includes("timeout") || lower.includes("econnreset") || lower.includes("network")) {
      return "network";
    }
    return "other";
  }

  // Keep enough upstream detail to diagnose a failed quote run while
  // preventing credentials or OAuth signing material from entering logs and
  // user-visible errors.
  function safeQuoteFailure(reason: unknown): string {
    const message = reason instanceof Error ? reason.message : String(reason);
    return message
      .replace(/\b(oauth_(?:token|token_secret|signature|consumer_key|consumer_secret))=[^\s&,]+/gi, "$1=[redacted]")
      .replace(/\b(accessToken|accessTokenSecret|consumerSecret|tokenSecret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 180);
  }

  // E*TRADE cannot quote a symbol it is skipped; if it cannot quote
  // any, the screen fails honestly instead of presenting fake data.
  if (opts.mode === "etrade-only") {
    if (!opts.liveDeps) {
      throw new Error("etrade-only mode requires liveDeps.fetchETradeQuote");
    }
    const cfg = opts.config ?? DEFAULT_SCREENER_CONFIG;
    const symbols = opts.symbols ?? (await fetchTechnologySymbols());
    const maxSymbols = opts.maxSymbols ?? cfg.acquisition.defaultMaxSymbols;
    const limited = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
    if (limited.length === 0) {
      throw new Error("The selected live universe contains no listings; no static symbols were substituted.");
    }
    const quotes: ETradeQuote[] = [];
    const quotedSymbols = new Set<string>();
    const failed: string[] = [];
    // Categorized failure reasons for diagnostics (issue: stuck-at-6).
    const failureReasons: Record<string, number> = {};
    const failureSamples: string[] = [];
    // Last error seen for a symbol: batch-pass omission first, then the
    // per-symbol retry result (which is the more specific one).
    const quoteErrors = new Map<string, unknown>();
    const listingsBySymbol = new Map(
      limited.map((listing) => [listing.symbol.toUpperCase(), listing])
    );
    // Lower concurrency + pacing: E*TRADE rate-limits rapid quote bursts.
    const CONCURRENCY = Math.min(cfg.acquisition.quoteConcurrency, 5);
    const BATCH_PAUSE_MS = 500;

    const acceptQuote = (
      listing: NasdaqStockListing,
      live: ETradeQuote | null
    ): boolean => {
      if (!live || !(live.lastPrice > 0)) return false;
      if (quotedSymbols.has(listing.symbol.toUpperCase())) return true;
      quotes.push({
        ...live,
        symbol: listing.symbol,
        companyName: live.companyName || listing.companyName,
        // E*TRADE quote payloads do not reliably include sector. The
        // dynamically fetched Nasdaq listing row does, so preserve that
        // classification for sector filtering without a static symbol map.
        sector: live.sector || listing.sector,
        source: "E*TRADE live",
        quoteStatus: "LIVE",
      } as ETradeQuote);
      quotedSymbols.add(listing.symbol.toUpperCase());
      return true;
    };

    // Issue #495: ask E*TRADE for the universe in batches. One request per
    // symbol (100 calls for NASDAQ100, each retried) exhausted the Worker
    // subrequest budget and E*TRADE's quote rate limit, so 53 of 100 symbols
    // failed with a generic "no live quote" and the run died with 47 quotes.
    // The quote endpoint takes a symbol list: a 100-symbol screen is two
    // requests, and per-symbol calls are kept for the stragglers only.
    const batchSize = Math.max(1, cfg.acquisition.quoteBatchSize);
    if (opts.liveDeps.fetchETradeQuotes) {
      const requestedSymbols = limited.map((listing) => listing.symbol);
      for (let i = 0; i < requestedSymbols.length; i += batchSize) {
        const chunk = requestedSymbols.slice(i, i + batchSize);
        try {
          const batchQuotes = await withRetries(
            () => opts.liveDeps!.fetchETradeQuotes!(chunk),
            "E*TRADE batch quote"
          );
          const bySymbol = new Map(
            batchQuotes.map((quote) => [
              String(quote.symbol || "").toUpperCase(),
              quote,
            ])
          );
          for (const symbol of chunk) {
            const listing = listingsBySymbol.get(symbol.toUpperCase());
            const live = bySymbol.get(symbol.toUpperCase());
            if (!listing) continue;
            if (!live) {
              quoteErrors.set(
                symbol,
                new Error(`E*TRADE batch quote omitted ${symbol}`)
              );
            } else if (!acceptQuote(listing, live)) {
              quoteErrors.set(
                symbol,
                new Error(`E*TRADE returned zero-price quote for ${symbol}`)
              );
            }
          }
        } catch (err) {
          // Whole-batch failure: remember it per symbol, then let the
          // per-symbol pass produce the specific error where affordable.
          for (const symbol of chunk) quoteErrors.set(symbol, err);
        }
        // Pace batches to stay under E*TRADE rate limits.
        if (i + batchSize < requestedSymbols.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
        }
      }
    }

    // Per-symbol pass: covers brokers without a batch fetcher and symbols a
    // successful batch omitted. Bounded by maxIndividualQuoteRetries so a
    // broker-wide outage cannot turn one screen into hundreds of requests.
    const missingSymbols = limited
      .map((listing) => listing.symbol)
      .filter((symbol) => !quotedSymbols.has(symbol.toUpperCase()));
    const retryBudget = Math.max(0, cfg.acquisition.maxIndividualQuoteRetries);
    const retrySymbols = missingSymbols.slice(0, retryBudget);
    for (let i = 0; i < retrySymbols.length; i += CONCURRENCY) {
      const batch = retrySymbols.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          const live = await withRetries(
            () => opts.liveDeps!.fetchETradeQuote(symbol),
            "E*TRADE",
            symbol
          );
          if (!live || !(live.lastPrice > 0)) {
            // Preserve the underlying state for diagnostics: distinguish
            // null (API returned nothing) from zero-price (empty quote).
            const detail = !live ? "null-response" : `zero-price(lastPrice=${live.lastPrice})`;
            throw new Error(`E*TRADE returned no quote for ${symbol} [${detail}]`);
          }
          return { symbol, live };
        })
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled") {
          const listing = listingsBySymbol.get(batch[j].toUpperCase());
          if (listing) acceptQuote(listing, r.value.live);
        } else {
          quoteErrors.set(batch[j], r.reason);
        }
      }
      // Pace batches to stay under E*TRADE rate limits.
      if (i + CONCURRENCY < retrySymbols.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    for (const symbol of limited.map((listing) => listing.symbol)) {
      if (quotedSymbols.has(symbol.toUpperCase())) continue;
      failed.push(symbol);
      const reason =
        quoteErrors.get(symbol) ??
        new Error(`E*TRADE returned no quote for ${symbol} [null-response]`);
      const category = categorizeQuoteFailure(reason);
      failureReasons[category] = (failureReasons[category] ?? 0) + 1;
      if (failureSamples.length < 3) {
        failureSamples.push(`${symbol}: ${category} (${safeQuoteFailure(reason)})`);
      }
    }
    if (failed.length > 0) {
      console.warn(
        `[screenerPipeline] E*TRADE quote failures: ${failed.length}/${limited.length}. ` +
          `Reasons: ${JSON.stringify(failureReasons)}. Samples: ${failureSamples.join("; ")}`
      );
    }
    const reasonSummary = Object.entries(failureReasons)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(", ");
    if (quotes.length === 0 && failed.length > 0) {
      // Issue #462: with zero quotes there is no screen to qualify — fail
      // honestly with the full diagnostics. (A partial set, by contrast,
      // returns qualified results below instead of failing.)
      // Issue #902/#907: if ANY auth failures occurred and no quotes were
      // returned, the root cause is auth (batch-omitted are secondary to the
      // auth failure). Throw BusinessError with AUTH_002 instead of the
      // technical "OAuth access token is missing".
      const authFailures = failureReasons["auth"] ?? 0;
      if (authFailures > 0) {
        const { BusinessError } = await import("../errors/errorAspects");
        throw new BusinessError("AUTH_002", { failedCount: failed.length, authFailures });
      }
      throw new Error(
        `E*TRADE unavailable: no live quotes returned (${quotes.length} of ${limited.length} symbols quoted` +
          (failed.length > 0 ? ` (failed: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""})` : "") +
          (reasonSummary ? ` (failure reasons: ${reasonSummary})` : "") +
          (failureSamples.length > 0 ? ` (diagnostics: ${failureSamples.join("; ")})` : "") +
          `). No fallback data substituted.`
      );
    }
    const partial: PartialQuoteQualification | undefined =
      failed.length > 0
        ? {
            quotedCount: quotes.length,
            requestedCount: limited.length,
            failedSymbols: failed,
            failureReasons,
            failureSamples,
          }
        : undefined;
    return {
      quotes,
      ...(partial ? { partial } : {}),
      discovery: {
        mode: "live_quotes",
        candidateCount: symbols.length,
        listingCount: quotes.length,
        message: partial
          ? `Partial screen — qualified results: E*TRADE quoted ${quotes.length} of ${limited.length} symbols ` +
            `(${failed.length} unavailable: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}` +
            (reasonSummary ? `; failure reasons: ${reasonSummary}` : "") +
            `). Screen ran on the quoted subset only; no fallback data substituted.`
          : `E*TRADE-only live quotes; ${quotes.length} of ${limited.length} symbols quoted.`,
      },
    };
  }

  // all-listings mode. Production membership always comes from the live
  // listings directory; test fixtures are only used by explicit tests.
  const sourceCounts: Record<string, number> = {};
  let listings: NasdaqStockListing[];
  try {
    listings =
      DynamicMarketScreener.getTestListingsFixture() ??
      (await fetchAllUsStockListings());
    if (!DynamicMarketScreener.getTestListingsFixture() && (!listings || listings.length === 0)) {
      throw new Error("The live listings directory returned no symbols; no static universe was substituted.");
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
    const message = error instanceof Error ? error.message : String(error);
    return {
      quotes: [],
      discovery: {
        mode: "all_us_listings",
        candidateCount: 0,
        listingCount: 0,
        sourceCounts,
        message: `Dynamic all-exchange listing request failed: ${message}; no static universe was substituted.`,
        error: message,
      },
      error: message,
    };
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
  // This non-E*TRADE discovery view displays the listings feed's last sale as
  // its price. Keep symbol-only rows for universe resolution elsewhere, but do
  // not render a made-up zero-price quote in this view.
  selectedListings = selectedListings.filter(
    (listing) => typeof listing.lastPrice === "number" && listing.lastPrice > 0
  );
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

  const quotes: ETradeQuote[] = selectedListings.map((listing) => {
    const listingPrice = listing.lastPrice!; // selectedListings excludes missing last-sale values above
    const sector =
      listing.sector ||
      inferSectorFromCompanyName(listing.companyName) ||
      "Equities";
    return {
      symbol: listing.symbol,
      companyName: listing.companyName,
      listingExchange: listing.exchange.toUpperCase(),
      lastPrice: listingPrice,
      price: listingPrice,
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
      source: "Nasdaq all-exchange stock listings (source quote time unavailable)",
      timestamp: "",
    };
  });

  const message = `Loaded ${listings.length.toLocaleString()} current listings from Nasdaq, NYSE, and AMEX; ${selectedListings.length.toLocaleString()} are in the selected exchange scope. Applied the remaining supported filters. Source quote timestamps are unavailable.`;

  return {
    quotes,
    discovery: {
      mode: "all_us_listings",
      candidateCount: selectedListings.length,
      listingCount: quotes.length,
      sourceCounts,
      message,
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
    // Issue #269: default technicals; attachTechnicals() fills from Yahoo.
    technicals: EMPTY_TECHNICALS,
    peRatio: quote.peRatio ?? null,
    sector: quote.sector,
  };
}

/** Empty technicals — Yahoo history unavailable or not yet fetched. */
export const EMPTY_TECHNICALS: StockTechnicals = {
  rsi14: null,
  macdLine: null,
  macdSignalLine: null,
  macdHistogram: null,
  macdSignal: null,
  gapPercent: null,
  gapDirection: null,
  historyBars: 0,
  historySource: null,
};

/**
 * Attach Yahoo technicals (issue #269). Returns new objects; input unmutated.
 * Symbols missing from the map keep EMPTY_TECHNICALS (honest, not zeroed).
 */
export function attachTechnicals(
  stocks: ScannedStock[],
  technicalsBySymbol: Map<string, YahooTechnicals>
): ScannedStock[] {
  return stocks.map((s) => {
    const t = technicalsBySymbol.get(s.symbol);
    if (!t) return s;
    return {
      ...s,
      // Real RSI from Yahoo history supersedes the (usually null) snapshot RSI.
      rsi14: t.rsi14 ?? s.rsi14,
      technicals: {
        rsi14: t.rsi14,
        macdLine: t.macdLine,
        macdSignalLine: t.macdSignalLine,
        macdHistogram: t.macdHistogram,
        macdSignal: t.macdSignal,
        gapPercent: t.gapPercent,
        gapDirection: t.gapDirection,
        historyBars: t.barsUsed,
        historySource: t.source,
      },
    };
  });
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
    technicals: scanned.technicals,
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
