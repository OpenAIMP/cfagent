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
    });
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
});
