/**
 * Issue #1654 slice 3/8 — ATR% Volatility Gate
 * (docs/architecture/business/screener-rules.md §1.4 pre-market
 * momentum + fit-gap Gap 7: ATR% = ATR₁₄ / P × 100, gate [1.0%, 8.0%]).
 *
 * TDD red→green: ATR math on known bar series (true-range edge
 * cases — gap up/down, first-bar handling, Wilder smoothing) plus
 * filter rejections incl. fail-closed on missing data.
 * The gate runs on an item-attached value computed upstream where
 * real bars exist — evaluateUniverse itself sees no bar history and
 * never fabricates it (slice 8 owns the upstream enrichment).
 */
import { describe, it, expect } from "vitest";
import {
  computeAtr,
  type YahooDailyBar,
} from "../src/trading/technicals";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";

function bar(high: number, low: number, close: number, volume = 1000): YahooDailyBar {
  return { date: "2026-10-26", open: close, high, low, close, volume };
}

function makeItem(overrides: Partial<ScreenedStockItem> = {}): ScreenedStockItem {
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
    timestamp: "2026-10-26T00:00:00.000Z",
    macdSignal: "MACD unavailable from listing feed",
    signal: "RANGE_BOUND",
    technicalSignal: "RSI neutral",
    momentumScore: 50,
    highlightReason: "Test Co market listing",
    ...overrides,
  } as ScreenedStockItem;
}

function screen(items: ScreenedStockItem[], filter: Record<string, unknown>) {
  return new DynamicMarketScreener(items).screenStocks(filter as never);
}

/** 14 flat-range bars: every true range is 10, so ATR = 10. */
function flatBars(count = 14): YahooDailyBar[] {
  return Array.from({ length: count }, () => bar(110, 100, 105));
}

describe("computeAtr", () => {
  it("returns the mean true range on a flat-range series", () => {
    expect(computeAtr(flatBars())).toBeCloseTo(10, 6);
  });

  it("applies Wilder smoothing after the first period", () => {
    const bars = [...flatBars(14), bar(130, 100, 125)];
    // First ATR = 10 (mean of 14 TRs of 10). 15th TR = max(30, |130−105|, |100−105|) = 30.
    // Wilder: (10×13 + 30) / 14 = 160/14 ≈ 11.428571.
    expect(computeAtr(bars)).toBeCloseTo(160 / 14, 6);
  });

  it("uses the gap-up range when the gap dominates (high − prevClose)", () => {
    const bars = [bar(105, 95, 100), bar(112, 108, 110)];
    // TR_0 = 10. TR_1 = max(112−108=4, |112−100|=12, |108−100|=8) = 12.
    // Period 2: first ATR = (10 + 12) / 2 = 11.
    expect(computeAtr(bars, 2)).toBeCloseTo(11, 6);
  });

  it("uses the gap-down range when the gap dominates (|low − prevClose|)", () => {
    const bars = [bar(105, 95, 100), bar(98, 90, 92)];
    // TR_0 = 10. TR_1 = max(98−90=8, |98−100|=2, |90−100|=10) = 10.
    expect(computeAtr(bars, 2)).toBeCloseTo(10, 6);
  });

  it("treats the first bar's true range as high − low (no previous close)", () => {
    expect(computeAtr([bar(120, 100, 110)], 1)).toBeCloseTo(20, 6);
  });

  it("honors a custom period", () => {
    const bars = [bar(110, 100, 105), bar(110, 100, 105), bar(140, 100, 130)];
    // TRs: 10, 10, max(40, |140−105|=35, |100−105|=5) = 40.
    // Period 2: first ATR = 10, then (10×1 + 40) / 2 = 25.
    expect(computeAtr(bars, 2)).toBeCloseTo(25, 6);
  });

  it("ignores volume (ATR uses price ranges only)", () => {
    const bars = flatBars().map((b) => ({ ...b, volume: 0 }));
    expect(computeAtr(bars)).toBeCloseTo(10, 6);
  });

  it("returns null on empty input", () => {
    expect(computeAtr([])).toBeNull();
  });

  it("returns null when fewer than period bars are supplied", () => {
    expect(computeAtr(flatBars(13))).toBeNull();
  });

  it("returns null on a non-finite price field", () => {
    const bars = [...flatBars(13), { ...bar(110, 100, 105), close: Number.NaN }];
    expect(computeAtr(bars)).toBeNull();
  });

  it("returns null on a malformed bar (high below low)", () => {
    const bars = [...flatBars(13), bar(90, 100, 95)];
    expect(computeAtr(bars)).toBeNull();
  });

  it("returns null on an invalid period", () => {
    expect(computeAtr(flatBars(), 0)).toBeNull();
    expect(computeAtr(flatBars(), 2.5)).toBeNull();
  });
});

describe("ATR% gate in evaluateUniverse", () => {
  it("passes a candidate inside the doc range", () => {
    const result = screen([makeItem({ atrPct: 4.0 })], { minAtrPct: 1.0, maxAtrPct: 8.0 });
    expect(result.stocks.map((s) => s.symbol)).toContain("TEST");
  });

  it("passes on inclusive bounds (1.0 and 8.0 are in the range)", () => {
    expect(screen([makeItem({ atrPct: 1.0 })], { minAtrPct: 1.0, maxAtrPct: 8.0 }).stocks.length).toBe(1);
    expect(screen([makeItem({ atrPct: 8.0 })], { minAtrPct: 1.0, maxAtrPct: 8.0 }).stocks.length).toBe(1);
  });

  it("rejects below the minimum", () => {
    const result = screen([makeItem({ atrPct: 0.5 })], { minAtrPct: 1.0, maxAtrPct: 8.0 });
    expect(result.stocks.length).toBe(0);
    expect(result.ledger?.rejections.map((r) => r.symbol)).toContain("TEST");
  });

  it("rejects above the maximum", () => {
    const result = screen([makeItem({ atrPct: 9.5 })], { minAtrPct: 1.0, maxAtrPct: 8.0 });
    expect(result.stocks.length).toBe(0);
    expect(result.ledger?.rejections.map((r) => r.symbol)).toContain("TEST");
  });

  it("defaults the unset bound to the doc range (min set only → max 8.0)", () => {
    expect(screen([makeItem({ atrPct: 9.5 })], { minAtrPct: 1.0 }).stocks.length).toBe(0);
    expect(screen([makeItem({ atrPct: 7.0 })], { minAtrPct: 1.0 }).stocks.length).toBe(1);
  });

  it("defaults the unset bound to the doc range (max set only → min 1.0)", () => {
    expect(screen([makeItem({ atrPct: 0.5 })], { maxAtrPct: 8.0 }).stocks.length).toBe(0);
    expect(screen([makeItem({ atrPct: 2.0 })], { maxAtrPct: 8.0 }).stocks.length).toBe(1);
  });

  it("fail-closes when atrPct data is missing", () => {
    const result = screen([makeItem()], { minAtrPct: 1.0, maxAtrPct: 8.0 });
    expect(result.stocks.length).toBe(0);
    expect(result.ledger?.rejections.map((r) => r.symbol)).toContain("TEST");
  });

  it("fail-closes on a non-finite atrPct", () => {
    const result = screen([makeItem({ atrPct: Number.NaN })], { minAtrPct: 1.0, maxAtrPct: 8.0 });
    expect(result.stocks.length).toBe(0);
  });

  it("does not reject when neither bound is set", () => {
    const result = screen([makeItem()], {});
    expect(result.stocks.map((s) => s.symbol)).toContain("TEST");
  });
});
