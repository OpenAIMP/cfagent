import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCachedQuote,
  setCachedQuote,
  __resetQuoteCache,
  QUOTE_CACHE_TTL_MS,
  QUOTE_CACHE_MAX_ENTRIES,
} from "../src/services/quoteCache";

/**
 * Issue #411 — the in-memory quote cache behind the Yahoo/Nasdaq quote
 * paths. Pins the three properties callers rely on: fresh entries are
 * served without refetching, entries expire at the 5-minute TTL, and the
 * cache is bounded (oldest evicted first).
 */
describe("quote cache (#411)", () => {
  beforeEach(() => {
    __resetQuoteCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetQuoteCache();
  });

  it("misses before anything is stored", () => {
    expect(getCachedQuote("yahoo:NVDA")).toBeUndefined();
  });

  it("serves a stored value within the TTL", () => {
    setCachedQuote("yahoo:NVDA", { price: 129 });
    expect(getCachedQuote("yahoo:NVDA")).toEqual({ price: 129 });
    vi.advanceTimersByTime(QUOTE_CACHE_TTL_MS - 1);
    expect(getCachedQuote("yahoo:NVDA")).toEqual({ price: 129 });
  });

  it("expires entries at the TTL (5 minutes per #411)", () => {
    expect(QUOTE_CACHE_TTL_MS).toBe(5 * 60_000);
    setCachedQuote("yahoo:NVDA", { price: 129 });
    vi.advanceTimersByTime(QUOTE_CACHE_TTL_MS + 1);
    expect(getCachedQuote("yahoo:NVDA")).toBeUndefined();
  });

  it("evicts the oldest entry at the cap", () => {
    for (let i = 0; i < QUOTE_CACHE_MAX_ENTRIES; i++) {
      setCachedQuote(`yahoo:S${i}`, { price: i });
    }
    expect(getCachedQuote("yahoo:S0")).toEqual({ price: 0 });
    setCachedQuote("yahoo:NEW", { price: -1 });
    expect(getCachedQuote("yahoo:S0")).toBeUndefined();
    expect(getCachedQuote("yahoo:NEW")).toEqual({ price: -1 });
  });
});
