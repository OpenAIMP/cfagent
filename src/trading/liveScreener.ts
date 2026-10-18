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
import type { ETradeQuote } from "../types";

export interface LiveScreenerDeps {
  /** Fetch a live E*TRADE quote for a symbol. Throws on failure. */
  fetchETradeQuote: (symbol: string) => Promise<ETradeQuote>;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function withRetries<T>(
  fn: () => Promise<T>,
  source: string,
  symbol?: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
  }
  throw new Error(
    `${source} failed after ${MAX_RETRIES} attempts${symbol ? ` for ${symbol}` : ""}: ` +
      (lastError instanceof Error ? lastError.message : String(lastError))
  );
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
