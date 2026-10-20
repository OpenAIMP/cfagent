import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { YahooFinanceProvider } from "../src/services/fossResearch";
import { __resetQuoteCache } from "../src/services/quoteCache";

/**
 * Issue #411 — Yahoo quotes are cached for 5 minutes in memory: repeat
 * getQuote calls for the same symbol must not refetch. Only live results
 * are cached; the deterministic fallback (live fetch failed) is never
 * cached, so a recovering feed is picked up on the next call.
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
    expect(second).toEqual(first);
    expect(chartFetches).toBe(1);
  });

  it("refetches after the 5-minute TTL", async () => {
    const provider = new YahooFinanceProvider();
    await provider.getQuote("NVDA");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await provider.getQuote("NVDA");
    expect(chartFetches).toBe(2);
  });

  it("never caches the deterministic fallback", async () => {
    chartOk = false;
    const provider = new YahooFinanceProvider();
    const first = await provider.getQuote("NVDA");
    expect(first.provenance).not.toBe("live");
    const afterFirst = chartFetches;
    await provider.getQuote("NVDA");
    expect(chartFetches).toBeGreaterThan(afterFirst);
  });
});
