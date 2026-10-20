/**
 * Issue #259: shared screener pipeline — single implementations used by
 * both manual and scheduled triggers. No duplicated mapping/filter logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  acquireUniverse,
  screenUniverse,
  toScannedStock,
  toOpportunityStock,
  selectStandouts,
  buildAllStocks,
} from "../src/trading/screenerPipeline";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ETradeQuote, ScreenedStockItem } from "../src/types";

function makeQuote(overrides: Partial<ETradeQuote> = {}): ETradeQuote {
  return {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation",
    lastPrice: 217.23,
    price: 217.23,
    change: -4.07,
    changePercent: -1.84,
    bid: 0,
    ask: 0,
    volume: 0,
    open: 0,
    high: 0,
    low: 0,
    source: "Nasdaq (E*TRADE failed)",
    quoteStatus: "AS_OF_UNKNOWN",
    ...overrides,
  } as ETradeQuote;
}

function makeScreened(overrides: Partial<ScreenedStockItem> = {}): ScreenedStockItem {
  return {
    ...makeQuote(),
    rsi14: 41,
    macdSignal: "MACD unavailable from listing feed",
    signal: "RANGE_BOUND",
    technicalSignal: "RSI neutral",
    momentumScore: 41,
    highlightReason: "test",
    ...overrides,
  } as ScreenedStockItem;
}

describe("screenerPipeline — shared shaping (#259)", () => {
  it("toScannedStock maps with screened enrichment", () => {
    const s = toScannedStock(makeQuote(), makeScreened({ signal: "BULLISH_MOMENTUM", momentumScore: 72, rsi14: 55 }));
    expect(s.symbol).toBe("NVDA");
    expect(s.signal).toBe("BULLISH_MOMENTUM");
    expect(s.momentumScore).toBe(72);
    expect(s.rsi14).toBe(55);
    expect(s.source).toBe("Nasdaq (E*TRADE failed)");
  });

  it("toScannedStock defaults when no screened data", () => {
    const s = toScannedStock(makeQuote());
    expect(s.signal).toBe("unknown");
    expect(s.momentumScore).toBe(0);
    expect(s.rsi14).toBeNull();
  });

  it("toOpportunityStock maps the opportunity shape", () => {
    const o = toOpportunityStock(makeScreened());
    // Issue #261: opportunities carry screening indicators.
    expect(o).toEqual({
      symbol: "NVDA",
      companyName: "NVIDIA Corporation",
      signal: "RANGE_BOUND",
      momentumScore: 41,
      lastPrice: 217.23,
      changePercent: -1.84,
      indicators: expect.objectContaining({
        sentiment: expect.any(String),
        directional: expect.any(Boolean),
        rangeZone: expect.any(String),
        valueZone: expect.any(String),
        screenScore: expect.any(Number),
        summary: expect.any(String),
      }),
      // Issue #266: single-stock mapping carries empty grades; the
      // universe-relative computation happens in attachFactorGrades.
      factorGrades: expect.objectContaining({
        value: null,
        momentum: null,
        growth: null,
        profitability: null,
        revisions: null,
        quantRating: null,
        gradedFactors: [],
      }),
      // Issue #269: technicals ride along (empty until attachTechnicals).
      technicals: expect.objectContaining({
        rsi14: null,
        macdLine: null,
        gapPercent: null,
        gapDirection: null,
        historySource: null,
      }),
    });
  });

  it("attachFactorGrades grades the universe percentile-relative", async () => {
    const { attachFactorGrades } = await import("../src/trading/screenerPipeline");
    const stocks = [
      toScannedStock(
        {
          symbol: "CHEAP",
          companyName: "Cheap Co",
          lastPrice: 10,
          changePercent: 5,
          source: "E*TRADE live",
          open: 9.5, high: 10.5, low: 9,
          week52High: 50, week52Low: 9,
          peRatio: 8, volume: 1000,
        } as any,
        null
      ),
      toScannedStock(
        {
          symbol: "PRICEY",
          companyName: "Pricey Co",
          lastPrice: 48,
          changePercent: -3,
          source: "E*TRADE live",
          open: 49, high: 50, low: 47,
          week52High: 50, week52Low: 9,
          peRatio: 55, volume: 1000,
        } as any,
        null
      ),
      toScannedStock(
        {
          symbol: "MID",
          companyName: "Mid Co",
          lastPrice: 25,
          changePercent: 0.5,
          source: "E*TRADE live",
          open: 24.8, high: 25.5, low: 24.5,
          week52High: 50, week52Low: 9,
          peRatio: 22, volume: 1000,
        } as any,
        null
      ),
    ];
    const graded = attachFactorGrades(stocks);
    const cheap = graded.find((s) => s.symbol === "CHEAP")!;
    const pricey = graded.find((s) => s.symbol === "PRICEY")!;
    // Cheap (low P/E, near 52w low) outranks pricey on value.
    expect(cheap.factorGrades.valueScore!).toBeGreaterThan(
      pricey.factorGrades.valueScore!
    );
    expect(cheap.factorGrades.growth).toBeNull();
    expect(cheap.factorGrades.quantRating).toBeTruthy();
  });

  it("selectStandouts keeps only standout signals/scores, capped", () => {
    const stocks = [
      makeScreened({ symbol: "A", signal: "OVERSOLD_BOUNCE" }),
      makeScreened({ symbol: "B", signal: "BULLISH_MOMENTUM" }),
      makeScreened({ symbol: "C", signal: "RANGE_BOUND", momentumScore: 65 }),
      makeScreened({ symbol: "D", signal: "RANGE_BOUND", momentumScore: 41 }),
      makeScreened({ symbol: "E", signal: "OVERBOUGHT", momentumScore: 90 }),
    ];
    const out = selectStandouts(stocks, 10);
    expect(out.map((s) => s.symbol).sort()).toEqual(["A", "B", "C", "E"]);
    expect(selectStandouts(stocks, 2).length).toBe(2);
  });

  it("buildAllStocks joins quotes with screened fields by symbol", () => {
    const quotes = [makeQuote({ symbol: "A" }), makeQuote({ symbol: "B" })];
    const screened = [makeScreened({ symbol: "A", signal: "BULLISH_MOMENTUM", momentumScore: 70, rsi14: 60 })];
    const all = buildAllStocks(quotes, screened);
    expect(all.length).toBe(2);
    expect(all[0].signal).toBe("BULLISH_MOMENTUM");
    expect(all[0].rsi14).toBe(60);
    expect(all[1].signal).toBe("unknown"); // B didn't survive filtering
  });
});

describe("screenerPipeline — acquireUniverse live-quotes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires via E*TRADE-primary with Nasdaq fallback", async () => {
    const screener = new DynamicMarketScreener();
    const listings = [
      { symbol: "NVDA", companyName: "NVIDIA Corp", exchange: "NASDAQ", lastPrice: 100, change: 1, changePercent: 1, marketCap: 1e12 },
      { symbol: "AAPL", companyName: "Apple Inc", exchange: "NASDAQ", lastPrice: 200, change: 2, changePercent: 1, marketCap: 2e12 },
    ] as any[];
    const liveDeps = {
      fetchETradeQuote: vi.fn(async (sym: string) => {
        if (sym === "NVDA") return makeQuote({ symbol: "NVDA" });
        throw new Error("E*TRADE unavailable");
      }),
    };
    // Mock the symbol source via the symbols option (avoids live network).
    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: listings,
      maxSymbols: 50,
      liveDeps,
    });
    expect(acquired.quotes.length).toBe(2);
    expect(acquired.discovery.mode).toBe("live_quotes");
    // NVDA via E*TRADE, AAPL via Nasdaq fallback
    const bySym = new Map(acquired.quotes.map((q) => [q.symbol, q]));
    expect(bySym.get("NVDA")?.source).toBe("E*TRADE live");
    expect(bySym.get("AAPL")?.source).toContain("Nasdaq");
    expect(screener).toBeTruthy();
  });

  it("screenUniverse runs the shared filter engine on acquired quotes", async () => {
    const screener = new DynamicMarketScreener();
    const acquired = await acquireUniverse({
      mode: "live-quotes",
      symbols: [],
      liveDeps: { fetchETradeQuote: vi.fn(async () => null) },
    });
    const result = screenUniverse(screener, acquired, {});
    expect(result.totalScanned).toBe(0);
    expect(result.stocks).toEqual([]);
  });

  it("includes categorized broker failures when no E*TRADE quotes are returned", async () => {
    await expect(acquireUniverse({
      mode: "etrade-only",
      symbols: [
        { symbol: "NVDA", companyName: "NVIDIA", exchange: "NASDAQ" },
        { symbol: "AAPL", companyName: "Apple", exchange: "NASDAQ" },
      ] as any,
      liveDeps: {
        fetchETradeQuote: async () => { throw new Error("E*TRADE Session Expired [HTTP 401]"); },
      },
    })).rejects.toThrow("failure reasons: auth=2");
  });

  it("returns a qualified partial result when only part of the universe quotes (#462)", async () => {
    const acquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: [
        { symbol: "NVDA", companyName: "NVIDIA", exchange: "NASDAQ" },
        { symbol: "AAPL", companyName: "Apple", exchange: "NASDAQ" },
        { symbol: "MSFT", companyName: "Microsoft", exchange: "NASDAQ" },
      ] as any,
      liveDeps: {
        fetchETradeQuote: async (sym: string) => {
          if (sym === "AAPL") throw new Error("E*TRADE Quote API Error [HTTP 500]");
          return makeQuote({ symbol: sym });
        },
      },
    });
    // The screen runs on the quoted subset — no throw, no fallback.
    expect(acquired.quotes.map((q) => q.symbol).sort()).toEqual(["MSFT", "NVDA"]);
    expect(acquired.partial).toBeDefined();
    expect(acquired.partial!.quotedCount).toBe(2);
    expect(acquired.partial!.requestedCount).toBe(3);
    expect(acquired.partial!.failedSymbols).toEqual(["AAPL"]);
    // HTTP 500 categorizes as an upstream E*TRADE failure, not "other" (#462).
    expect(acquired.partial!.failureReasons["api-http-5xx"]).toBe(1);
    expect(acquired.partial!.failureReasons.other).toBeUndefined();
    expect(acquired.discovery.message).toContain("Partial screen");
    expect(acquired.discovery.message).toContain("qualified");
  });

  it("returns no partial qualification when the full universe quotes (#462)", async () => {
    const acquired = await acquireUniverse({
      mode: "etrade-only",
      symbols: [
        { symbol: "NVDA", companyName: "NVIDIA", exchange: "NASDAQ" },
      ] as any,
      liveDeps: {
        fetchETradeQuote: async (sym: string) => makeQuote({ symbol: sym }),
      },
    });
    expect(acquired.quotes.length).toBe(1);
    expect(acquired.partial).toBeUndefined();
    expect(acquired.discovery.message).not.toContain("Partial screen");
  });
});
