import { describe, expect, it } from "vitest";

import { getDiscoveryConfig, getOpportunityScannerConfig } from "../src/config/etapiConfig";
import type { YahooDailyBar } from "../src/trading/technicals";
import type { IvStats } from "../src/trading/options/ivHistoryStore";
import {
  characterizeName,
  detectSignals,
  type ChainAggregates,
  type DiscoverySignal,
  type DiscoverySignalType,
} from "../src/trading/options/discoverySignals";
import { inferThesis } from "../src/trading/options/discoveryInference";

/**
 * Issue #14 slice 2 — deterministic thesis inference (spec §7).
 *
 * Golden fixtures: every rule in the table has a fires case, and the
 * abstain/conflict paths are pinned too. Most fixtures run the real
 * slice-1 characterization + detection over synthetic bars so the
 * golden path is the production path; conflict cases that slice 1's
 * own rules cannot produce together are built as literal signal sets.
 * The table must never default to bullish: direction comes only from
 * fired directional evidence.
 */

const CFG = getDiscoveryConfig();
const MULTIPLES = getOpportunityScannerConfig().targetEmMultiples;

function barsFromCloses(
  closes: number[],
  shape: (close: number, i: number) => { high: number; low: number } = (c) => ({
    high: c * 1.005,
    low: c * 0.995,
  }),
): YahooDailyBar[] {
  return closes.map((close, i) => {
    const { high, low } = shape(close, i);
    return {
      date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`,
      open: close,
      high,
      low,
      close,
      volume: 1_000_000,
    };
  });
}

function linearCloses(start: number, end: number, n: number): number[] {
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

function ivStatsFixture(overrides: Partial<IvStats>): IvStats {
  return {
    observations: 132,
    coveragePct: 52,
    warmingUp: false,
    latest: null,
    ivRank: null,
    ivPercentile: null,
    ...overrides,
  };
}

const LIQUID_CHAIN: ChainAggregates = {
  contractCount: 240,
  totalOpenInterest: 52_000,
  totalVolume: 8_400,
  medianSpreadPct: 3.2,
  atmIv: 0.42,
};

function inferFromMarket(
  bars: YahooDailyBar[],
  ivStats: IvStats | null,
  chain: ChainAggregates | null = LIQUID_CHAIN,
) {
  const c = characterizeName({ symbol: "ACME", bars, ivStats, chain }, CFG);
  return inferThesis(c, detectSignals(c, CFG), CFG, MULTIPLES);
}

function literalSignals(fired: DiscoverySignalType[]): DiscoverySignal[] {
  const all: DiscoverySignalType[] = [
    "IV_EXPENSIVE",
    "IV_CHEAP",
    "TREND_UP",
    "TREND_DOWN",
    "RANGE_PINNED",
    "BREAKOUT_WATCH",
    "LIQUIDITY_OK",
  ];
  return all.map((type) => ({ type, fired: fired.includes(type), evidence: `fixture ${type}` }));
}

function inferFromSignals(fired: DiscoverySignalType[]) {
  const c = characterizeName(
    { symbol: "ACME", bars: barsFromCloses(linearCloses(100, 100, 60)), ivStats: null, chain: LIQUID_CHAIN },
    CFG,
  );
  return inferThesis(c, literalSignals(fired), CFG, MULTIPLES);
}

describe("inference config", () => {
  it("carries a DTE window per thesis", () => {
    expect(CFG.dteWindows.bullish).toEqual({ minDte: 21, maxDte: 60 });
    expect(CFG.dteWindows.bearish).toEqual({ minDte: 21, maxDte: 60 });
    expect(CFG.dteWindows.range_bound).toEqual({ minDte: 30, maxDte: 60 });
    expect(CFG.dteWindows.large_move).toEqual({ minDte: 14, maxDte: 45 });
  });
});

describe("range rules", () => {
  it("RANGE_PINNED alone -> range_bound, neutral IV, medium confidence", () => {
    const bars = barsFromCloses(linearCloses(100, 100, 60), (c) => ({ high: c + 2, low: c - 2 }));
    const r = inferFromMarket(bars, null);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.thesis).toBe("range_bound");
    expect(r.ruleId).toBe("range-pinned");
    expect(r.targetEmMultiple).toBe(0);
    expect(r.expectedIvDirection).toBe("unchanged");
    expect(r.confidence).toBe("MEDIUM");
    expect(r.dteWindow).toEqual({ minDte: 30, maxDte: 60 });
    expect(r.firedSignals).toContain("RANGE_PINNED");
  });

  it("RANGE_PINNED + IV_EXPENSIVE -> range_bound with falling IV, high confidence", () => {
    const bars = barsFromCloses(linearCloses(100, 100, 60), (c) => ({ high: c + 2, low: c - 2 }));
    const r = inferFromMarket(bars, ivStatsFixture({ ivRank: 86 }));
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.ruleId).toBe("range-pinned-rich-iv");
    expect(r.thesis).toBe("range_bound");
    expect(r.expectedIvDirection).toBe("fall");
    expect(r.confidence).toBe("HIGH");
  });

  it("RANGE_PINNED + TREND_UP is a conflict -> ABSTAIN naming both", () => {
    const r = inferFromSignals(["RANGE_PINNED", "TREND_UP", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(false);
    if (r.inferred) return;
    expect(r.reason).toContain("RANGE_PINNED");
    expect(r.reason).toContain("TREND_UP");
  });

  it("RANGE_PINNED + TREND_DOWN is a conflict -> ABSTAIN", () => {
    const r = inferFromSignals(["RANGE_PINNED", "TREND_DOWN", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(false);
  });
});

describe("trend rules", () => {
  it("TREND_UP -> bullish at the configured EM multiple", () => {
    // Final bar closes 130 after a 132 high-water mark: the trend is
    // intact but the close sits ~2% below the prior high, outside the
    // breakout-watch band — a plain trend (a name pressing its highs
    // would co-fire BREAKOUT_WATCH and land on trend-up-breakout).
    const closes = [...linearCloses(100, 132, 60), 130];
    const r = inferFromMarket(barsFromCloses(closes), null);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.thesis).toBe("bullish");
    expect(r.ruleId).toBe("trend-up");
    expect(r.targetEmMultiple).toBe(MULTIPLES.bullish);
    expect(r.confidence).toBe("MEDIUM");
    expect(r.dteWindow).toEqual({ minDte: 21, maxDte: 60 });
  });

  it("TREND_UP + BREAKOUT_WATCH -> bullish, high confidence", () => {
    const r = inferFromSignals(["TREND_UP", "BREAKOUT_WATCH", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.ruleId).toBe("trend-up-breakout");
    expect(r.confidence).toBe("HIGH");
  });

  it("TREND_DOWN -> bearish at the configured (negative) EM multiple", () => {
    const r = inferFromMarket(barsFromCloses(linearCloses(130, 100, 61)), null);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.thesis).toBe("bearish");
    expect(r.ruleId).toBe("trend-down");
    expect(r.targetEmMultiple).toBe(MULTIPLES.bearish);
    expect(r.targetEmMultiple).toBeLessThan(0);
  });

  it("TREND_UP + TREND_DOWN together -> ABSTAIN (impossible direction)", () => {
    const r = inferFromSignals(["TREND_UP", "TREND_DOWN", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(false);
  });
});

describe("breakout and large-move rules", () => {
  it("BREAKOUT_WATCH + IV_CHEAP -> large_move with rising IV", () => {
    const r = inferFromSignals(["BREAKOUT_WATCH", "IV_CHEAP", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.thesis).toBe("large_move");
    expect(r.ruleId).toBe("coiled-breakout-cheap-iv");
    expect(r.targetEmMultiple).toBe(MULTIPLES.large_move);
    expect(r.expectedIvDirection).toBe("rise");
    expect(r.dteWindow).toEqual({ minDte: 14, maxDte: 45 });
  });

  it("BREAKOUT_WATCH alone -> bullish at low confidence (a watch is weak evidence)", () => {
    // Pinned as a literal signal set: on real bars an approach to the
    // highs usually co-fires TREND_UP (see trend-up-breakout) — the
    // watch-only rule is exercised here in isolation.
    const r = inferFromSignals(["BREAKOUT_WATCH", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.thesis).toBe("bullish");
    expect(r.ruleId).toBe("breakout-watch");
    expect(r.confidence).toBe("LOW");
  });
});

describe("abstentions and the liquidity gate", () => {
  it("IV_EXPENSIVE alone -> ABSTAIN with the IV signal as near-miss", () => {
    // Sawtooth 97<->103: too wide to pin (7%), no SMA alignment, last
    // close at the pattern low (far from the high) — price action
    // forms no view, so rich IV alone must abstain.
    const closes = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 103 : 97));
    const r = inferFromMarket(barsFromCloses(closes), ivStatsFixture({ ivRank: 90 }));
    expect(r.inferred).toBe(false);
    if (r.inferred) return;
    expect(r.nearMissSignals).toContain("IV_EXPENSIVE");
  });

  it("IV_CHEAP alone -> ABSTAIN with the IV signal as near-miss", () => {
    const r = inferFromSignals(["IV_CHEAP", "LIQUIDITY_OK"]);
    expect(r.inferred).toBe(false);
    if (r.inferred) return;
    expect(r.nearMissSignals).toEqual(["IV_CHEAP"]);
  });

  it("no fired signals -> ABSTAIN with empty near-misses", () => {
    const r = inferFromSignals(["LIQUIDITY_OK"]);
    expect(r.inferred).toBe(false);
    if (r.inferred) return;
    expect(r.nearMissSignals).toEqual([]);
    expect(r.reason.toLowerCase()).toContain("no setup");
  });

  it("even a clean TREND_UP abstains when the liquidity gate fails", () => {
    const r = inferFromSignals(["TREND_UP"]);
    expect(r.inferred).toBe(false);
    if (r.inferred) return;
    expect(r.reason.toLowerCase()).toContain("liquidity");
  });

  it("EM multiples come from the caller's config, never literals", () => {
    const c = characterizeName(
      { symbol: "ACME", bars: barsFromCloses(linearCloses(100, 130, 61)), ivStats: null, chain: LIQUID_CHAIN },
      CFG,
    );
    const custom = { bullish: 0.9, bearish: -0.9, large_move: 1.5, range_bound: 0 };
    const r = inferThesis(c, detectSignals(c, CFG), CFG, custom);
    expect(r.inferred).toBe(true);
    if (!r.inferred) return;
    expect(r.targetEmMultiple).toBe(0.9);
  });
});
