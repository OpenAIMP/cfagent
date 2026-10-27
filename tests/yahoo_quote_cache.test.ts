import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { YahooFinanceProvider } from "../src/services/marketDataResearch";
import { __resetQuoteCache } from "../src/services/quoteCache";

/**
 * Issue #411 — Yahoo quotes are cached for 5 minutes in memory: repeat
 * getQuote calls for the same symbol must not refetch. Only live results
 * are cached; a failed fetch (#923: no fallback exists anymore) rejects
 * and is never cached, so a recovering feed is picked up on the next call.
 */
const CHART_URL = "query1.finance.yahoo.com/v8/finance/chart";
let chartFetches = 0;
let chartOk = true;

function chartPayload() {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol: "NVDA",
            longName: "NVIDIA Corporation",
            regularMarketPrice: 129,
            chartPreviousClose: 128,
            regularMarketPreviousClose: 128,
            regularMarketVolume: 12345,
            regularMarketDayHigh: 130,
            regularMarketDayLow: 127,
            currency: "USD",
            bid: 128.9,
            ask: 129.1,
          },
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

describe("Yahoo quote cache (#411)", () => {
  beforeEach(() => {
    __resetQuoteCache();
    chartFetches = 0;
    chartOk = true;
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes(CHART_URL)) {
        chartFetches += 1;
        if (!chartOk) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => chartPayload() };
      }
      // Crumb/summary enrichment: unavailable in tests, provider tolerates it.
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetQuoteCache();
  });

  it("serves repeat quotes from the cache instead of refetching", async () => {
    const provider = new YahooFinanceProvider();
    const first = await provider.getQuote("NVDA");
    const second = await provider.getQuote("NVDA");
    expect(first.provenance).toBe("live");
    expect(first.price).toBe(129);
    // #930: the repeat is still served from cache (one chart fetch), but
    // it is stamped "cached" with its age — never bare "live" — while the
    // values stay identical to the fresh fetch.
    expect(second.provenance).toBe("cached");
    expect((second as any).fromCache).toBe(true);
    expect(typeof (second as any).cacheAgeMs).toBe("number");
    expect(second.price).toBe(first.price);
    expect(second.timestamp).toBe(first.timestamp);
    expect(chartFetches).toBe(1);
  });

  it("refetches after the 5-minute TTL", async () => {
    const provider = new YahooFinanceProvider();
    await provider.getQuote("NVDA");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await provider.getQuote("NVDA");
    expect(chartFetches).toBe(2);
  });

  it("failed quotes reject and are never cached (#923)", async () => {
    // #923: there is no deterministic fallback to (not) cache anymore —
    // a failed live fetch rejects, and the failure itself is never
    // cached either, so a recovering feed is picked up on the next call.
    chartOk = false;
    const provider = new YahooFinanceProvider();
    await expect(provider.getQuote("NVDA")).rejects.toThrow(/unavailable/i);
    const afterFirst = chartFetches;
    await expect(provider.getQuote("NVDA")).rejects.toThrow(/unavailable/i);
    expect(chartFetches).toBeGreaterThan(afterFirst);
  });
});
