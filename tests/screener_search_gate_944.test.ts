import { describe, expect, it } from "vitest";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";

function makeItem944(overrides: Partial<ScreenedStockItem> = {}): ScreenedStockItem {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    lastPrice: 100,
    price: 100,
    change: 1,
    changePercent: 1,
    bid: 99,
    ask: 101,
    volume: 1_000_000,
    open: 99,
    high: 101,
    low: 98,
    timestamp: "2026-10-27T00:00:00.000Z",
    macdSignal: "MACD unavailable from listing feed",
    signal: "RANGE_BOUND",
    technicalSignal: "RSI neutral",
    momentumScore: 50,
    highlightReason: "Test Co market listing",
    ...overrides,
  } as ScreenedStockItem;
}

const universe = [
  makeItem944({ symbol: "NVDA", companyName: "NVIDIA Corporation", sector: "Technology" }),
  makeItem944({ symbol: "AAPL", companyName: "Apple Inc.", sector: "Technology" }),
  makeItem944({ symbol: "JNJ", companyName: "Johnson & Johnson", sector: "Healthcare" }),
];

describe("Search gate vs sector/universe screens (#944)", () => {
  it("a sector-only screen never trips the search gate", () => {
    const result = new DynamicMarketScreener(universe).screenStocks({ sector: "Technology" } as never);
    const passed = result.stocks.map((s) => s.symbol);
    expect(passed).toContain("NVDA");
    expect(passed).toContain("AAPL");
    expect(passed).not.toContain("JNJ");
    expect(result.ledger.rejections.filter((r) => r.reason.includes("Search mismatch"))).toEqual([]);
    expect(result.ledger.rejections.find((r) => r.symbol === "JNJ")?.reason).toMatch(/does not match requested/);
  });

  it("a universe screen with no search term produces zero Search-mismatch rejections", () => {
    const result = new DynamicMarketScreener(universe).screenStocks({} as never);
    expect(result.ledger.rejections.filter((r) => r.reason.includes("Search mismatch"))).toEqual([]);
    expect(result.stocks.map((s) => s.symbol)).toEqual(["NVDA", "AAPL", "JNJ"]);
  });

  it("free-text search still filters by symbol/name", () => {
    const result = new DynamicMarketScreener(universe).screenStocks({ search: "NVDA" } as never);
    expect(result.stocks.map((s) => s.symbol)).toEqual(["NVDA"]);
    expect(result.ledger.rejections.find((r) => r.symbol === "AAPL")?.reason).toBe('Search mismatch for "NVDA"');
    expect(result.ledger.rejections.find((r) => r.symbol === "JNJ")?.reason).toBe('Search mismatch for "NVDA"');
  });
});
