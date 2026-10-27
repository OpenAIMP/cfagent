/**
 * #916 (parent #913, S1) — Yahoo-sourced quotes must never fabricate data.
 *
 * Issue #1007 adaptation (disclosed): these pins were written against
 * YFinanceMarketScreener, the second screening engine S3 retired. The
 * honesty contract they pin — live-fetch failure yields NO quote, a
 * non-live provider quote is never re-stamped as live Yahoo data, the
 * success path invents no fields — now lives in the Yahoo data-source
 * adapter (src/trading/screenerPipeline.ts, moved from yahooDataSource.ts in #1317) that feeds the one stock
 * pipeline, so the pins are re-pointed there at equal or greater
 * strength (the adapter-level assertions are joined by the pipeline
 * acquisition behaviour: an all-failing symbol set fails the run
 * visibly instead of returning an empty "result").
 *
 * Pins:
 * - Live fetch failure => the adapter yields no quote for the symbol
 *   (curated AND non-curated), and acquireUniverse's yahoo mode throws
 *   an explicit Yahoo-unavailable error — no substitute quote, no
 *   silent empty success.
 * - A provider quote whose provenance is not "live" (the market-data
 *   provider's static/generated sync fallback) is rejected at the
 *   adapter seam, never re-stamped as a live Yahoo quote.
 * - Success path passes through only values the provider actually
 *   returned: no x1.25/x0.75 52-week invention, no 25.0 PE default,
 *   no 10.0 market-cap default.
 * - Source pins: the fabrication literals are gone from the adapter
 *   module, and the retired engine module no longer exists.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  fetchYahooQuotes,
  yahooDepsFromProvider,
  yahooQuoteToPipelineQuote,
} from "../src/trading/screenerPipeline";
import { acquireUniverse } from "../src/trading/screenerPipeline";
import { YahooFinanceProvider } from "../src/services/marketDataResearch";
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

const deps = () => yahooDepsFromProvider(new YahooFinanceProvider());

describe("#916 yahoo adapter provenance (retargeted by #1007)", () => {
  it("yields no quote when the live fetch fails for a curated symbol (no $100 quote)", async () => {
    stubFetch("fail");
    await expect(fetchYahooQuotes(["AAPL"], deps())).resolves.toEqual([]);
  });

  it("yields no quote when the live fetch fails for a non-curated symbol (no invented profile quote)", async () => {
    stubFetch("fail");
    await expect(fetchYahooQuotes(["WFC"], deps())).resolves.toEqual([]);
  });

  it("pipeline acquisition fails visibly when every Yahoo lookup fails", async () => {
    stubFetch("fail");
    await expect(
      acquireUniverse({
        mode: "yahoo",
        symbols: [{ symbol: "AAPL", companyName: "Apple Inc.", exchange: "NASDAQ", change: 0, changePercent: 0 }] as any,
        yahooDeps: deps(),
      })
    ).rejects.toThrow(/Yahoo Finance unavailable/);
  });

  it("success path invents nothing: no x1.25 52-week range, no PE/market-cap defaults", async () => {
    stubFetch("chart");
    const quotes = await fetchYahooQuotes(["WFC"], deps());
    expect(quotes).toHaveLength(1);
    const q: any = quotes[0];
    expect(q.price).toBe(210.5);
    expect(q.source).toBe("Yahoo Finance");
    // Day high is 212.0 — the old engine emitted 212 x 1.25 = 265 as week52High.
    expect(q.week52High).not.toBe(265);
    expect(q.week52High ?? undefined).toBeUndefined();
    expect(q.week52Low ?? undefined).toBeUndefined();
    // WFC is not in the static market-data profile table and crumb enrichment is
    // unreachable in this stub, so PE and market cap are genuinely unknown.
    expect(q.peRatio ?? undefined).toBeUndefined();
    expect(q.marketCap ?? undefined).toBeUndefined();
  });

  it("a non-live provider quote is rejected at the adapter seam", () => {
    const adapted = yahooQuoteToPipelineQuote({
      symbol: "AAPL",
      provider: "yfinance",
      provenance: "generated",
      price: 100,
      change: 0,
      changePercent: 0,
      bid: 99.9,
      ask: 100.1,
      volume: 1_000_000,
      open: 100,
      high: 100,
      low: 100,
      previousClose: 100,
      timestamp: new Date().toISOString(),
    } as any);
    expect(adapted).toBeNull();
  });

  it("source pins: fabrication literals are gone; the retired engine module is gone", () => {
    const src = readFileSync("src/trading/screenerPipeline.ts", "utf8");
    expect(src).not.toContain("lastPrice: 100.0");
    expect(src).not.toContain("bid: 99.9");
    expect(src).not.toContain("* 1.25");
    expect(src).not.toContain("* 0.75");
    expect(src).not.toContain("|| 25.0");
    expect(existsSync("src/trading/yfinanceScreener.ts")).toBe(false);
  });
});
