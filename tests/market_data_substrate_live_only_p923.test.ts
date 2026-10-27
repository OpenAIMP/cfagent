import { describe, it, expect, vi, afterEach } from "vitest";
import {
  YahooFinanceProvider,
  AlpacaMarketDataProvider,
  HybridMarketDataProvider,
  MarketDataResearchService,
} from "../src/services/marketDataResearch";
import type { Env } from "../src/types";

/**
 * Issue #923 (epic #913 S5) — Market-data substrate: live-only or explicit
 * unavailable. These pins prove the failure path returns an explicit
 * error and NO substitute numbers:
 * - no synthetic bars (generateHistoricalBars) on any live path;
 * - no hash-invented profile for an unknown symbol;
 * - no static-table price/bar fields served by a provider sync method;
 * - no invented bid/ask (price ± 0.05) on a live Yahoo quote.
 *
 * Symbols are distinct per test: the Yahoo provider caches successful
 * live quotes for 5 minutes, so a cached symbol must never be reused
 * by a failure test in this file.
 */

function jsonResponse(body: unknown, ok = true): any {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (_h: string) => null },
  };
}

function stubFetch(handler: (url: string) => Promise<any>) {
  vi.stubGlobal("fetch", vi.fn(async (input: any) => handler(String(input))));
}

function stubFetchDown() {
  stubFetch(async () => {
    throw new Error("network unavailable");
  });
}

function chartPayload(symbol: string, price: number, withBidAsk = false) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            longName: `${symbol} Corporation`,
            currency: "USD",
            regularMarketPrice: price,
            regularMarketPreviousClose: price - 5,
            chartPreviousClose: price - 5,
            regularMarketVolume: 1234567,
            regularMarketDayHigh: price + 5,
            regularMarketDayLow: price - 2,
            fiftyTwoWeekHigh: price + 20,
            fiftyTwoWeekLow: price - 100,
            ...(withBidAsk ? { bid: price - 0.1, ask: price + 0.1 } : {}),
          },
          timestamp: [1700000000, 1700086400, 1700172800],
          indicators: {
            quote: [
              {
                close: [price - 10, price - 5, price],
                open: [price - 11, price - 6, price - 1],
                high: [price - 8, price - 3, price + 2],
                low: [price - 12, price - 7, price - 2],
                volume: [1000, 1100, 1200],
              },
            ],
          },
        },
      ],
    },
  };
}

/** Yahoo chart endpoints succeed; crumb / quoteSummary fail. */
function stubFetchChartOnly(symbol: string, price: number, withBidAsk = false) {
  stubFetch(async (url) => {
    if (url.includes("/v8/finance/chart/")) return jsonResponse(chartPayload(symbol, price, withBidAsk));
    throw new Error("endpoint unavailable");
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALPACA_ENV = {
  ALPACA_API_KEY_ID: "key",
  ALPACA_API_SECRET_KEY: "secret",
  ALPACA_DATA_URL: "https://data.alpaca.test",
} as unknown as Env;

describe("S5 live-only bars (#923)", () => {
  it("Yahoo fetch failure rejects — no synthetic bars", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getHistoricalBars("BARSFAIL", "1D", 30)).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("Yahoo fetch failure rejects with no substitute numbers (message says so)", async () => {
    stubFetchDown();
    const err = await new YahooFinanceProvider()
      .getHistoricalBars("BARSFAIL2", "1D", 30)
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/synthetic substitute/i);
  });

  it("unconfigured Alpaca bars reject — no synthetic bars", async () => {
    stubFetchDown();
    await expect(
      new AlpacaMarketDataProvider({} as Env).getHistoricalBars("BARSALP", "1D", 30),
    ).rejects.toThrow(/unavailable/i);
  });

  it("service bars reject when every live provider fails — no synthetic fallback", async () => {
    stubFetchDown();
    await expect(
      new MarketDataResearchService({} as Env).getHistoricalBars("BARSSVC", "1D", 30, "yfinance"),
    ).rejects.toThrow(/unavailable/i);
  });

  it("sync bars throw — the sync path cannot fetch live data", () => {
    expect(() => new YahooFinanceProvider().getHistoricalBarsSync("BARSYNC")).toThrow(/unavailable/i);
    expect(() => new AlpacaMarketDataProvider({} as Env).getHistoricalBarsSync("BARSYNC")).toThrow(
      /unavailable/i,
    );
    expect(() => new MarketDataResearchService({} as Env).getHistoricalBarsSync("BARSYNC")).toThrow(
      /unavailable/i,
    );
  });
});

describe("S5 live-only profiles (#923)", () => {
  it("Yahoo fetch failure rejects for a table ticker — no static price served", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getQuote("NVDA")).rejects.toThrow(/unavailable/i);
  });

  it("Yahoo fetch failure rejects for an unknown ticker — no hash-invented profile", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getQuote("ZZZZQ923")).rejects.toThrow(/unavailable/i);
  });

  it("unconfigured Alpaca quote rejects — no static/generated profile", async () => {
    stubFetchDown();
    await expect(new AlpacaMarketDataProvider({} as Env).getQuote("AAPL")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("configured Alpaca fetch failure rejects — no profile fallback", async () => {
    stubFetchDown();
    await expect(new AlpacaMarketDataProvider(ALPACA_ENV).getQuote("AAPL")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("sync quotes and fundamentals throw — no static/generated profile served", () => {
    expect(() => new YahooFinanceProvider().getQuoteSync("NVDA")).toThrow(/unavailable/i);
    expect(() => new YahooFinanceProvider().getFundamentalsSync("MSFT")).toThrow(/unavailable/i);
    expect(() => new AlpacaMarketDataProvider({} as Env).getQuoteSync("AAPL")).toThrow(
      /unavailable/i,
    );
    expect(() => new AlpacaMarketDataProvider({} as Env).getFundamentalsSync("AAPL")).toThrow(
      /unavailable/i,
    );
    expect(() => new MarketDataResearchService({} as Env).getQuoteSync("NVDA")).toThrow(/unavailable/i);
    expect(() => new MarketDataResearchService({} as Env).getFundamentalsSync("MSFT")).toThrow(
      /unavailable/i,
    );
  });

  it("sync snapshot, sync comparison, and sync report throw", () => {
    expect(() => new AlpacaMarketDataProvider({} as Env).getMarketSnapshotSync("NVDA")).toThrow(
      /unavailable/i,
    );
    expect(() => new MarketDataResearchService({} as Env).getAlpacaSnapshotSync("NVDA")).toThrow(
      /unavailable/i,
    );
    expect(() => new MarketDataResearchService({} as Env).compareStocksSync(["NVDA", "AMD"])).toThrow(
      /unavailable/i,
    );
    expect(() => new MarketDataResearchService({} as Env).generateResearchReportSync("NVDA")).toThrow(
      /unavailable/i,
    );
  });
});

describe("S5 live-only fundamentals (#923)", () => {
  it("Yahoo fetch failure rejects — no profile fundamentals", async () => {
    stubFetchDown();
    await expect(new YahooFinanceProvider().getFundamentals("FUNFAIL")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("chart-only Yahoo fundamentals reject — no formula analyst block", async () => {
    stubFetchChartOnly("FUNCHART", 200);
    await expect(new YahooFinanceProvider().getFundamentals("FUNCHART")).rejects.toThrow(
      /unavailable/i,
    );
  });

  it("Alpaca fundamentals reject — Alpaca has no live fundamentals source here", async () => {
    stubFetchDown();
    await expect(new AlpacaMarketDataProvider(ALPACA_ENV).getFundamentals("FUNALP")).rejects.toThrow(
      /unavailable/i,
    );
  });
});

describe("S5 no invented bid/ask, no static PE/market-cap in live quotes (#923)", () => {
  it("live Yahoo quote without bid/ask in the payload carries no bid/ask — never price ± 0.05", async () => {
    stubFetchChartOnly("BIDLESS", 200);
    const quote = await new YahooFinanceProvider().getQuote("BIDLESS");
    expect(quote.provenance).toBe("live");
    expect(quote.price).toBe(200);
    expect(quote.bid).toBeUndefined();
    expect(quote.ask).toBeUndefined();
  });

  it("live Yahoo quote with bid/ask in the payload carries the payload values verbatim", async () => {
    stubFetchChartOnly("BIDFULL", 200, true);
    const quote = await new YahooFinanceProvider().getQuote("BIDFULL");
    expect(quote.bid).toBe(199.9);
    expect(quote.ask).toBe(200.1);
  });

  it("live Yahoo batch quote without bid/ask carries no bid/ask — never price ± 0.05", async () => {
    // Exact-hostname check (CodeQL js/incomplete-url-substring-sanitization):
    // a host substring match would also match lookalike hosts.
    const isFcYahoo = (u: string) => {
      try {
        return new URL(u).hostname === "fc.yahoo.com";
      } catch {
        return false;
      }
    };
    stubFetch(async (url) => {
      if (isFcYahoo(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "",
          headers: { get: (h: string) => (h === "set-cookie" ? "A1=dummy; path=/" : null) },
        };
      }
      if (url.includes("getcrumb")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "dummy-crumb",
          headers: { get: (_h: string) => null },
        };
      }
      if (url.includes("/v7/finance/quote")) {
        return jsonResponse({
          quoteResponse: {
            result: [
              {
                symbol: "BATCHBID",
                longName: "Batch Bid Corp",
                regularMarketPrice: 150,
                regularMarketPreviousClose: 148,
                regularMarketChange: 2,
                regularMarketChangePercent: 1.35,
                regularMarketVolume: 900000,
              },
            ],
          },
        });
      }
      throw new Error("unexpected url " + url);
    });
    const quotes = await new YahooFinanceProvider().getQuotes(["BATCHBID"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].price).toBe(150);
    expect(quotes[0].bid).toBeUndefined();
    expect(quotes[0].ask).toBeUndefined();
  });

  it("live Yahoo quote without quoteSummary enrichment carries no static-table PE/market-cap", async () => {
    // NVDA is in the static table (peTrailing 58.2, marketCap 3.16e12);
    // a live chart quote must not backfill those fields from the table.
    // Use a fresh chart-only stub on a symbol whose table row is NVDA
    // only via the quote path: chart payload symbol is NVDA here, and
    // the quote cache is keyed per symbol, so no earlier test may have
    // cached NVDA in this file (none does).
    stubFetchChartOnly("NVDA", 200);
    const quote = await new YahooFinanceProvider().getQuote("NVDA");
    expect(quote.provenance).toBe("live");
    expect(quote.trailingPE).toBeUndefined();
    expect(quote.marketCap).toBeUndefined();
  });
});

describe("S5 hybrid and snapshot live-only (#923)", () => {
  it("hybrid quote with a live price but failing fundamentals still serves the live price, without invented valuation fields", async () => {
    stubFetchChartOnly("HYBPRICE", 200);
    const quote = await new HybridMarketDataProvider({} as Env).getQuote("HYBPRICE");
    expect(quote.provenance).toBe("live");
    expect(quote.price).toBe(200);
    expect(quote.trailingPE).toBeUndefined();
    expect(quote.marketCap).toBeUndefined();
  });

  it("unconfigured Alpaca snapshot rejects — no profile snapshot", async () => {
    stubFetchDown();
    await expect(
      new AlpacaMarketDataProvider({} as Env).getMarketSnapshot("SNAPFAIL"),
    ).rejects.toThrow(/unavailable/i);
  });

  it("offline research report rejects — no non-live report is assembled", async () => {
    stubFetchDown();
    await expect(new MarketDataResearchService({} as Env).generateResearchReport("REPOFF")).rejects.toThrow(
      /unavailable/i,
    );
  });
});
