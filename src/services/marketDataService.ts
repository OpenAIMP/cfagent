/**
 * MarketDataService facade — issue #1643 (parent #1638, doc §7).
 *
 * One read surface over the market-stream tick caches, with #913
 * live-source provenance rules enforced in the type system:
 * - A cache entry served inside its TTL resolves as `cached` with
 *   its original fetch time (`fetchedAtMs`) and age (`ageMs`). It is
 *   NEVER labeled live: the HTTP handler serves cache snapshots
 *   (its background refresh is unawaited), so calling a cache read
 *   "live" would present a cached quote as a fresh one.
 * - An expired or missing entry resolves as `unavailable`. Nothing
 *   is fabricated to fill the gap, and a stale tick is never served
 *   as current — the previous `getBatchMarketQuotes` behavior (serve
 *   regardless of `expiresAt`) is exactly what this facade replaces
 *   for the HTTP surface.
 * - `live` provenance is reserved for a future fetch-through path
 *   and is intentionally absent here: this slice unifies the READ +
 *   provenance layer only. Provider fetchers (Alpaca/Yahoo in
 *   marketStream, E*TRADE in the platform service, Yahoo objects in
 *   marketDataResearch via quoteCache) are NOT moved behind the facade
 *   yet — that is remaining work, stated in #1643's §15, not claimed
 *   done.
 *
 * Scope, verified on main: /api/market/quotes and /api/market-data/quotes
 * are already aliases to one handler; no /api/trading/etrade/quotes
 * HTTP route exists. TTLs are per-path and unchanged by this module
 * (marketStream: 20s Alpaca / 30s Yahoo; quoteCache: 5-min) — the
 * doc's 1-minute figure matches neither regime and is not adopted.
 * The WebSocket stream is deliberately NOT routed through this
 * facade: it publishes the last cached quote for stream continuity
 * by design, and its ticks already carry fetch timestamps.
 */
import type { MarketTickData } from "./marketStream";

/** A cache entry as marketStream stores it (tick + expiry). */
export interface MarketCacheEntry {
  tick: MarketTickData;
  expiresAt: number;
}

/** Provenance of a resolved quote. No `live` yet — see header. */
export type MarketDataProvenance = "cached" | "unavailable";

/** One resolved quote: tick when served, null when unavailable. */
export interface MarketDataQuote {
  symbol: string;
  tick: MarketTickData | null;
  provenance: MarketDataProvenance;
  /** Provider that produced the tick (Alpaca / Yahoo Finance), or null. */
  source: string | null;
  /** Original fetch time of the served tick, or null when unavailable. */
  fetchedAtMs: number | null;
  /** Age of the served tick at resolution time, or null. */
  ageMs: number | null;
}

/** A served quote as the HTTP surface returns it: tick + provenance. */
export type MarketDataQuoteView = MarketTickData & {
  provenance: "cached";
  fetchedAtMs: number;
  ageMs: number;
};

export interface MarketDataResolution {
  quotes: MarketDataQuoteView[];
  unavailable: string[];
}

/**
 * Resolve symbols against a cache reader. Pure and synchronous: the
 * reader supplies entries (in production, marketStream's
 * liveMarketCache). #1725 (parent #1717, slice (e)): expiry is a
 * switch (QUOTE_EXPIRY_MODE), default "honour" — expired entries
 * can never leak into a response as current quotes. Under
 * "continuity" (the WS stream's legacy, now expressible here) an
 * expired entry is still served as "cached" with its true age;
 * the provenance is never upgraded to "live".
 */
export function resolveMarketDataQuotes(
  symbols: string[],
  readEntry: (symbol: string) => MarketCacheEntry | undefined,
  nowMs: number = Date.now(),
  opts?: { expiry?: "honour" | "continuity" },
): MarketDataResolution {
  const quotes: MarketDataQuoteView[] = [];
  const unavailable: string[] = [];
  const expiry = opts?.expiry ?? "honour";
  for (const raw of symbols) {
    const symbol = raw.toUpperCase().trim();
    if (!symbol) continue;
    const entry = readEntry(symbol);
    if (entry && (expiry === "continuity" || entry.expiresAt > nowMs)) {
      quotes.push({
        ...entry.tick,
        provenance: "cached",
        fetchedAtMs: entry.tick.timestamp,
        ageMs: nowMs - entry.tick.timestamp,
      });
    } else {
      unavailable.push(symbol);
    }
  }
  return { quotes, unavailable };
}
