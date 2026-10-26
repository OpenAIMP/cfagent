import { describe, expect, it } from "vitest";
import { computeFractalPivots, computeFibonacciRetracements, type YahooDailyBar } from "../src/trading/technicals";
import { createTemplateStrategy, type TemplateSpec } from "../src/trading/options/strategies/template";
import type { ChainView, StrategyContext } from "../src/trading/options/strategies/types";
import type { ScreenedOptionContractItem } from "../src/types";

function bar(date: string, high: number, low: number, close = (high + low) / 2): YahooDailyBar {
  return { date, open: close, high, low, close, volume: 1000 };
}

// Series with a confirmed high pivot at index 5 (20 > 5 preceding
// highs 10..14 and 5 trailing highs 14..10) and a confirmed low pivot
// at index 5 (1 < 5 preceding lows 10..6 and 5 trailing lows 6..10).
const PIVOT_BARS: YahooDailyBar[] = [
  bar("2026-01-01", 10, 10), bar("2026-01-02", 11, 9), bar("2026-01-03", 12, 8),
  bar("2026-01-04", 13, 7), bar("2026-01-05", 14, 6), bar("2026-01-06", 20, 1),
  bar("2026-01-07", 14, 6), bar("2026-01-08", 13, 7), bar("2026-01-09", 12, 8),
  bar("2026-01-10", 11, 9), bar("2026-01-11", 10, 10), bar("2026-01-12", 9, 11),
  bar("2026-01-13", 8, 12),
];

describe("computeFractalPivots (issue #1654 slice 4)", () => {
  it("detects the confirmed high and low pivots at n=5", () => {
    const pivots = computeFractalPivots(PIVOT_BARS);
    expect(pivots).not.toBeNull();
    expect(pivots!.highs).toEqual([{ index: 5, date: "2026-01-06", price: 20 }]);
    expect(pivots!.lows).toEqual([{ index: 5, date: "2026-01-06", price: 1 }]);
  });

  it("requires strict extremity: a tied neighbor kills the pivot", () => {
    const tied = PIVOT_BARS.map((b, i) => (i === 6 ? { ...b, high: 20 } : b));
    const pivots = computeFractalPivots(tied);
    expect(pivots!.highs).toEqual([]);
  });

  it("does not confirm a pivot with fewer than n bars on either side", () => {
    // Global max at index 2 has only 2 preceding bars: unconfirmed.
    const edge = [
      bar("2026-01-01", 10, 10), bar("2026-01-02", 11, 9), bar("2026-01-03", 50, 1),
      bar("2026-01-04", 11, 9), bar("2026-01-05", 10, 10), bar("2026-01-06", 9, 11),
      bar("2026-01-07", 8, 12), bar("2026-01-08", 7, 13), bar("2026-01-09", 6, 14),
      bar("2026-01-10", 5, 15), bar("2026-01-11", 4, 16),
    ];
    expect(computeFractalPivots(edge)!.highs).toEqual([]);
  });

  it("honors a custom n", () => {
    const bars = [bar("d1", 10, 10), bar("d2", 12, 8), bar("d3", 20, 1), bar("d4", 12, 8), bar("d5", 10, 10)];
    expect(computeFractalPivots(bars, 2)!.highs).toEqual([{ index: 2, date: "d3", price: 20 }]);
    expect(computeFractalPivots(bars, 3)!.highs).toEqual([]);
  });

  it("returns empty lists on valid-but-short input, null on invalid input", () => {
    expect(computeFractalPivots(PIVOT_BARS.slice(0, 10))).toEqual({ highs: [], lows: [] });
    expect(computeFractalPivots([])).toBeNull();
    expect(computeFractalPivots([bar("d1", Number.NaN, 1)])).toBeNull();
    expect(computeFractalPivots(PIVOT_BARS, 0)).toBeNull();
    expect(computeFractalPivots(PIVOT_BARS, 2.5)).toBeNull();
  });
});

describe("computeFibonacciRetracements (issue #1654 slice 4)", () => {
  it("computes 38.2/50/61.8 levels on an up-move swing", () => {
    const bars = [
      bar("2026-01-01", 100, 100), bar("2026-01-02", 120, 110), bar("2026-01-03", 140, 120),
      bar("2026-01-04", 160, 130), bar("2026-01-05", 180, 140), bar("2026-01-06", 200, 150),
    ];
    const fib = computeFibonacciRetracements(bars);
    expect(fib).not.toBeNull();
    expect(fib!.high).toBe(200);
    expect(fib!.low).toBe(100);
    expect(fib!.range).toBe(100);
    expect(fib!.direction).toBe("up");
    expect(fib!.levels.map((l) => l.ratio)).toEqual([0.382, 0.5, 0.618]);
    expect(fib!.levels[0].price).toBeCloseTo(161.8, 9);
    expect(fib!.levels[1].price).toBeCloseTo(150, 9);
    expect(fib!.levels[2].price).toBeCloseTo(138.2, 9);
  });

  it("measures retracement upward from the low on a down-move swing", () => {
    const bars = [
      bar("2026-01-01", 200, 150), bar("2026-01-02", 180, 140), bar("2026-01-03", 160, 130),
      bar("2026-01-04", 140, 120), bar("2026-01-05", 120, 110), bar("2026-01-06", 100, 100),
    ];
    const fib = computeFibonacciRetracements(bars);
    expect(fib!.direction).toBe("down");
    expect(fib!.levels[0].price).toBeCloseTo(138.2, 9);
    expect(fib!.levels[1].price).toBeCloseTo(150, 9);
    expect(fib!.levels[2].price).toBeCloseTo(161.8, 9);
  });

  it("uses only the trailing lookbackBars window (6-month swing)", () => {
    const bars = [bar("2025-01-01", 1000, 999)];
    for (let i = 1; i < 130; i++) bars.push(bar(`2025-01-${String(i + 1).padStart(2, "0")}`, 200, 100));
    const fib = computeFibonacciRetracements(bars);
    expect(fib!.high).toBe(200);
    expect(fib!.barsUsed).toBe(125);
  });

  it("returns null on insufficient or invalid data", () => {
    expect(computeFibonacciRetracements([])).toBeNull();
    expect(computeFibonacciRetracements([bar("d1", 100, 100)])).toBeNull();
    expect(computeFibonacciRetracements([bar("d1", 100, 100), bar("d2", 100, 100)])).toBeNull();
    expect(computeFibonacciRetracements([bar("d1", 100, 90), bar("d2", Number.NaN, 80)])).toBeNull();
    expect(computeFibonacciRetracements(PIVOT_BARS, 0)).toBeNull();
  });
});

function fakeContract(strike: number, type: "CALL" | "PUT"): ScreenedOptionContractItem {
  return {
    symbol: `XYZ30${strike}${type[0]}`,
    optionType: type,
    strikePrice: strike,
    expirationDate: "2026-12-01",
    daysToExpiration: 30,
    bid: 1.0,
    ask: 1.2,
    spreadPct: 0,
    quoteTimestamp: "",
    quoteAgeSeconds: 0,
    quoteFreshness: "UNKNOWN",
  } as unknown as ScreenedOptionContractItem;
}

function fibCtx(fibLevels: number[] | undefined, prefer: boolean): StrategyContext {
  const strikes = [90, 95, 100, 105, 110];
  const calls = new Map(strikes.map((s) => [s, fakeContract(s, "CALL")] as const));
  const puts = new Map(strikes.map((s) => [s, fakeContract(s, "PUT")] as const));
  const chain: ChainView = { expiration: "2026-12-01", dte: 30, calls, puts };
  return {
    request: {},
    symbol: "XYZ",
    underlying: 100,
    chains: [chain],
    stockShares: 0,
    ...(fibLevels !== undefined ? { fibLevels } : {}),
  };
}

function verticalSpec(preferFibLevels: boolean): TemplateSpec {
  return {
    strikes: 2,
    legs: [
      { type: "CALL", side: "BUY", k: 0 },
      { type: "CALL", side: "SELL", k: 1 },
    ],
    ...(preferFibLevels ? { preferFibLevels: true } : {}),
  };
}

describe("Fib levels in template strike selection (issue #1654 slice 4)", () => {
  it("ranks the Fib-centered vertical first when levels are supplied and the spec opts in", () => {
    const def = createTemplateStrategy({
      id: "t", label: "T", category: "vertical", description: "t",
      theses: ["bullish"], specs: [verticalSpec(true)],
    });
    const result = def.generate(fibCtx([110], true), 10);
    const first = result.sets[0].map((leg) => leg.strike);
    expect(first).toEqual([105, 110]);
  });

  it("falls back to spot distance when no levels are supplied", () => {
    const def = createTemplateStrategy({
      id: "t", label: "T", category: "vertical", description: "t",
      theses: ["bullish"], specs: [verticalSpec(true)],
    });
    const result = def.generate(fibCtx(undefined, true), 10);
    const first = result.sets[0].map((leg) => leg.strike);
    expect(first).toEqual([100, 105]);
  });

  it("ignores levels for specs that do not opt in", () => {
    const def = createTemplateStrategy({
      id: "t", label: "T", category: "vertical", description: "t",
      theses: ["bullish"], specs: [verticalSpec(false)],
    });
    const result = def.generate(fibCtx([110], false), 10);
    const first = result.sets[0].map((leg) => leg.strike);
    expect(first).toEqual([100, 105]);
  });

  it("ignores non-finite levels and falls back to spot distance", () => {
    const def = createTemplateStrategy({
      id: "t", label: "T", category: "vertical", description: "t",
      theses: ["bullish"], specs: [verticalSpec(true)],
    });
    const result = def.generate(fibCtx([Number.NaN], true), 10);
    const first = result.sets[0].map((leg) => leg.strike);
    expect(first).toEqual([100, 105]);
  });
});
