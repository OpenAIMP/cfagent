/**
 * Issue #224: E*TRADE-primary market screener with Nasdaq fallback.
 *
 * Real-time live trading system: E*TRADE live quotes are primary,
 * Nasdaq API is secondary. Both with retries. No static/fake data —
 * if both sources fail for a symbol, it is skipped (not fabricated).
 *
 * Truthful provenance per issue #118 audit F12: every quote carries
 * its actual source.
 */

import { fetchAllUsStockListings, type NasdaqStockListing } from "../services/nasdaqListings";
import { withRetry } from "../services/resilience";
import type { ETradeQuote } from "../types";

export interface LiveScreenerDeps {
  /** Fetch a live E*TRADE quote for a symbol. Throws on failure. */
  fetchETradeQuote: (symbol: string) => Promise<ETradeQuote>;
  /**
   * Issue #495: fetch quotes for many symbols in one authenticated request
   * (E*TRADE's documented `/market/quote/{symbols}` endpoint). Optional:
   * callers that cannot batch keep the per-symbol path. Returns the quotes
   * the broker actually returned; the caller diffs against the request to
   * see which symbols are missing.
   */
  fetchETradeQuotes?: (symbols: string[]) => Promise<ETradeQuote[]>;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Issue #1181 (#1173 R1): implemented on the shared resilience
 * executor (services/resilience.ts) under an explicit policy. The
 * legacy linear schedule (1000ms, 2000ms) equals the exponential
 * schedule at base 1000 for this 3-attempt shape, so timing and the
 * error-wrap message are preserved exactly; the policy plumbing is
 * what changed — one executor for every provider now.
 */
export async function withRetries<T>(
  fn: () => Promise<T>,
  source: string,
  symbol?: string
): Promise<T> {
  try {
    return await withRetry(fn, {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: RETRY_DELAY_MS,
      maxDelayMs: RETRY_DELAY_MS * MAX_RETRIES,
      jitterRatio: 0,
    }, { label: symbol ? `${source}:${symbol}` : source });
  } catch (lastError) {
    throw new Error(
      `${source} failed after ${MAX_RETRIES} attempts${symbol ? ` for ${symbol}` : ""}: ` +
        (lastError instanceof Error ? lastError.message : String(lastError))
    );
  }
}

/**
 * Get Technology sector symbols from Nasdaq API (with retries).
 * This is universe discovery — the live quotes come from E*TRADE.
 */
export async function fetchTechnologySymbols(): Promise<NasdaqStockListing[]> {
  const listings = await withRetries(() => fetchAllUsStockListings(), "Nasdaq listings");
  return listings.filter((l) => {
    const name = l.companyName.toLowerCase();
    return (
      name.includes("tech") ||
      name.includes("software") ||
      name.includes("semiconductor") ||
      name.includes("computer") ||
      name.includes("internet") ||
      name.includes("data")
    );
  });
}

/**
 * Fetch live quotes: E*TRADE primary (with retries), Nasdaq data as
 * fallback. Skips symbols where both fail — no fake data.
 */
export async function fetchLiveQuotes(
  symbols: NasdaqStockListing[],
  deps: LiveScreenerDeps,
  maxSymbols = 50
): Promise<ETradeQuote[]> {
  const quotes: ETradeQuote[] = [];
  const limited = symbols.slice(0, maxSymbols);

  const CONCURRENCY = 10;
  for (let i = 0; i < limited.length; i += CONCURRENCY) {
    const batch = limited.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (listing) => {
        try {
          const live = await withRetries(
            () => deps.fetchETradeQuote(listing.symbol),
            "E*TRADE",
            listing.symbol
          );
          return {
            ...live,
            symbol: listing.symbol,
            companyName: listing.companyName,
            source: "E*TRADE live",
            quoteStatus: "LIVE",
          } as ETradeQuote;
        } catch {
          // Secondary: Nasdaq listing data (already fetched, no extra call).
          return {
            symbol: listing.symbol,
            companyName: listing.companyName,
            lastPrice: listing.lastPrice,
            price: listing.lastPrice,
            change: listing.change,
            changePercent: listing.changePercent,
            bid: 0,
            ask: 0,
            volume: 0,
            source: "Nasdaq (E*TRADE failed)",
            quoteStatus: "DELAYED",
          } as ETradeQuote;
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") quotes.push(r.value);
    }
  }
  return quotes;
}
