/**
 * Issue #261 — screening indicators: sentiment, range/value zones, scoring.
 * Pure functions on E*TRADE snapshot quotes. No network, no mocks.
 */
import { describe, it, expect } from "vitest";
import {
  computeScreeningIndicators,
  classifySentiment,
  classifyRangeZone,
  classifyValueZone,
} from "../src/trading/screeningIndicators";

const base = {
  lastPrice: 100,
  changePercent: 1.2,
  open: 99,
  high: 101,
  low: 98,
  week52High: 150,
  week52Low: 80,
  volume: 1_000_000,
};

describe("classifySentiment", () => {
  it("maps day change to the 5-level sentiment scale", () => {
    expect(classifySentiment(4)).toBe("very_bullish");
    expect(classifySentiment(1)).toBe("bullish");
    expect(classifySentiment(0.2)).toBe("neutral");
    expect(classifySentiment(-1)).toBe("bearish");
    expect(classifySentiment(-5)).toBe("very_bearish");
  });
});

describe("classifyRangeZone", () => {
  it("flags 52-week extremes as overbought/oversold", () => {
    expect(classifyRangeZone(0.95)).toBe("overbought");
    expect(classifyRangeZone(0.05)).toBe("oversold");
    expect(classifyRangeZone(0.5)).toBe("neutral");
    expect(classifyRangeZone(null)).toBe("neutral");
  });
});

describe("classifyValueZone", () => {
  it("uses P/E when available", () => {
    expect(classifyValueZone(10, 0.5)).toBe("undervalued");
    expect(classifyValueZone(40, 0.5)).toBe("overvalued");
    expect(classifyValueZone(20, 0.5)).toBe("fair");
  });
  it("falls back to 52-week position without P/E", () => {
    expect(classifyValueZone(undefined, 0.1)).toBe("undervalued");
    expect(classifyValueZone(undefined, 0.9)).toBe("overvalued");
    expect(classifyValueZone(undefined, 0.5)).toBe("fair");
  });
});

describe("computeScreeningIndicators", () => {
  it("computes a full indicator set from a snapshot", () => {
    const ind = computeScreeningIndicators(base);
    expect(ind.sentiment).toBe("bullish");
    expect(ind.directional).toBe(false);
    expect(ind.intradayPosition).toBeCloseTo(0.67, 1);
    expect(ind.rangePosition).toBeCloseTo(0.29, 1);
    expect(ind.rangeZone).toBe("neutral");
    expect(ind.screenScore).toBeGreaterThanOrEqual(0);
    expect(ind.screenScore).toBeLessThanOrEqual(100);
    expect(ind.summary).toContain("bullish");
  });

  it("flags strong directional moves", () => {
    const ind = computeScreeningIndicators({ ...base, changePercent: 4.5 });
    expect(ind.sentiment).toBe("very_bullish");
    expect(ind.directional).toBe(true);
  });

  it("flags oversold range zone near 52-week low", () => {
    const ind = computeScreeningIndicators({
      ...base,
      lastPrice: 82,
      changePercent: -2.5,
    });
    expect(ind.rangeZone).toBe("oversold");
    expect(ind.valueZone).toBe("undervalued");
    expect(ind.sentiment).toBe("bearish");
  });

  it("handles degenerate ranges without crashing", () => {
    const ind = computeScreeningIndicators({
      ...base,
      high: 100,
      low: 100,
      week52High: 100,
      week52Low: 100,
    });
    expect(ind.intradayPosition).toBeNull();
    expect(ind.rangePosition).toBeNull();
    expect(ind.rangeZone).toBe("neutral");
  });
});
