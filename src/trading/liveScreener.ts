/**
 * Issue #224 (surviving utilities): shared retry + technology-symbol
 * helpers for the stock screener.
 *
 * Issue #1356 deleted the rest of this module's seam: the
 * broker-shaped LiveScreenerDeps and fetchLiveQuotes (E*TRADE-primary
 * with Nasdaq-listing DELAYED fallback) are replaced by the platform
 * quote seam in screenerPipeline.ts (QuoteScreenerDeps,
 * bindEtradeQuoteDeps / bindLiveQuotesQuoteDeps). No static/fake
 * data — if providers fail for a symbol, it is skipped or the run
 * fails honestly (never fabricated).
 *
 * Truthful provenance per issue #118 audit F12: every quote carries
 * its actual source.
 */

import { fetchAllUsStockListings, type NasdaqStockListing } from "../services/nasdaqListings";
import { withRetry } from "../services/resilience";

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
