/**
 * Issue #1654 slice 2/8 — Anchored VWAP (52-week low)
 * (docs/architecture/business/screener-rules.md; fit-gap Gap 2).
 *
 * TDD red→green: AVWAP math on known bar series (volume weighting,
 * anchor selection on ties, zero-volume / empty / short-window
 * cases) plus filter rejections incl. fail-closed on missing data.
 * The gate runs on an item-attached value computed upstream where
 * real bars exist — evaluateUniverse itself sees no bar history and
 * never fabricates it (slice 8 owns the upstream enrichment).
 */
import { describe, it, expect } from "vitest";
import {
  computeAnchoredVwapFrom52wLow,
  type YahooDailyBar,
} from "../src/trading/technicals";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";

function bar(low: number, close: number, volume: number): YahooDailyBar {
  return { date: "2026-10-26", open: close, high: Math.max(low, close), low, close, volume };
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

describe("computeAnchoredVwapFrom52wLow", () => {
  it("volume-weights closes from the 52-week low bar forward, excluding earlier bars", () => {
    const bars = [bar(10, 12, 100), bar(8, 9, 200), bar(11, 11, 100)];
    // Anchor is bar 2 (low 8); bar 1 is before the anchor and excluded.
    // (9×200 + 11×100) / 300 = 2900/300 ≈ 9.666667.
    expect(computeAnchoredVwapFrom52wLow(bars)).toBeCloseTo(9.666667, 6);
  });

  it("on a tie for the lowest low, anchors at the earliest such bar", () => {
    const bars = [bar(5, 10, 100), bar(5, 20, 100), bar(6, 30, 100)];
    // Earliest anchor (bar 1): (10+20+30)/3 = 20. A latest-tie anchor
    // would give (20+30)/2 = 25 — the tie rule is pinned, not assumed.
    expect(computeAnchoredVwapFrom52wLow(bars)).toBeCloseTo(20, 6);
  });

  it("anchors at the last bar when the low is last (anchor-only window)", () => {
    expect(computeAnchoredVwapFrom52wLow([bar(10, 12, 100), bar(9, 8, 50)])).toBeCloseTo(8, 6);
  });

  it("zero-volume bars after the anchor contribute nothing", () => {
    const bars = [bar(10, 12, 100), bar(8, 9, 100), bar(9, 50, 0)];
    // Anchor bar 2: (9×100 + 50×0) / 100 = 9.
    expect(computeAnchoredVwapFrom52wLow(bars)).toBeCloseTo(9, 6);
  });

  it("returns null on empty input", () => {
    expect(computeAnchoredVwapFrom52wLow([])).toBeNull();
  });

  it("returns null when total volume from the anchor is zero (never divides by zero)", () => {
    expect(computeAnchoredVwapFrom52wLow([bar(10, 12, 0), bar(8, 9, 0)])).toBeNull();
  });

  it("returns null on negative volume (invalid data, not a weight)", () => {
    expect(computeAnchoredVwapFrom52wLow([bar(10, 12, 100), bar(8, 9, -50)])).toBeNull();
  });

  it("returns null on a non-finite close", () => {
    expect(computeAnchoredVwapFrom52wLow([bar(10, 12, 100), bar(8, Number.NaN, 100)])).toBeNull();
  });

  it("a window shorter than 52 weeks still anchors at its own lowest low (documented, not refused)", () => {
    // The 52-week qualifier is the caller's window responsibility: the
    // function anchors at the lowest low of the bars it is given.
    const bars = [bar(10, 12, 100), bar(8, 9, 200), bar(11, 11, 100)];
    expect(computeAnchoredVwapFrom52wLow(bars)).toBeCloseTo(9.666667, 6);
  });

  it("a single bar with positive volume returns its own close", () => {
    expect(computeAnchoredVwapFrom52wLow([bar(8, 9, 100)])).toBeCloseTo(9, 6);
  });
});

describe("evaluateUniverse anchored-VWAP gate", () => {
  it("passes when lastPrice is above anchoredVwap", () => {
    const result = screen([makeItem({ lastPrice: 110, anchoredVwap: 100 })], {
      requireAboveAnchoredVwap: true,
    });
    expect(result.matchedCount).toBe(1);
    expect(result.ledger.rejections).toHaveLength(0);
  });

  it("rejects when lastPrice is below anchoredVwap, with an auditable reason", () => {
    const result = screen([makeItem({ lastPrice: 90, anchoredVwap: 100 })], {
      requireAboveAnchoredVwap: true,
    });
    expect(result.matchedCount).toBe(0);
    expect(result.ledger.rejections[0].reason).toMatch(/anchored vwap/i);
  });

  it("rejects at exact equality (Venus ruling 2026-10-26: strict — spot must remain strictly above AVWAP)", () => {
    const result = screen([makeItem({ lastPrice: 100, anchoredVwap: 100 })], {
      requireAboveAnchoredVwap: true,
    });
    expect(result.matchedCount).toBe(0);
    expect(result.ledger.rejections[0].reason).toMatch(/anchored vwap/i);
  });

  it("fail-closes when the gate is requested but no anchoredVwap is attached", () => {
    const result = screen([makeItem({ lastPrice: 110 })], {
      requireAboveAnchoredVwap: true,
    });
    expect(result.matchedCount).toBe(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });

  it("does not reject when the gate is unset, even below AVWAP or with no data", () => {
    const result = screen(
      [makeItem({ lastPrice: 90, anchoredVwap: 100 }), makeItem({ symbol: "TEST2", lastPrice: 110 })],
      {}
    );
    expect(result.matchedCount).toBe(2);
    expect(result.ledger.rejections).toHaveLength(0);
  });

  it("names the gate in the filter summary when set", () => {
    const result = screen([makeItem({ lastPrice: 110, anchoredVwap: 100 })], {
      requireAboveAnchoredVwap: true,
    });
    expect(result.filterSummary).toMatch(/Anchored VWAP/i);
  });
});
