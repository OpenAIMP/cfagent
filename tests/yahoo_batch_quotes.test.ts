/**
 * Issue #1184 (#1173 R2): Yahoo batch-first acquisition.
 *
 * The 2026-10-23 incident: per-symbol-only fetching fired 200–300
 * requests for a 100-symbol screen and Yahoo throttled it to 25%.
 * Pins: batch covers the universe in chunk requests; omissions and
 * batch failures fall back per-symbol; non-live batch rows are
 * refused by the provenance gate and fall back too; results come
 * back in input order; the provider binder wires getQuotes only
 * when the provider has it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchYahooQuotes,
  yahooDepsFromProvider,
  type YahooScreenerDeps,
} from "../src/trading/screenerPipeline";
import type { MarketDataResearchQuote } from "../src/types";

function liveQuote(symbol: string, price = 100): MarketDataResearchQuote {
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    companyName: `${symbol} Inc.`,
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    bid: price - 0.05,
    ask: price + 0.05,
    volume: 1000,
    open: price,
    high: price,
    low: price,
    previousClose: price - 1,
    timestamp: new Date().toISOString(),
    currency: "USD",
  };
}

const fastPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
const noSleep = async () => {};

function deps(over: Partial<YahooScreenerDeps>): YahooScreenerDeps {
  return {
    fetchYahooQuote: async (s: string) => liveQuote(s),
    retryPolicy: fastPolicy,
    retrySleep: noSleep,
    ...over,
  };
}

describe("fetchYahooQuotes — batch first", () => {
  it("100 symbols are covered by 2 batch requests; per-symbol never called", async () => {
    const symbols = Array.from({ length: 100 }, (_, i) => `S${i}`);
    const batch = vi.fn(async (chunk: string[]) => chunk.map((s) => liveQuote(s)));
    const single = vi.fn(async (s: string) => liveQuote(s));
    const out = await fetchYahooQuotes(symbols, deps({ fetchYahooBatchQuotes: batch, fetchYahooQuote: single }));
    expect(out).toHaveLength(100);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(single).not.toHaveBeenCalled();
    expect(out.map((q) => q.symbol)).toEqual(symbols);
  });

  it("symbols a batch response omits fall back per-symbol", async () => {
    const symbols = ["AAA", "BBB", "CCC"];
    const batch = vi.fn(async () => [liveQuote("AAA"), liveQuote("CCC")]);
    const single = vi.fn(async (s: string) => liveQuote(s));
    const out = await fetchYahooQuotes(symbols, deps({ fetchYahooBatchQuotes: batch, fetchYahooQuote: single }));
    expect(out.map((q) => q.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledWith("BBB");
  });

  it("a failing batch chunk falls back per-symbol for the whole chunk", async () => {
    const symbols = ["AAA", "BBB"];
    const batch = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    const single = vi.fn(async (s: string) => liveQuote(s));
    const out = await fetchYahooQuotes(symbols, deps({ fetchYahooBatchQuotes: batch, fetchYahooQuote: single }));
    expect(out).toHaveLength(2);
    expect(single).toHaveBeenCalledTimes(2);
  });

  it("batch chunks retry under the acquisition policy before falling back", async () => {
    let calls = 0;
    const batch = vi.fn(async (chunk: string[]) => {
      calls++;
      if (calls === 1) throw new Error("HTTP 429");
      return chunk.map((s) => liveQuote(s));
    });
    const single = vi.fn(async (s: string) => liveQuote(s));
    const out = await fetchYahooQuotes(
      ["AAA"],
      deps({
        fetchYahooBatchQuotes: batch,
        fetchYahooQuote: single,
        retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      })
    );
    expect(out).toHaveLength(1);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(single).not.toHaveBeenCalled();
  });

  it("non-live batch rows are refused and fall back per-symbol", async () => {
    const staticQuote = { ...liveQuote("AAA"), provenance: "static" as const };
    const batch = vi.fn(async () => [staticQuote]);
    const single = vi.fn(async (s: string) => liveQuote(s));
    const out = await fetchYahooQuotes(["AAA"], deps({ fetchYahooBatchQuotes: batch, fetchYahooQuote: single }));
    expect(out).toHaveLength(1);
    expect(single).toHaveBeenCalledWith("AAA");
  });

  it("without a batch fetcher, behavior is the per-symbol path", async () => {
    const single = vi.fn(async (s: string) => liveQuote(s));
    const out = await fetchYahooQuotes(["AAA", "BBB"], deps({ fetchYahooQuote: single }));
    expect(out).toHaveLength(2);
    expect(single).toHaveBeenCalledTimes(2);
  });
});

describe("yahooDepsFromProvider", () => {
  it("binds getQuotes as the batch fetcher when the provider has one", () => {
    const bound = yahooDepsFromProvider({
      getQuote: async (s: string) => liveQuote(s),
      getQuotes: async (syms: string[]) => syms.map((s) => liveQuote(s)),
    });
    expect(typeof bound.fetchYahooBatchQuotes).toBe("function");
  });

  it("omits the batch fetcher when the provider lacks getQuotes", () => {
    const bound = yahooDepsFromProvider({ getQuote: async (s: string) => liveQuote(s) });
    expect(bound.fetchYahooBatchQuotes).toBeUndefined();
  });
});
