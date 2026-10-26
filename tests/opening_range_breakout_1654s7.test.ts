/**
 * Issue #1654 slice 7/8 — 15-min Opening Range Breakout (ORB)
 * (docs/architecture/business/screener-rules.md §1.4; fit-gap Gap 6).
 *
 * TDD red→green: OR_H/OR_L computation, trigger threshold incl. the
 * ×1.001 factor, time-prorated RVOL ≥ 1.5×, VWAP-hold ≥ 70% rule,
 * session-boundary / ET-timezone cases, no-data fail-closed cases.
 *
 * All bar inputs here are TEST fixtures — clearly test-only data.
 * There is deliberately NO production wiring in this slice: the repo
 * has no minute-bar source (see the implementation's doc comment —
 * both historical-bar providers map timeframes to 1wk/1mo/1h/1d only
 * and truncate timestamps to date-only, so no 09:30–09:45 ET window
 * can be built from them). Slice 8 owns the upstream provider work;
 * until then these functions compute only on bars a caller supplies.
 */
import { describe, it, expect } from "vitest";
import {
  aggregateIntradayBarsTo15Min,
  computeOpeningRange,
  computeVwapHold,
  evaluateOrbTrigger,
  type IntradayBar,
} from "../src/trading/technicals";

/** EDT date: 09:30 ET = 13:30Z. EST date: 09:30 ET = 14:30Z. */
function bar(iso: string, open: number, high: number, low: number, close: number, volume: number): IntradayBar {
  return { timestamp: iso, open, high, low, close, volume };
}

describe("computeOpeningRange", () => {
  it("takes OR_H/OR_L from a single 09:30 15-min bar", () => {
    const r = computeOpeningRange(
      [bar("2026-10-26T13:30:00Z", 100, 102, 99, 101, 5000)],
      "2026-10-26"
    );
    expect(r).toEqual({ orHigh: 102, orLow: 99, barsUsed: 1 });
  });

  it("aggregates fifteen 1-min bars 09:30–09:44 ET into one range", () => {
    const bars: IntradayBar[] = [];
    for (let m = 0; m < 15; m++) {
      const mm = String(30 + m).padStart(2, "0");
      bars.push(bar(`2026-10-26T13:${mm}:00Z`, 100, 100 + m, 100 - m, 100, 100));
    }
    const r = computeOpeningRange(bars, "2026-10-26");
    expect(r).toEqual({ orHigh: 114, orLow: 86, barsUsed: 15 });
  });

  it("excludes the 09:45 bar, pre-market bars, and other-date bars", () => {
    const r = computeOpeningRange(
      [
        bar("2026-10-26T13:29:00Z", 1, 999, 1, 1, 1),
        bar("2026-10-26T13:30:00Z", 100, 102, 99, 101, 5000),
        bar("2026-10-26T13:45:00Z", 1, 888, 1, 1, 1),
        bar("2026-10-27T13:30:00Z", 1, 777, 1, 1, 1),
      ],
      "2026-10-26"
    );
    expect(r).toEqual({ orHigh: 102, orLow: 99, barsUsed: 1 });
  });

  it("resolves the ET window across DST: 13:30Z in EDT, 14:30Z in EST", () => {
    const edt = computeOpeningRange([bar("2026-10-26T13:30:00Z", 100, 102, 99, 101, 5000)], "2026-10-26");
    const est = computeOpeningRange([bar("2026-01-05T14:30:00Z", 100, 102, 99, 101, 5000)], "2026-01-05");
    expect(edt).toEqual({ orHigh: 102, orLow: 99, barsUsed: 1 });
    expect(est).toEqual({ orHigh: 102, orLow: 99, barsUsed: 1 });
    // Same clock time, wrong offset: 13:30Z on an EST date is 08:30 ET — outside.
    expect(computeOpeningRange([bar("2026-01-05T13:30:00Z", 100, 102, 99, 101, 5000)], "2026-01-05")).toBeNull();
  });

  it("fail-closes: empty input, no in-window bars, bad session date", () => {
    expect(computeOpeningRange([], "2026-10-26")).toBeNull();
    expect(computeOpeningRange([bar("2026-10-26T14:00:00Z", 100, 102, 99, 101, 5000)], "2026-10-26")).toBeNull();
    expect(computeOpeningRange([bar("2026-10-26T13:30:00Z", 100, 102, 99, 101, 5000)], "not-a-date")).toBeNull();
  });

  it("fail-closes on a corrupt in-window bar, ignores corrupt out-of-window bars", () => {
    expect(
      computeOpeningRange([bar("2026-10-26T13:30:00Z", 100, Number.NaN, 99, 101, 5000)], "2026-10-26")
    ).toBeNull();
    const r = computeOpeningRange(
      [
        bar("2026-10-26T13:30:00Z", 100, 102, 99, 101, 5000),
        bar("2026-10-26T14:00:00Z", 100, Number.NaN, 99, 101, 5000),
      ],
      "2026-10-26"
    );
    expect(r).toEqual({ orHigh: 102, orLow: 99, barsUsed: 1 });
  });
});

describe("evaluateOrbTrigger", () => {
  it("triggers above OR_H x 1.001 with time-prorated RVOL exactly 1.5x", () => {
    // avgDaily 3,900,000; elapsed 39 of 390 min -> expected 390,000; 585,000 / 390,000 = 1.5.
    const r = evaluateOrbTrigger({
      orHigh: 100,
      price: 100.11,
      sessionVolume: 585000,
      avgDailyVolume: 3900000,
      elapsedMinutes: 39,
    });
    expect(r).toEqual({ triggered: true, triggerPrice: 100.1, rvol: 1.5 });
  });

  it("does NOT trigger at exactly OR_H x 1.001 (must strictly clear)", () => {
    const r = evaluateOrbTrigger({
      orHigh: 100,
      price: 100.1,
      sessionVolume: 585000,
      avgDailyVolume: 3900000,
      elapsedMinutes: 39,
    });
    expect(r?.triggered).toBe(false);
  });

  it("does NOT trigger when RVOL is below 1.5x even with price above", () => {
    const r = evaluateOrbTrigger({
      orHigh: 100,
      price: 101,
      sessionVolume: 584999,
      avgDailyVolume: 3900000,
      elapsedMinutes: 39,
    });
    expect(r?.triggered).toBe(false);
    expect(r?.rvol).toBeCloseTo(1.499997, 5);
  });

  it("fail-closes: zero elapsed, zero avg daily volume, negative volume, bad OR", () => {
    const base = { orHigh: 100, price: 101, sessionVolume: 585000, avgDailyVolume: 3900000, elapsedMinutes: 39 };
    expect(evaluateOrbTrigger({ ...base, elapsedMinutes: 0 })).toBeNull();
    expect(evaluateOrbTrigger({ ...base, avgDailyVolume: 0 })).toBeNull();
    expect(evaluateOrbTrigger({ ...base, sessionVolume: -1 })).toBeNull();
    expect(evaluateOrbTrigger({ ...base, orHigh: 0 })).toBeNull();
    expect(evaluateOrbTrigger({ ...base, price: Number.NaN })).toBeNull();
  });
});

describe("computeVwapHold", () => {
  // Equal volumes -> session VWAP = mean of typical prices.
  // 7 bars typical 101 (H102/L100/C101), 3 bars typical 99 (H100/L98/C99):
  // VWAP = (7*101 + 3*99)/10 = 100.4; closes 101 above, 99 below -> 7/10 = 70%.
  function holdBars(upCount: number): IntradayBar[] {
    const bars: IntradayBar[] = [];
    for (let i = 0; i < 10; i++) {
      // ET start 09:30 + i*15 min; EDT (UTC-4) -> UTC = ET + 240 min.
      const utc = 570 + i * 15 + 240;
      const hh = String(Math.floor(utc / 60)).padStart(2, "0");
      const mm = String(utc % 60).padStart(2, "0");
      const up = i < upCount;
      bars.push(
        bar(`2026-10-26T${hh}:${mm}:00Z`, up ? 100 : 98, up ? 102 : 100, up ? 100 : 98, up ? 101 : 99, 1000)
      );
    }
    return bars;
  }

  it("confirms at exactly 70% of completed bars above session VWAP", () => {
    const r = computeVwapHold(holdBars(7), "2026-10-26", "2026-10-26T20:00:00Z");
    expect(r?.sessionVwap).toBeCloseTo(100.4, 10);
    expect(r).toMatchObject({ barsAbove: 7, barsTotal: 10, holdPct: 0.7, confirmed: true });
  });

  it("rejects at 60% of completed bars above session VWAP", () => {
    const r = computeVwapHold(holdBars(6), "2026-10-26", "2026-10-26T20:00:00Z");
    expect(r?.sessionVwap).toBeCloseTo(100.2, 10);
    expect(r).toMatchObject({ barsAbove: 6, barsTotal: 10, holdPct: 0.6, confirmed: false });
  });

  it("counts only completed bars: a bar starting at asOf is incomplete", () => {
    // 7 up + 3 down complete, plus an 11th down bar starting exactly at asOf.
    const bars = holdBars(7);
    bars.push(bar("2026-10-26T16:00:00Z", 98, 100, 98, 99, 1000));
    const r = computeVwapHold(bars, "2026-10-26", "2026-10-26T16:00:00Z");
    expect(r).toMatchObject({ barsTotal: 10, barsAbove: 7 });
  });

  it("fail-closes: empty input, zero total volume", () => {
    expect(computeVwapHold([], "2026-10-26", "2026-10-26T20:00:00Z")).toBeNull();
    const zero = holdBars(7).map((b) => ({ ...b, volume: 0 }));
    expect(computeVwapHold(zero, "2026-10-26", "2026-10-26T20:00:00Z")).toBeNull();
  });
});

describe("aggregateIntradayBarsTo15Min", () => {
  it("buckets fifteen 1-min bars into one 09:30 bucket with correct OHLCV", () => {
    const bars: IntradayBar[] = [];
    for (let m = 0; m < 15; m++) {
      bars.push(bar(`2026-10-26T13:${String(30 + m).padStart(2, "0")}:00Z`, 100 + m, 103, 97, 100 + m, 10));
    }
    bars.push(bar("2026-10-26T13:45:00Z", 200, 201, 199, 200, 5));
    const out = aggregateIntradayBarsTo15Min(bars, "2026-10-26");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ open: 100, high: 103, low: 97, close: 114, volume: 150 });
    expect(out[1]).toMatchObject({ open: 200, high: 201, low: 199, close: 200, volume: 5 });
    // Bucket timestamps resolve back to their ET bucket starts.
    expect(computeOpeningRange(out, "2026-10-26")).toEqual({ orHigh: 103, orLow: 97, barsUsed: 1 });
  });

  it("drops pre-market, post-close, and other-date bars; passes 15-min bars through", () => {
    const out = aggregateIntradayBarsTo15Min(
      [
        bar("2026-10-26T13:29:00Z", 1, 2, 1, 1, 1),
        bar("2026-10-26T13:30:00Z", 100, 102, 99, 101, 5000),
        bar("2026-10-26T20:00:00Z", 1, 2, 1, 1, 1),
        bar("2026-10-27T13:30:00Z", 1, 2, 1, 1, 1),
      ],
      "2026-10-26"
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 5000 });
  });
});
