/**
 * Issue #1654 slice 6 — 6-Vote Composite Bias.
 * Pure vote counting + bar-derived computation + evaluateUniverse gate.
 * No network, no mocks. Bar series below are synthetic test fixtures
 * (monotonic rises/falls), never production data.
 */
import { describe, it, expect } from "vitest";
import {
  compute6VoteCompositeBias,
  compute6VoteCompositeBiasFromBars,
  type CompositeBiasInputs,
} from "../src/trading/screeningIndicators";
import { classifyPriceRegime } from "../src/trading/technicals";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { ScreenedStockItem, YahooDailyBar } from "../src/types";

function bar(close: number, volume = 1000): YahooDailyBar {
  return {
    date: "2026-10-26",
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  };
}

function risingBars(n: number): YahooDailyBar[] {
  const bars: YahooDailyBar[] = [];
  for (let i = 0; i < n; i++) bars.push(bar(100 + i));
  return bars;
}

function fallingBars(n: number): YahooDailyBar[] {
  const bars: YahooDailyBar[] = [];
  for (let i = 0; i < n; i++) bars.push(bar(350 - i));
  return bars;
}

const allBullish: CompositeBiasInputs = {
  price: 110,
  sma50: 100,
  sma200: 90,
  macdLine: 0.5,
  rsi14: 60,
  regime: "UP",
};

function makeItem(overrides: Partial<ScreenedStockItem> = {}): ScreenedStockItem {
  return {
    symbol: "TEST",
    companyName: "Test Co",
    lastPrice: 100,
    change: 0,
    changePercent: 0,
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

describe("compute6VoteCompositeBias vote counting (#1654 slice 6)", () => {
  it("scores 6/6 Bullish when every vote is bullish", () => {
    const r = compute6VoteCompositeBias(allBullish);
    expect(r.score).toBe(6);
    expect(r.bearish).toBe(0);
    expect(r.abstentions).toBe(0);
    expect(r.bias).toBe("Bullish");
  });

  it("scores exactly 4 bullish as Bullish (doc ≥4 threshold)", () => {
    const r = compute6VoteCompositeBias({
      ...allBullish,
      rsi14: 40,
      regime: "RNG",
    });
    expect(r.score).toBe(4);
    expect(r.bearish).toBe(2);
    expect(r.bias).toBe("Bullish");
  });

  it("scores 3/3 as Neutral (doc 3 threshold)", () => {
    const r = compute6VoteCompositeBias({
      ...allBullish,
      macdLine: -0.5,
      rsi14: 40,
      regime: "DN",
    });
    expect(r.score).toBe(3);
    expect(r.bearish).toBe(3);
    expect(r.bias).toBe("Neutral");
  });

  it("scores 2 bullish as Bearish when all six vote (doc ≤2 threshold)", () => {
    const r = compute6VoteCompositeBias({
      price: 80,
      sma50: 90,
      sma200: 100,
      macdLine: 0.5,
      rsi14: 60,
      regime: "DN",
    });
    expect(r.score).toBe(2);
    expect(r.bearish).toBe(4);
    expect(r.bias).toBe("Bearish");
  });

  it("scores 0/6 Bearish when every vote is bearish", () => {
    const r = compute6VoteCompositeBias({
      price: 80,
      sma50: 100,
      sma200: 110,
      macdLine: -0.5,
      rsi14: 40,
      regime: "DN",
    });
    expect(r.score).toBe(0);
    expect(r.bearish).toBe(6);
    expect(r.bias).toBe("Bearish");
  });

  it("treats equality as bearish on all four numeric votes (strict >)", () => {
    const r = compute6VoteCompositeBias({
      price: 100,
      sma50: 100,
      sma200: 100,
      macdLine: 0,
      rsi14: 50,
      regime: "UP",
    });
    expect(r.votes.priceVsSma50).toBe("bearish");
    expect(r.votes.priceVsSma200).toBe("bearish");
    expect(r.votes.smaCross).toBe("bearish");
    expect(r.votes.macd).toBe("bearish");
    expect(r.votes.rsi).toBe("bearish");
    expect(r.score).toBe(1);
    expect(r.bias).toBe("Bearish");
  });

  it("treats DN and RNG regimes as bearish (only UP earns the point)", () => {
    expect(
      compute6VoteCompositeBias({ ...allBullish, regime: "DN" }).votes.regime
    ).toBe("bearish");
    expect(
      compute6VoteCompositeBias({ ...allBullish, regime: "RNG" }).votes.regime
    ).toBe("bearish");
  });

  it("abstains on each null input individually", () => {
    const r = compute6VoteCompositeBias({ ...allBullish, sma200: null });
    expect(r.votes.smaCross).toBe("abstain");
    expect(r.votes.priceVsSma200).toBe("abstain");
    expect(r.score).toBe(4);
    expect(r.abstentions).toBe(2);
    expect(r.bias).toBe("Bullish");
  });

  it("abstains on a null regime (never invents structure)", () => {
    const r = compute6VoteCompositeBias({ ...allBullish, regime: null });
    expect(r.votes.regime).toBe("abstain");
    expect(r.score).toBe(5);
    expect(r.abstentions).toBe(1);
    expect(r.bias).toBe("Bullish");
  });

  it("abstains on non-finite inputs (NaN / Infinity never vote)", () => {
    const r = compute6VoteCompositeBias({
      ...allBullish,
      rsi14: Number.NaN,
      macdLine: Number.POSITIVE_INFINITY,
    });
    expect(r.votes.rsi).toBe("abstain");
    expect(r.votes.macd).toBe("abstain");
    expect(r.score).toBe(4);
    expect(r.abstentions).toBe(2);
  });

  it("fail-closes on abstentions: 3 bullish + 3 abstain is Neutral, not Bullish", () => {
    const r = compute6VoteCompositeBias({
      price: 110,
      sma50: 100,
      sma200: 90,
      macdLine: null,
      rsi14: null,
      regime: null,
    });
    expect(r.score).toBe(3);
    expect(r.abstentions).toBe(3);
    expect(r.bias).toBe("Neutral");
  });

  it("fail-closes on abstentions: 2 bullish + 4 abstain is Neutral, NOT Bearish", () => {
    const r = compute6VoteCompositeBias({
      price: 110,
      sma50: 100,
      sma200: null,
      macdLine: null,
      rsi14: 60,
      regime: null,
    });
    expect(r.score).toBe(2);
    expect(r.bearish).toBe(0);
    expect(r.abstentions).toBe(4);
    expect(r.bias).toBe("Neutral");
  });
});

describe("compute6VoteCompositeBiasFromBars (#1654 slice 6)", () => {
  it("scores a 250-bar rising series 6/6 Bullish from real bar math", () => {
    const bars = risingBars(250);
    expect(classifyPriceRegime(bars)).toBe("UP");
    const r = compute6VoteCompositeBiasFromBars(bars);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(6);
    expect(r!.abstentions).toBe(0);
    expect(r!.bias).toBe("Bullish");
  });

  it("scores a 250-bar falling series 0/6 Bearish from real bar math", () => {
    const bars = fallingBars(250);
    expect(classifyPriceRegime(bars)).toBe("DN");
    const r = compute6VoteCompositeBiasFromBars(bars);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.bearish).toBe(6);
    expect(r!.bias).toBe("Bearish");
  });

  it("abstains on all six votes with only 10 bars (never estimates)", () => {
    const r = compute6VoteCompositeBiasFromBars(risingBars(10));
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.abstentions).toBe(6);
    expect(r!.bias).toBe("Neutral");
  });

  it("casts only RSI/MACD/regime with 30 bars (SMA votes abstain)", () => {
    const r = compute6VoteCompositeBiasFromBars(risingBars(30));
    expect(r).not.toBeNull();
    expect(r!.score).toBe(3);
    expect(r!.abstentions).toBe(3);
    expect(r!.votes.priceVsSma50).toBe("abstain");
    expect(r!.votes.priceVsSma200).toBe("abstain");
    expect(r!.votes.smaCross).toBe("abstain");
    expect(r!.bias).toBe("Neutral");
  });

  it("returns null on empty bars", () => {
    expect(compute6VoteCompositeBiasFromBars([])).toBeNull();
  });

  it("returns null when the last close is non-finite (no price, no votes)", () => {
    const bars = risingBars(250);
    bars[bars.length - 1] = { ...bars[bars.length - 1], close: Number.NaN };
    expect(compute6VoteCompositeBiasFromBars(bars)).toBeNull();
  });

  it("abstains NaN-poisoned votes on a mid-series NaN close but keeps finite votes", () => {
    const bars = risingBars(250);
    bars[100] = { ...bars[100], close: Number.NaN };
    const r = compute6VoteCompositeBiasFromBars(bars);
    expect(r).not.toBeNull();
    // SMA₅₀ window (last 50 closes) is NaN-free and votes bullish;
    // SMA₂₀₀ window (last 200) contains the NaN, so both SMA₂₀₀
    // votes abstain; Wilder RSI/MACD smoothing propagates the NaN
    // and abstains; regime uses finite highs/lows and votes bullish.
    expect(r!.votes.priceVsSma50).toBe("bullish");
    expect(r!.votes.priceVsSma200).toBe("abstain");
    expect(r!.votes.smaCross).toBe("abstain");
    expect(r!.votes.rsi).toBe("abstain");
    expect(r!.votes.macd).toBe("abstain");
    expect(r!.votes.regime).toBe("bullish");
    expect(r!.score).toBe(2);
    expect(r!.abstentions).toBe(4);
    expect(r!.bias).toBe("Neutral");
  });
});

describe("evaluateUniverse composite-bias gate (#1654 slice 6)", () => {
  it("rejects a candidate below minCompositeBiasScore", () => {
    const result = screen(
      [makeItem({ compositeBiasScore: 2, compositeBias: "Bearish" })],
      { minCompositeBiasScore: 4 }
    );
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/below minimum/);
  });

  it("passes a candidate at exactly minCompositeBiasScore", () => {
    const result = screen(
      [makeItem({ compositeBiasScore: 4, compositeBias: "Bullish" })],
      { minCompositeBiasScore: 4 }
    );
    expect(result.stocks).toHaveLength(1);
  });

  it("fail-closes when the gate is requested but no bias data is attached", () => {
    const result = screen([makeItem()], { minCompositeBiasScore: 4 });
    expect(result.stocks).toHaveLength(0);
    expect(result.ledger.rejections[0].reason).toMatch(/unavailable/);
  });

  it("does not reject when the gate is unset", () => {
    expect(screen([makeItem()], {}).stocks).toHaveLength(1);
  });
});
