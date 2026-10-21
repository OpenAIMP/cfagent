/**
 * #916 (parent #913, S1) — YFinanceMarketScreener must never fabricate data.
 *
 * The screener previously returned an invented $100.00 quote (bid 99.9 /
 * ask 100.1 / volume 1,000,000, stamped "Yahoo Finance FOSS Engine") when
 * the live Yahoo fetch failed, and invented fields on the success path
 * (52-week range = day high x1.25 / day low x0.75, peRatio default 25.0,
 * marketCap default 10.0, rsi default 50).
 *
 * Pins:
 * - Live fetch failure => getQuote rejects with an explicit unavailable
 *   error for curated AND non-curated symbols (no substitute quote).
 * - A provider quote whose provenance is not "live" (the FOSS provider's
 *   static/generated sync fallback) is rejected at this seam, never
 *   re-stamped as a live Yahoo quote.
 * - Success path passes through only values the provider actually
 *   returned: no x1.25/x0.75 52-week invention, no 25.0 PE default,
 *   no 10.0 market-cap default.
 * - screenMarkets with every fetch failing yields an empty result, not a
 *   universe priced from static profiles.
 * - Source pins: the fabrication literals are gone from the module.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { YFinanceMarketScreener } from "../src/trading/yfinanceScreener";
import { __resetQuoteCache } from "../src/services/quoteCache";

beforeEach(() => {
  __resetQuoteCache();
});

const CHART_URL = "/v8/finance/chart/";

function chartPayload(symbol: string) {
  const closes = Array.from({ length: 30 }, (_, i) => 200 + i * 0.35);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            longName: "Wells Fargo & Company",
            regularMarketPrice: 210.5,
            regularMarketPreviousClose: 208.0,
            regularMarketDayHigh: 212.0,
            regularMarketDayLow: 207.0,
            regularMarketVolume: 1234567,
            currency: "USD",
          },
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  };
}

function stubFetch(mode: "fail" | "chart") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (mode === "chart" && String(url).includes(CHART_URL)) {
        const sym = decodeURIComponent(String(url).split(CHART_URL)[1].split("?")[0]);
        return {
          ok: true,
          status: 200,
          json: async () => chartPayload(sym),
          text: async () => JSON.stringify(chartPayload(sym)),
        } as any;
      }
      throw new Error("network down");
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#916 yfinance screener provenance", () => {
  it("rejects when the live fetch fails for a curated symbol (no $100 quote)", async () => {
    stubFetch("fail");
    const screener = new YFinanceMarketScreener();
    await expect(screener.getQuote("AAPL")).rejects.toThrow(/unavailable/i);
  });

  it("rejects when the live fetch fails for a non-curated symbol (no invented profile quote)", async () => {
    stubFetch("fail");
    const screener = new YFinanceMarketScreener();
    await expect(screener.getQuote("WFC")).rejects.toThrow(/unavailable/i);
  });

  it("success path invents nothing: no x1.25 52-week range, no PE/market-cap defaults", async () => {
    stubFetch("chart");
    const screener = new YFinanceMarketScreener();
    const q: any = await screener.getQuote("WFC");
    expect(q.price).toBe(210.5);
    expect(q.source).toBe("Yahoo Finance FOSS Engine");
    // Day high is 212.0 — the old code emitted 212 x 1.25 = 265 as week52High.
    expect(q.week52High).not.toBe(265);
    expect(q.week52High ?? undefined).toBeUndefined();
    expect(q.week52Low ?? undefined).toBeUndefined();
    // WFC is not in the static FOSS profile table and crumb enrichment is
    // unreachable in this stub, so PE and market cap are genuinely unknown.
    expect(q.peRatio ?? undefined).toBeUndefined();
    expect(q.marketCap ?? undefined).toBeUndefined();
  });

  it("screenMarkets with every fetch failing returns an empty, honest result", async () => {
    stubFetch("fail");
    const screener = new YFinanceMarketScreener();
    const result = await screener.screenMarkets({});
    expect(result.stocks).toHaveLength(0);
    expect(result.matchedCount).toBe(0);
  });

  it("source pins: fabrication literals are gone from the module", () => {
    const src = readFileSync("src/trading/yfinanceScreener.ts", "utf8");
    expect(src).not.toContain("lastPrice: 100.0");
    expect(src).not.toContain("bid: 99.9");
    expect(src).not.toContain("* 1.25");
    expect(src).not.toContain("* 0.75");
    expect(src).not.toContain("|| 25.0");
  });
});
