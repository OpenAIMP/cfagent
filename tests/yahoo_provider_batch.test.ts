/**
 * Issue #1184 (#1173 R2): YahooFinanceProvider.getQuotes — the v7
 * batch endpoint behind one crumb session. Pins the field mapping
 * (price/change/volume/marketCap/trailingPE from the batch payload,
 * indicators deliberately unset), the live-only selection, and the
 * throw-on-batch-failure contract the caller's retry/fallback
 * policy relies on.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { YahooFinanceProvider } from "../src/services/marketDataResearch";

const quotePayload = {
  quoteResponse: {
    result: [
      {
        symbol: "BAAA",
        longName: "Batch Alpha Inc.",
        regularMarketPrice: 150.25,
        regularMarketPreviousClose: 148.0,
        regularMarketChange: 2.25,
        regularMarketChangePercent: 1.52,
        regularMarketVolume: 1234567,
        regularMarketOpen: 149.0,
        regularMarketDayHigh: 151.0,
        regularMarketDayLow: 148.5,
        bid: 150.2,
        ask: 150.3,
        trailingPE: 22.5,
        marketCap: 987654321,
        currency: "USD",
      },
      {
        symbol: "BBBB",
        shortName: "Batch Beta",
        regularMarketPrice: 0, // dead row — must be omitted
        regularMarketPreviousClose: 10,
      },
      {
        symbol: "ZZZZ", // not requested — must be omitted
        regularMarketPrice: 42,
        regularMarketPreviousClose: 40,
      },
    ],
    error: null,
  },
};

function stubYahoo(batchStatus = 200) {
  vi.stubGlobal("fetch", async (url: string) => {
    // Route by parsed hostname + exact pathname (never raw URL
    // substring matching — CodeQL incomplete-sanitization rule).
    const u = new URL(String(url));
    if (u.hostname === "fc.yahoo.com") {
      return { ok: true, status: 200, headers: { get: () => "A3=testcookie" } };
    }
    if (u.hostname === "query1.finance.yahoo.com" && u.pathname === "/v1/test/getcrumb") {
      return { ok: true, status: 200, text: async () => "testcrumb" };
    }
    if (u.hostname === "query1.finance.yahoo.com" && u.pathname === "/v7/finance/quote") {
      return {
        ok: batchStatus >= 200 && batchStatus < 300,
        status: batchStatus,
        json: async () => quotePayload,
      };
    }
    throw new Error(`unexpected fetch: ${u.toString()}`);
  });
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("YahooFinanceProvider.getQuotes", () => {
  it("maps the batch payload to live MarketDataResearchQuotes; indicators stay unset", async () => {
    stubYahoo();
    const provider = new YahooFinanceProvider();
    const quotes = await provider.getQuotes(["BAAA", "BBBB"]);
    expect(quotes).toHaveLength(1);
    const q = quotes[0];
    expect(q.symbol).toBe("BAAA");
    expect(q.provenance).toBe("live");
    expect(q.provider).toBe("yfinance");
    expect(q.price).toBe(150.25);
    expect(q.change).toBe(2.25);
    expect(q.changePercent).toBe(1.52);
    expect(q.volume).toBe(1234567);
    expect(q.marketCap).toBe(987654321);
    expect(q.trailingPE).toBe(22.5);
    expect(q.bid).toBe(150.2);
    expect(q.ask).toBe(150.3);
    expect(q.rsi14).toBeUndefined();
    expect(q.macdSignal).toBeUndefined();
  });

  it("throws when the batch endpoint fails (caller policy decides next)", async () => {
    stubYahoo(429);
    const provider = new YahooFinanceProvider();
    await expect(provider.getQuotes(["CCCC"])).rejects.toThrow(/HTTP 429/);
  });

  it("returns [] for an empty request without any fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new YahooFinanceProvider();
    await expect(provider.getQuotes([])).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
