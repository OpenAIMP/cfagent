/**
 * Issue #1654 slice 5/8 — HH/HL Regime Classification (UP/DN/RNG)
 * (docs/architecture/business/screener-rules.md; fit-gap Gap 4).
 *
 * TDD red→green: regime classification on known bar series (UP/DN/RNG,
 * flat, equality boundary, last-20-only, insufficient/invalid data),
 * evaluateUniverse regime-filter wiring incl. fail-closed on missing
 * data, and the bullish-spread rule (defined + tested in
 * directionTags.ts; pipeline enforcement wiring belongs to slice 8,
 * which threads per-underlying regime into the options scan).
 */
import { describe, it, expect } from "vitest";
import {
  classifyPriceRegime,
  type YahooDailyBar,
} from "../src/trading/technicals";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem } from "../src/types";
import {
  isBullishSpreadStrategy,
  isStrategyAllowedUnderRegime,
} from "../src/trading/options/strategies/directionTags";

function bar(high: number, low: number): YahooDailyBar {
  return {
    date: "2026-01-01",
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1000,
  };
}

/** First 10 bars lower, second 10 strictly higher (highs and lows). */
function risingBars(): YahooDailyBar[] {
  const bars: YahooDailyBar[] = [];
  for (let i = 0; i < 10; i++) bars.push(bar(100 + i, 90 + i));
  for (let i = 0; i < 10; i++) bars.push(bar(110 + i, 100 + i));
  return bars;
}

/** First 10 bars higher, second 10 strictly lower (highs and lows). */
function fallingBars(): YahooDailyBar[] {
  const bars: YahooDailyBar[] = [];
  for (let i = 0; i < 10; i++) bars.push(bar(119 - i, 109 - i));
  for (let i = 0; i < 10; i++) bars.push(bar(109 - i, 99 - i));
  return bars;
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

describe("classifyPriceRegime", () => {
  it("classifies strictly rising highs and lows as UP", () => {
    expect(classifyPriceRegime(risingBars())).toBe("UP");
  });

  it("classifies strictly falling highs and lows as DN", () => {
    expect(classifyPriceRegime(fallingBars())).toBe("DN");
  });

  it("classifies higher highs with lower lows as RNG (mixed)", () => {
    const bars: YahooDailyBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(100 + i, 90 + i));
    for (let i = 0; i < 10; i++) bars.push(bar(110 + i, 80 + i));
    expect(classifyPriceRegime(bars)).toBe("RNG");
  });

  it("classifies lower highs with higher lows as RNG (mixed)", () => {
    const bars: YahooDailyBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(110 + i, 80 + i));
    for (let i = 0; i < 10; i++) bars.push(bar(100 + i, 90 + i));
    expect(classifyPriceRegime(bars)).toBe("RNG");
  });

  it("classifies a flat series as RNG (no strict movement)", () => {
    expect(
      classifyPriceRegime(Array.from({ length: 20 }, () => bar(100, 90)))
    ).toBe("RNG");
  });

  it("treats equal second-half extremes as RNG (strict inequalities)", () => {
    const bars: YahooDailyBar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(100 + i, 90 + i));
    // Second-half max high equals first-half max high (109); lows rise.
    for (let i = 0; i < 10; i++) bars.push(bar(100 + i, 100 + i));
    expect(classifyPriceRegime(bars)).toBe("RNG");
  });

  it("uses only the last 20 bars", () => {
    const prefix = Array.from({ length: 5 }, () => bar(1000, 900));
    expect(classifyPriceRegime([...prefix, ...risingBars()])).toBe("UP");
  });

  it("returns null on fewer than 20 bars, empty input, or non-finite extremes", () => {
    expect(classifyPriceRegime(risingBars().slice(0, 19))).toBeNull();
    expect(classifyPriceRegime([])).toBeNull();
    const badHigh = risingBars();
    badHigh[5] = bar(Number.NaN, 90);
    expect(classifyPriceRegime(badHigh)).toBeNull();
    const badLow = risingBars();
    badLow[15] = bar(110, Number.POSITIVE_INFINITY);
    expect(classifyPriceRegime(badLow)).toBeNull();
  });
});

describe("evaluateUniverse regime filter (#1654 slice 5)", () => {
  it("passes matching regimes and rejects mismatches", () => {
    const match = screen([makeItem({ regime: "UP" })], { regimeFilter: "UP" });
    expect(match.stocks).toHaveLength(1);
    const mismatch = screen([makeItem({ regime: "DN" })], { regimeFilter: "UP" });
    expect(mismatch.stocks).toHaveLength(0);
    expect(mismatch.ledger.rejections[0].reason).toMatch(/regime/i);
    expect(mismatch.ledger.rejections[0].reason).toMatch(/DN/);
  });

  it("fail-closes when a regime filter is set but the item carries no regime", () => {
    const result = screen([makeItem()], { regimeFilter: "UP" });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/i);
  });

  it("applies no rejection when no regime filter is set", () => {
    expect(screen([makeItem()], {}).stocks).toHaveLength(1);
    expect(screen([makeItem({ regime: "DN" })], {}).stocks).toHaveLength(1);
  });
});

describe("bullish-spread regime rule (directionTags.ts)", () => {
  it("identifies the bullish vertical spreads and only those", () => {
    expect(isBullishSpreadStrategy("call_debit_spread")).toBe(true);
    expect(isBullishSpreadStrategy("put_credit_spread")).toBe(true);
    // Bullish but not a spread; bearish vertical; range-bound stock play.
    expect(isBullishSpreadStrategy("long_call")).toBe(false);
    expect(isBullishSpreadStrategy("put_debit_spread")).toBe(false);
    expect(isBullishSpreadStrategy("covered_call")).toBe(false);
    expect(isBullishSpreadStrategy("unknown_strategy_id")).toBe(false);
  });

  it("blocks bullish spreads on DN underlyings and allows everything else", () => {
    expect(isStrategyAllowedUnderRegime("call_debit_spread", "DN")).toBe(false);
    expect(isStrategyAllowedUnderRegime("put_credit_spread", "DN")).toBe(false);
    expect(isStrategyAllowedUnderRegime("call_debit_spread", "UP")).toBe(true);
    expect(isStrategyAllowedUnderRegime("call_debit_spread", "RNG")).toBe(true);
    expect(isStrategyAllowedUnderRegime("call_debit_spread", null)).toBe(true);
    expect(isStrategyAllowedUnderRegime("long_call", "DN")).toBe(true);
    expect(isStrategyAllowedUnderRegime("put_debit_spread", "DN")).toBe(true);
    expect(isStrategyAllowedUnderRegime("unknown_strategy_id", "DN")).toBe(true);
  });
});
