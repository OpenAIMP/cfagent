/**
 * Issue #1654 slice 1/7 — Bollinger Bands (20, 2.0), %B Extension Gate,
 * Squeeze Gate (docs/architecture/business/screener-rules.md §1.1).
 *
 * TDD red→green: band math on known series, %B edge cases (flat series /
 * zero bandwidth), filter rejections incl. the squeeze gate. The squeeze
 * gate is bandwidth at its lookback minimum — never "current bandwidth
 * is low" and never fabricated history.
 */
import { describe, it, expect } from "vitest";
import {
  computeBollingerBands,
  computeBollingerSqueezeGate,
} from "../src/trading/technicals";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";

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

describe("computeBollingerBands", () => {
  it("computes SMA-20 bands with population sigma on 1..20", () => {
    const bands = computeBollingerBands(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(bands).not.toBeNull();
    expect(bands!.middle).toBeCloseTo(10.5, 6);
    expect(bands!.upper).toBeCloseTo(22.032563, 6);
    expect(bands!.lower).toBeCloseTo(-1.032563, 6);
    expect(bands!.percentB).toBeCloseTo(0.911877, 6);
    expect(bands!.bandwidth).toBeCloseTo(2.196679, 6);
  });

  it("uses only the last `period` closes", () => {
    // 30 closes: first 10 are noise, last 20 are 1..20.
    const closes = [...Array.from({ length: 10 }, () => 1000), ...Array.from({ length: 20 }, (_, i) => i + 1)];
    const bands = computeBollingerBands(closes);
    expect(bands!.middle).toBeCloseTo(10.5, 6);
    expect(bands!.percentB).toBeCloseTo(0.911877, 6);
  });

  it("honors custom period and stdDev", () => {
    const bands = computeBollingerBands([10, 12, 11, 13, 12], 5, 1.0);
    expect(bands!.middle).toBeCloseTo(11.6, 6);
    expect(bands!.upper).toBeCloseTo(12.619804, 6);
    expect(bands!.lower).toBeCloseTo(10.580196, 6);
    expect(bands!.percentB).toBeCloseTo(0.696116, 6);
    expect(bands!.bandwidth).toBeCloseTo(0.175828, 6);
  });

  it("flat series: zero bandwidth, %B at the middle (0.5), not NaN", () => {
    const bands = computeBollingerBands(Array(20).fill(100));
    expect(bands!.middle).toBe(100);
    expect(bands!.upper).toBe(100);
    expect(bands!.lower).toBe(100);
    expect(bands!.percentB).toBe(0.5);
    expect(bands!.bandwidth).toBe(0);
  });

  it("returns null on insufficient or invalid data", () => {
    expect(computeBollingerBands([])).toBeNull();
    expect(computeBollingerBands(Array(19).fill(100))).toBeNull();
    expect(computeBollingerBands([...Array(19).fill(100), Number.NaN])).toBeNull();
    expect(computeBollingerBands(Array(20).fill(100), 0)).toBeNull();
    expect(computeBollingerBands(Array(20).fill(100), 20, -1)).toBeNull();
  });
});

describe("computeBollingerSqueezeGate", () => {
  it("is a squeeze when current bandwidth is the lookback minimum", () => {
    // Narrowing series: bandwidth strictly decreases toward the end,
    // so the last bandwidth is the minimum over the window.
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
      // Shrinking oscillation around a rising drift.
      closes.push(price + (i % 2 === 0 ? 1 : -1) * Math.max(0.1, 5 - i * 0.12));
      price += 0.2;
    }
    const gate = computeBollingerSqueezeGate(closes);
    expect(gate).not.toBeNull();
    expect(gate!.isSqueeze).toBe(true);
    expect(gate!.bandwidth).toBeLessThanOrEqual(gate!.bandwidthMin + 1e-12);
    expect(gate!.barsUsed).toBe(40);
  });

  it("is not a squeeze when current bandwidth exceeds the minimum", () => {
    // Wide oscillation at the end after a long flat stretch: the last
    // bandwidth is far above the earlier minimum.
    const closes = [...Array(30).fill(100), 90, 110, 90, 110, 90, 110, 90, 110, 90, 110];
    const gate = computeBollingerSqueezeGate(closes);
    expect(gate).not.toBeNull();
    expect(gate!.isSqueeze).toBe(false);
    expect(gate!.bandwidth).toBeGreaterThan(gate!.bandwidthMin);
  });

  it("returns null below the two-bandwidth-point floor", () => {
    // 20 closes = exactly one bandwidth value: a "minimum" over one
    // point would be trivially true, so the gate refuses to answer.
    expect(computeBollingerSqueezeGate(Array(20).fill(100))).toBeNull();
    expect(computeBollingerSqueezeGate(Array(10).fill(100))).toBeNull();
  });
});

describe("evaluateUniverse Bollinger gates (#1654 slice 1)", () => {
  it("rejects overextended candidates (%B above the 1.0 default cap)", () => {
    const result = screen([makeItem({ percentB: 1.25 })], { minPercentB: 0 });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/overextended/i);
    expect(result.ledger.rejections[0].reason).toMatch(/1\.25/);
  });

  it("rejects candidates below minPercentB", () => {
    const result = screen([makeItem({ percentB: 0.1 })], { minPercentB: 0.2 });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/below minimum/i);
  });

  it("honors an explicit maxPercentB tighter than 1.0", () => {
    const result = screen([makeItem({ percentB: 0.95 })], { maxPercentB: 0.9 });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/above maximum/i);
  });

  it("passes in-gate %B and keeps default behavior when no %B filter is set", () => {
    const gated = screen([makeItem({ percentB: 0.5 })], { minPercentB: 0.2, maxPercentB: 0.9 });
    expect(gated.stocks).toHaveLength(1);
    const ungated = screen([makeItem()], {});
    expect(ungated.stocks).toHaveLength(1);
  });

  it("fail-closes when a %B gate is set but the item carries no band data", () => {
    const result = screen([makeItem()], { maxPercentB: 1.0 });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });

  it("squeeze gate passes at the minimum, rejects above it", () => {
    const atMin = screen(
      [makeItem({ bollingerBandwidth: 0.05, bollingerBandwidthMin: 0.05, bollingerBarsUsed: 30 })],
      { requireSqueezeGate: true }
    );
    expect(atMin.stocks).toHaveLength(1);
    const aboveMin = screen(
      [makeItem({ bollingerBandwidth: 0.08, bollingerBandwidthMin: 0.05, bollingerBarsUsed: 30 })],
      { requireSqueezeGate: true }
    );
    expect(aboveMin.stocks).toHaveLength(0);
    expect(aboveMin.ledger.rejections[0].reason).toMatch(/squeeze/i);
  });

  it("squeeze gate fail-closes on missing data or insufficient history", () => {
    const missing = screen([makeItem()], { requireSqueezeGate: true });
    expect(missing.stocks).toHaveLength(0);
    expect(missing.ledger.rejections[0].reason).toMatch(/unavailable/i);
    const short = screen(
      [makeItem({ bollingerBandwidth: 0.05, bollingerBandwidthMin: 0.05, bollingerBarsUsed: 15 })],
      { requireSqueezeGate: true }
    );
    expect(short.stocks).toHaveLength(0);
    expect(short.ledger.rejections[0].reason).toMatch(/insufficient history/i);
  });

  it("no squeeze rejection when the gate is not requested", () => {
    const result = screen([makeItem({ bollingerBandwidth: 0.5, bollingerBandwidthMin: 0.05, bollingerBarsUsed: 30 })], {});
    expect(result.stocks).toHaveLength(1);
  });
});
