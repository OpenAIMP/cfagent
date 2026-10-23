/**
 * Yahoo Finance data-source adapter (issue #1007, screening
 * consolidation S3 under umbrella #958).
 *
 * Yahoo Finance survives as a DATA SOURCE inside the one stock
 * screening pipeline — never as a second screening engine. This module
 * is the only place that knows Yahoo's quote shape: it adapts
 * YahooFinanceProvider quotes (src/services/fossResearch.ts) into the
 * pipeline's ETradeQuote shape, so acquireUniverse (screenerPipeline)
 * can feed them to the shared DynamicMarketScreener evaluator exactly
 * like E*TRADE quotes. Scoring, filtering, result shaping and
 * persistence are the pipeline's, regardless of provider; a provider
 * changes data provenance only.
 *
 * The provider interface mirrors LiveScreenerDeps (liveScreener.ts):
 * callers inject a quote fetcher, so tests run on fixtures and the
 * production wiring binds YahooFinanceProvider.getQuote.
 *
 * Honesty rules (carried from #913/#916, previously enforced inside
 * the retired YFinanceMarketScreener):
 * - Only a genuinely live provider quote (provenance === "live",
 *   price > 0) may enter the pipeline. The provider's static/generated
 *   sync fallback is not live data and is never re-stamped as a Yahoo
 *   quote here.
 * - A failed lookup yields NO row for that symbol — never a substitute
 *   quote. If every lookup fails the caller (acquireUniverse, yahoo
 *   mode) fails the run visibly; there is no silent fallback to
 *   another provider's data.
 *
 * YFinance's indicator work survives as adapter internals: the RSI-14
 * and MACD values YahooFinanceProvider computes from daily history
 * (computeRsi14 / computeMacd in fossResearch.ts) ride through as DATA
 * fields on the adapted quote (rsi, macdSignal) where the pipeline can
 * consume them — the pipeline's RSI filter reads the quote's RSI, and
 * screenWithQuotes surfaces the MACD signal on the screened row.
 */

import { DEFAULT_PIPELINE_POLICY, type RetryPolicy } from "../services/pipelinePolicy";
import { withRetry } from "../services/resilience";
import type { ETradeQuote, FossQuote } from "../types";
import {
  YFINANCE_MARKET_UNIVERSE,
  getCuratedStockBySymbol,
  type CuratedStockSecurity,
} from "../config/curatedStockUniverse";
import type { NasdaqStockListing } from "../services/nasdaqListings";

/** Provider id recorded in canonical-report provenance for Yahoo runs. */
export const YAHOO_PROVIDER_ID = "yahoo" as const;

/** Source label stamped on every adapted quote (its provenance). */
export const YAHOO_QUOTE_SOURCE = "Yahoo Finance";

/**
 * The Yahoo provider seam — mirrors LiveScreenerDeps: an injected
 * per-symbol live-quote fetcher. Production binds
 * YahooFinanceProvider.getQuote; tests bind fixtures.
 */
export interface YahooScreenerDeps {
  /** Fetch a live Yahoo quote for a symbol. Throws on failure. */
  fetchYahooQuote: (symbol: string) => Promise<FossQuote>;
  /** Issue #1184 (#1173 R2): batch quote fetcher (one request per
   *  symbol chunk). Optional — providers without it keep the
   *  per-symbol path for everything. */
  fetchYahooBatchQuotes?: (symbols: string[]) => Promise<FossQuote[]>;
  /** Issue #1181 (#1173 R1): retry policy for per-symbol fetches.
   *  Defaults to the pipeline policy's acquisition policy — the
   *  Yahoo path's first retry coverage (it previously had none). */
  retryPolicy?: RetryPolicy;
  /** Test seam: sleep implementation for the retry executor. */
  retrySleep?: (ms: number) => Promise<void>;
}

/** Bind a YahooFinanceProvider-shaped object as pipeline deps. */
export function yahooDepsFromProvider(provider: {
  getQuote: (symbol: string) => Promise<FossQuote>;
  getQuotes?: (symbols: string[]) => Promise<FossQuote[]>;
}): YahooScreenerDeps {
  return {
    fetchYahooQuote: (symbol) => provider.getQuote(symbol),
    ...(typeof provider.getQuotes === "function"
      ? { fetchYahooBatchQuotes: (symbols: string[]) => provider.getQuotes!(symbols) }
      : {}),
  };
}

/**
 * Adapt one live Yahoo provider quote to the pipeline quote shape.
 * Returns null when the quote is not genuinely live Yahoo data
 * (provenance !== "live" or no positive price) — the caller skips the
 * symbol rather than screening fabricated data.
 */
export function yahooQuoteToPipelineQuote(
  live: FossQuote,
  base?: CuratedStockSecurity
): ETradeQuote | null {
  if (!live || live.provenance !== "live" || !(live.price > 0)) return null;
  const symbol = (live.symbol || base?.symbol || "").toUpperCase();
  if (!symbol) return null;
  const prevClose =
    live.previousClose ||
    Number((live.price - live.change).toFixed(2));
  const change = Number((live.price - prevClose).toFixed(2));
  const changePercent =
    prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;
  return {
    symbol,
    companyName: live.companyName || base?.companyName || symbol,
    sector: base?.sector,
    lastPrice: live.price,
    price: live.price,
    change,
    changePercent,
    bid: live.bid || live.price,
    ask: live.ask || live.price,
    volume: live.volume || 0,
    open: live.open || live.price,
    high: live.high || live.price,
    low: live.low || live.price,
    previousClose: prevClose,
    peRatio: live.trailingPE,
    // Yahoo reports market cap in raw dollars; the pipeline's
    // evaluator normalizes magnitudes itself (screener.ts).
    marketCap: live.marketCap,
    // Indicator DATA fields: real RSI-14 / MACD from Yahoo history,
    // computed by the provider. Absent when history was insufficient —
    // never estimated here.
    rsi: live.rsi14,
    macdSignal: live.macdSignal,
    quoteStatus: "LIVE",
    source: YAHOO_QUOTE_SOURCE,
    timestamp: live.timestamp || new Date().toISOString(),
  };
}

/**
 * Fetch live Yahoo quotes for a symbol list (concurrency-batched like
 * liveScreener.fetchLiveQuotes). Symbols whose lookup fails or is not
 * genuinely live are SKIPPED — no fallback data is substituted. The
 * caller decides what an empty/short result means (acquireUniverse's
 * yahoo mode fails the run when nothing quoted, and qualifies a
 * partial set exactly like the E*TRADE path).
 */
/** Symbols per batch-endpoint request (issue #1184). */
const YAHOO_BATCH_CHUNK = 50;

export async function fetchYahooQuotes(
  symbols: string[],
  deps: YahooScreenerDeps
): Promise<ETradeQuote[]> {
  const policy = deps.retryPolicy ?? DEFAULT_PIPELINE_POLICY.retry.acquisition;
  const bySymbol = new Map<string, ETradeQuote>();

  // Issue #1184 (#1173 R2): batch first — one request per chunk of
  // 50 replaces 2–3 requests per symbol (the burst Yahoo throttled
  // to 25% success on 2026-10-23). A failed chunk (after the shared
  // acquisition policy's retries) falls back to per-symbol fetches
  // for its symbols; symbols a batch response omits do the same.
  if (deps.fetchYahooBatchQuotes) {
    for (let i = 0; i < symbols.length; i += YAHOO_BATCH_CHUNK) {
      const chunk = symbols.slice(i, i + YAHOO_BATCH_CHUNK);
      try {
        const batch = await withRetry(
          () => deps.fetchYahooBatchQuotes!(chunk),
          policy,
          { label: `yahoo-batch:${chunk.length}`, sleep: deps.retrySleep }
        );
        for (const live of batch) {
          const adapted = yahooQuoteToPipelineQuote(
            live,
            getCuratedStockBySymbol(live.symbol)
          );
          if (adapted) bySymbol.set(adapted.symbol.toUpperCase(), adapted);
        }
      } catch (err) {
        console.warn(
          `[yahooDataSource] batch quote chunk failed (${chunk.length} symbols); falling back per-symbol:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  const missing = symbols.filter((s) => !bySymbol.has(s.toUpperCase()));
  const quotes: ETradeQuote[] = [];
  const CONCURRENCY = 10;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (symbol) => {
        // Issue #1181 (#1173 R1): every symbol fetch retries under
        // the shared acquisition policy (exponential backoff) — the
        // parity the E*TRADE path always had. A symbol is dropped
        // only after its attempts are exhausted; the partial-quote
        // qualification in acquireUniverse reports it as before.
        return withRetry(
          async () => {
            const live = await deps.fetchYahooQuote(symbol);
            const adapted = yahooQuoteToPipelineQuote(
              live,
              getCuratedStockBySymbol(symbol)
            );
            if (!adapted) {
              throw new Error(
                `Yahoo Finance returned no live quote for ${symbol}`
              );
            }
            return adapted;
          },
          policy,
          { label: `yahoo:${symbol}`, sleep: deps.retrySleep }
        );
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") quotes.push(r.value);
    }
  }
  for (const q of quotes) bySymbol.set(q.symbol.toUpperCase(), q);
  // Input order, batch and per-symbol results merged.
  return symbols
    .map((s) => bySymbol.get(s.toUpperCase()))
    .filter((q): q is ETradeQuote => !!q);
}

/**
 * The Yahoo provider's default universe: the curated market universe
 * (the membership the retired engine screened), expressed as pipeline
 * listings. Membership only — prices always come from live quotes.
 */
export function yahooUniverseListings(): NasdaqStockListing[] {
  return YFINANCE_MARKET_UNIVERSE.map((item) => ({
    symbol: item.symbol,
    companyName: item.companyName,
    exchange: item.exchange,
    change: 0,
    changePercent: 0,
    marketCap: item.marketCap,
    sector: item.sector,
  }));
}
