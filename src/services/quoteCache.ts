/**
 * In-isolate cache for external market-data responses (issue #411).
 *
 * Why this exists: the Yahoo quote path and the Nasdaq listings sweep were
 * fetched on every call. The Nasdaq sweep alone is one paged request per
 * exchange for the full US universe, and screener passes repeat the same
 * Yahoo symbols minutes apart — all of it billed against the external APIs
 * #411 is trying to keep inside free-tier limits.
 *
 * Contract for callers:
 * - Keys are caller-namespaced (`yahoo:<SYMBOL>`, `nasdaq:listings:all`).
 * - Store ONLY successful live results. Errors and deterministic fallbacks
 *   are never cached, so a recovering feed is picked up on the next call
 *   instead of after the TTL.
 * - A cached value keeps its original fetch timestamp; the TTL bounds how
 *   stale it can be served, it does not refresh the value's own as-of time.
 *
 * Properties that matter for review (same honesty class as the session
 * cache and the AI-search cache):
 * - Per-isolate and best-effort. A cold or recycled isolate simply misses,
 *   so the cache can never become a correctness dependency.
 * - Bounded. Oldest entry is evicted at the cap; entries expire on read.
 */
export const QUOTE_CACHE_TTL_MS = 5 * 60_000;
export const QUOTE_CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function getCachedQuote<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

/**
 * #930: cache hit with its age, so callers can stamp the served value as
 * cached instead of re-serving it as bare "live". Age is measured from the
 * original fetch, not from the TTL window.
 */
export function getCachedQuoteWithAge<T>(key: string): { value: T; ageMs: number } | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return { value: entry.value as T, ageMs: Date.now() - entry.fetchedAt };
}

export function setCachedQuote(key: string, value: unknown): void {
  if (cache.size >= QUOTE_CACHE_MAX_ENTRIES && !cache.has(key)) {
    // Map preserves insertion order, so the first key is the oldest write.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  const now = Date.now();
  cache.set(key, { value, fetchedAt: now, expiresAt: now + QUOTE_CACHE_TTL_MS });
}

/** Test seam: clear all entries (mirrors __resetSessionCache). */
export function __resetQuoteCache(): void {
  cache.clear();
}
