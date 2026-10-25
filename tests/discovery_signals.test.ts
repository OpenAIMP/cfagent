import { afterEach, describe, expect, it } from "vitest";

import {
  getDiscoveryConfig,
  setRuntimeEtapiConfigOverrides,
  type EtapiDiscoveryConfig,
} from "../src/config/etapiConfig";
import type { YahooDailyBar } from "../src/trading/technicals";
import type { IvStats } from "../src/trading/options/ivHistoryStore";
import {
  characterizeName,
  detectSignals,
  prescreenOptionability,
  type ChainAggregates,
  type DiscoveryNameInputs,
  type DiscoverySignalType,
} from "../src/trading/options/discoverySignals";

/**
 * Issue #14 slice 1 — discovery characterization + signal catalog v1.
 *
 * Pure fixtures only: no fetch, no store. The signal rules are pinned
 * exactly (thresholds come from the discovery config section), IV
 * signals run in warming-up mode on the #15 stats shape, and every
 * signal carries a human-readable evidence line with the numbers that
 * decided it — the line later surfaces quote verbatim.
 */

const CFG: EtapiDiscoveryConfig = getDiscoveryConfig();

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

const ILLIQUID_CHAIN: ChainAggregates = {
  contractCount: 12,
  totalOpenInterest: 300,
  totalVolume: 20,
  medianSpreadPct: 22,
  atmIv: null,
};

function inputs(overrides: Partial<DiscoveryNameInputs>): DiscoveryNameInputs {
  return {
    symbol: "ACME",
    bars: barsFromCloses(linearCloses(100, 100, 60)),
    ivStats: null,
    chain: null,
    ...overrides,
  };
}

function signalMap(bars: YahooDailyBar[], ivStats: IvStats | null, chain: ChainAggregates | null) {
  const c = characterizeName(inputs({ bars, ivStats, chain }), CFG);
  const signals = detectSignals(c, CFG);
  return new Map(signals.map((s) => [s.type, s]));
}

afterEach(() => {
  setRuntimeEtapiConfigOverrides(null);
});

describe("discovery config section", () => {
  it("exposes the v1 thresholds with the settled defaults", () => {
    const cfg = getDiscoveryConfig();
    expect(cfg.ivExpensiveRank).toBe(80);
    expect(cfg.ivCheapRank).toBe(20);
    expect(cfg.trendFastWindow).toBe(20);
    expect(cfg.trendSlowWindow).toBe(50);
    expect(cfg.rangeWindowDays).toBe(20);
    expect(cfg.minContractsForOptionable).toBe(5);
  });

  it("honors runtime overrides through the standard merge", () => {
    setRuntimeEtapiConfigOverrides({ discovery: { ivExpensiveRank: 90 } as EtapiDiscoveryConfig });
    expect(getDiscoveryConfig().ivExpensiveRank).toBe(90);
    expect(getDiscoveryConfig().ivCheapRank).toBe(20);
  });
});

describe("characterizeName", () => {
  it("computes exact SMAs and fast-window return on a linear series", () => {
    const bars = barsFromCloses(linearCloses(100, 130, 61));
    const c = characterizeName(inputs({ bars }), CFG);
    expect(c.spot).toBe(130);
    expect(c.smaFast).toBeCloseTo(125.25, 6);
    expect(c.smaSlow).toBeCloseTo(117.75, 6);
    expect(c.returnFastPct).toBeCloseTo((130 / 120 - 1) * 100, 6);
  });

  it("computes range width and prior high/low excluding the last bar", () => {
    const closes = linearCloses(100, 100, 60);
    const bars = barsFromCloses(closes, (c) => ({ high: c + 2, low: c - 2 }));
    const c = characterizeName(inputs({ bars }), CFG);
    expect(c.rangeWidthPct).toBeCloseTo(((102 - 98) / 100) * 100, 6);
    expect(c.priorHigh).toBe(102);
    expect(c.priorLow).toBe(98);
    expect(c.distanceToPriorHighPct).toBeCloseTo(((102 - 100) / 102) * 100, 6);
  });

  it("carries IV rank/percentile/warming-up and chain liquidity through", () => {
    const c = characterizeName(
      inputs({
        ivStats: ivStatsFixture({ ivRank: 84, ivPercentile: 91, warmingUp: true, observations: 41 }),
        chain: LIQUID_CHAIN,
      }),
      CFG,
    );
    expect(c.ivRank).toBe(84);
    expect(c.ivPercentile).toBe(91);
    expect(c.ivWarmingUp).toBe(true);
    expect(c.ivObservations).toBe(41);
    expect(c.atmIv).toBe(0.42);
    expect(c.liquidity?.totalOpenInterest).toBe(52_000);
    expect(c.contractCount).toBe(240);
  });

  it("abstains cleanly on insufficient history — nulls, never zeros or throws", () => {
    const c = characterizeName(inputs({ bars: barsFromCloses([100, 101, 102]) }), CFG);
    expect(c.spot).toBe(102);
    expect(c.smaFast).toBeNull();
    expect(c.smaSlow).toBeNull();
    expect(c.returnFastPct).toBeNull();
    expect(c.ivRank).toBeNull();
    expect(c.liquidity).toBeNull();
  });

  it("handles an empty bar series without throwing", () => {
    const c = characterizeName(inputs({ bars: [] }), CFG);
    expect(c.spot).toBeNull();
    expect(c.smaFast).toBeNull();
  });
});

describe("IV signals (warming-up mode)", () => {
  it("IV_EXPENSIVE fires at rank >= 80 and the evidence carries the numbers", () => {
    const m = signalMap(barsFromCloses(linearCloses(100, 100, 60)), ivStatsFixture({ ivRank: 84 }), LIQUID_CHAIN);
    const s = m.get("IV_EXPENSIVE")!;
    expect(s.fired).toBe(true);
    expect(s.evidence).toContain("84");
    expect(m.get("IV_CHEAP")!.fired).toBe(false);
  });

  it("IV_CHEAP fires at rank <= 20", () => {
    const m = signalMap(barsFromCloses(linearCloses(100, 100, 60)), ivStatsFixture({ ivRank: 12 }), LIQUID_CHAIN);
    expect(m.get("IV_CHEAP")!.fired).toBe(true);
    expect(m.get("IV_EXPENSIVE")!.fired).toBe(false);
  });

  it("neither IV signal fires mid-range, without history, or with a null rank", () => {
    const bars = barsFromCloses(linearCloses(100, 100, 60));
    for (const stats of [ivStatsFixture({ ivRank: 50 }), ivStatsFixture({ ivRank: null }), null]) {
      const m = signalMap(bars, stats, LIQUID_CHAIN);
      expect(m.get("IV_EXPENSIVE")!.fired).toBe(false);
      expect(m.get("IV_CHEAP")!.fired).toBe(false);
    }
  });

  it("a warming-up series still fires, qualified in the evidence line", () => {
    const m = signalMap(
      barsFromCloses(linearCloses(100, 100, 60)),
      ivStatsFixture({ ivRank: 88, warmingUp: true, observations: 41 }),
      LIQUID_CHAIN,
    );
    const s = m.get("IV_EXPENSIVE")!;
    expect(s.fired).toBe(true);
    expect(s.evidence.toLowerCase()).toContain("warming up");
    expect(s.evidence).toContain("41");
  });
});

describe("trend and range signals", () => {
  it("TREND_UP fires on an aligned rising series; TREND_DOWN does not", () => {
    const m = signalMap(barsFromCloses(linearCloses(100, 130, 61)), null, LIQUID_CHAIN);
    expect(m.get("TREND_UP")!.fired).toBe(true);
    expect(m.get("TREND_DOWN")!.fired).toBe(false);
  });

  it("TREND_DOWN fires on an aligned falling series; TREND_UP does not", () => {
    const m = signalMap(barsFromCloses(linearCloses(130, 100, 61)), null, LIQUID_CHAIN);
    expect(m.get("TREND_DOWN")!.fired).toBe(true);
    expect(m.get("TREND_UP")!.fired).toBe(false);
  });

  it("RANGE_PINNED fires on a tight, driftless range and no trend fires", () => {
    const bars = barsFromCloses(linearCloses(100, 100, 60), (c) => ({ high: c + 2, low: c - 2 }));
    const m = signalMap(bars, null, LIQUID_CHAIN);
    expect(m.get("RANGE_PINNED")!.fired).toBe(true);
    expect(m.get("TREND_UP")!.fired).toBe(false);
    expect(m.get("TREND_DOWN")!.fired).toBe(false);
  });

  it("RANGE_PINNED does not fire when the range drifts beyond the drift cap", () => {
    // Tight band (+/-1) but closes drift 100 -> 103.5 across the last
    // 20 bars: width stays under the cap, drift (3.5%) exceeds it.
    const closes = [...linearCloses(100, 100, 40), ...linearCloses(100, 103.5, 20)];
    const bars = barsFromCloses(closes, (c) => ({ high: c + 1, low: c - 1 }));
    const c = characterizeName(inputs({ bars }), CFG);
    expect(c.rangeWidthPct!).toBeLessThanOrEqual(CFG.rangePinMaxWidthPct);
    const m = signalMap(bars, null, LIQUID_CHAIN);
    expect(m.get("RANGE_PINNED")!.fired).toBe(false);
  });

  it("RANGE_PINNED does not fire in a trend (range too wide)", () => {
    const m = signalMap(barsFromCloses(linearCloses(100, 130, 61)), null, LIQUID_CHAIN);
    expect(m.get("RANGE_PINNED")!.fired).toBe(false);
  });
});

describe("breakout watch", () => {
  it("fires when the close sits within proximity below the prior high", () => {
    // Prior bars' highs reach 110 (close + 5); last close 109 is 0.9%
    // below that high — inside the 1.5% proximity band.
    const closes = [...linearCloses(100, 105, 59), 109];
    const bars = barsFromCloses(closes, (c, i) => ({
      high: i === closes.length - 1 ? 109.4 : c + 5,
      low: c - 2,
    }));
    const c = characterizeName(inputs({ bars }), CFG);
    expect(c.priorHigh).toBe(110);
    const m = signalMap(bars, null, LIQUID_CHAIN);
    expect(m.get("BREAKOUT_WATCH")!.fired).toBe(true);
  });

  it("does not fire once the close is through the prior high", () => {
    const closes = [...linearCloses(100, 105, 59), 112];
    const bars = barsFromCloses(closes, (c, i) => ({
      high: i === closes.length - 1 ? 112.4 : c + 5,
      low: c - 2,
    }));
    const m = signalMap(bars, null, LIQUID_CHAIN);
    expect(m.get("BREAKOUT_WATCH")!.fired).toBe(false);
  });

  it("does not fire far below the high", () => {
    const closes = [...linearCloses(100, 105, 59), 100];
    const bars = barsFromCloses(closes, (c, i) => ({
      high: i === closes.length - 1 ? 100.4 : c + 5,
      low: c - 2,
    }));
    const m = signalMap(bars, null, LIQUID_CHAIN);
    expect(m.get("BREAKOUT_WATCH")!.fired).toBe(false);
  });
});

describe("liquidity gate and the full catalog", () => {
  it("LIQUIDITY_OK fires on a liquid chain and fails on an illiquid or absent one", () => {
    const bars = barsFromCloses(linearCloses(100, 100, 60));
    expect(signalMap(bars, null, LIQUID_CHAIN).get("LIQUIDITY_OK")!.fired).toBe(true);
    expect(signalMap(bars, null, ILLIQUID_CHAIN).get("LIQUIDITY_OK")!.fired).toBe(false);
    expect(signalMap(bars, null, null).get("LIQUIDITY_OK")!.fired).toBe(false);
  });

  it("detectSignals always returns the whole v1 catalog, each with evidence", () => {
    const c = characterizeName(inputs({ chain: LIQUID_CHAIN }), CFG);
    const signals = detectSignals(c, CFG);
    const types = signals.map((s) => s.type).sort();
    const expected: DiscoverySignalType[] = [
      "BREAKOUT_WATCH",
      "EVENT_NEAR",
      "FLOW_BEARISH",
      "FLOW_BULLISH",
      "IV_CHEAP",
      "IV_EXPENSIVE",
      "LIQUIDITY_OK",
      "MOVE_UNDERPRICED",
      "RANGE_PINNED",
      "TREND_DOWN",
      "TREND_UP",
    ];
    expect(types).toEqual(expected.sort());
    for (const s of signals) {
      expect(s.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("prescreenOptionability", () => {
  it("passes a name with a real chain", () => {
    const r = prescreenOptionability(inputs({ chain: LIQUID_CHAIN }), CFG);
    expect(r.optionable).toBe(true);
  });

  it("screens out a missing chain and a stub chain, with reasons", () => {
    const missing = prescreenOptionability(inputs({ chain: null }), CFG);
    expect(missing.optionable).toBe(false);
    expect(missing.reason).toContain("no chain");
    const stub = prescreenOptionability(
      inputs({ chain: { ...LIQUID_CHAIN, contractCount: 3 } }),
      CFG,
    );
    expect(stub.optionable).toBe(false);
    expect(stub.reason).toContain("3");
  });
});
