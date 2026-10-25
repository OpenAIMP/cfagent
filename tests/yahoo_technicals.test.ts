/**
 * Issue #269 — Yahoo history complement: gap classification, RSI/MACD
 * from daily bars, honest nulls when history insufficient.
 * Pure functions with fixture bars. No network.
 */
import { describe, it, expect } from "vitest";
import {
  computeTechnicals,
  classifyGap,
  type YahooDailyBar,
} from "../src/trading/technicals";

function bars(n: number, startClose = 100, drift = 0.5): YahooDailyBar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = startClose + i * drift;
    return {
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      open: close - 0.3,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1_000_000,
    };
  });
}

describe("classifyGap", () => {
  it("classifies gaps with ±1% thresholds", () => {
    expect(classifyGap(2.5)).toBe("up");
    expect(classifyGap(1)).toBe("up");
    expect(classifyGap(0.5)).toBe("flat");
    expect(classifyGap(-0.5)).toBe("flat");
    expect(classifyGap(-1)).toBe("down");
    expect(classifyGap(-3)).toBe("down");
    expect(classifyGap(null)).toBeNull();
  });
});

describe("computeTechnicals", () => {
  it("computes gap from the two most recent bars", () => {
    const b = bars(30);
    // Force a gap: last open well above previous close.
    b[29] = { ...b[29], open: b[28].close * 1.03 };
    const t = computeTechnicals("TEST", b);
    expect(t.gapPercent).toBeCloseTo(3, 1);
    expect(t.gapDirection).toBe("up");
    expect(t.source).toBe("Yahoo Finance");
  });

  it("computes real RSI(14) with 15+ bars", () => {
    const t = computeTechnicals("TEST", bars(30, 100, 0.8));
    expect(t.rsi14).not.toBeNull();
    expect(t.rsi14!).toBeGreaterThan(50); // steady uptrend
    expect(t.rsi14!).toBeLessThanOrEqual(100);
    expect(t.barsUsed).toBe(30);
  });

  it("computes MACD with 27+ bars", () => {
    const t = computeTechnicals("TEST", bars(40, 100, 0.5));
    expect(t.macdLine).not.toBeNull();
    expect(t.macdSignalLine).not.toBeNull();
    expect(t.macdHistogram).not.toBeNull();
    expect(t.macdSignal).toBeTruthy();
  });

  it("withholds RSI/MACD when history is too short, keeps gap", () => {
    const t = computeTechnicals("TEST", bars(10));
    expect(t.rsi14).toBeNull();
    expect(t.macdLine).toBeNull();
    // Gap only needs 2 bars.
    expect(t.gapPercent).not.toBeNull();
  });

  it("returns honest nulls for missing history", () => {
    const t = computeTechnicals("TEST", null);
    expect(t.rsi14).toBeNull();
    expect(t.gapPercent).toBeNull();
    expect(t.gapDirection).toBeNull();
    expect(t.barsUsed).toBe(0);
  });
});
