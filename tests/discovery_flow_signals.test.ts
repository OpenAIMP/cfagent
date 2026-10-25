import { describe, expect, it } from "vitest";

import { getDiscoveryConfig } from "../src/config/etapiConfig";
import type { YahooDailyBar } from "../src/trading/yahooHistory";
import {
  characterizeName,
  detectSignals,
  flowAggregatesFromItems,
  type ChainAggregates,
  type DiscoveryNameInputs,
  type FlowItemLike,
} from "../src/trading/options/discoverySignals";
import { inferThesis } from "../src/trading/options/discoveryInference";

/**
 * Issue #18 slice 2 — FLOW_BULLISH / FLOW_BEARISH.
 *
 * THE GUARDRAIL (acceptance): flowService merges live flow with
 * seed rows to complete leaderboards; a discovery signal must only
 * ever read chain-derived records. The aggregator filters on
 * provenance BEFORE anything sums, and these fixtures prove that
 * seeded rows — however large — cannot fire a signal or move an
 * inference.
 */

const CFG = getDiscoveryConfig();
const MULTIPLES = { bullish: 0.6, bearish: -0.6, range_bound: 0.15, large_move: 1 } as const;

function barsFromCloses(closes: number[]): YahooDailyBar[] {
  return closes.map((close, i) => ({
    date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`,
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1_000_000,
  }));
}

function linearCloses(start: number, end: number, n: number): number[] {
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => start + step * i);
}

/** Steady uptrend with a soft final close (the #14 trend fixture). */
const UP_BARS = barsFromCloses([...linearCloses(100, 132, 60), 130]);
const DOWN_BARS = barsFromCloses([...linearCloses(132, 100, 60), 102]);

const LIQUID_CHAIN: ChainAggregates = {
  contractCount: 12,
  totalOpenInterest: 52_000,
  totalVolume: 8_400,
  medianSpreadPct: 4,
  atmIv: 0.3,
};

const derived = (sentiment: FlowItemLike["sentiment"], premium: number): FlowItemLike => ({
  provenance: "chain-derived",
  sentiment,
  premium,
});
const seeded = (sentiment: FlowItemLike["sentiment"], premium: number): FlowItemLike => ({
  provenance: "static",
  sentiment,
  premium,
});
const generated = (sentiment: FlowItemLike["sentiment"], premium: number): FlowItemLike => ({
  provenance: "generated",
  sentiment,
  premium,
});

const BULLISH_DERIVED: FlowItemLike[] = [
  derived("bullish", 100_000),
  derived("bullish", 120_000),
  derived("bullish", 80_000),
  derived("bearish", 50_000),
];
const BEARISH_DERIVED: FlowItemLike[] = [
  derived("bearish", 100_000),
  derived("bearish", 120_000),
  derived("bearish", 80_000),
  derived("bullish", 40_000),
];
/** A deluge of seeded bullish flow — must count for nothing. */
const SEED_DELUGE: FlowItemLike[] = [
  ...Array.from({ length: 10 }, () => seeded("bullish", 1_000_000)),
  ...Array.from({ length: 5 }, () => generated("bullish", 1_000_000)),
];

function run(bars: YahooDailyBar[], items: FlowItemLike[] | null) {
  const inputs: DiscoveryNameInputs = {
    symbol: "ACME",
    bars,
    ivStats: null,
    chain: LIQUID_CHAIN,
    flow: items === null ? null : flowAggregatesFromItems(items),
  };
  const c = characterizeName(inputs, CFG);
  const signals = detectSignals(c, CFG);
  return { c, signals, inference: inferThesis(c, signals, CFG, MULTIPLES) };
}

const sig = (signals: ReturnType<typeof detectSignals>, t: string) => signals.find((s) => s.type === t)!;

describe("config", () => {
  it("pins the flow calibration defaults", () => {
    expect(CFG.flowDominanceShare).toBe(0.65);
    expect(CFG.flowMinRecords).toBe(3);
  });
});

describe("flowAggregatesFromItems — the provenance filter", () => {
  it("sums only chain-derived premium and reports what it excluded", () => {
    const agg = flowAggregatesFromItems([...BULLISH_DERIVED, ...SEED_DELUGE]);
    expect(agg.bullishPremium).toBe(300_000);
    expect(agg.bearishPremium).toBe(50_000);
    expect(agg.derivedCount).toBe(4);
    expect(agg.excludedCount).toBe(15);
  });
});

describe("the guardrail: seeded flow can never fire a signal", () => {
  it("a deluge of seeded bullish rows fires neither FLOW signal", () => {
    const { signals } = run(UP_BARS, SEED_DELUGE);
    expect(sig(signals, "FLOW_BULLISH").fired).toBe(false);
    expect(sig(signals, "FLOW_BEARISH").fired).toBe(false);
    expect(sig(signals, "FLOW_BULLISH").evidence).toContain("excluded");
  });

  it("seeded rows do not move an inference either", () => {
    const plain = run(UP_BARS, null);
    const deluged = run(UP_BARS, SEED_DELUGE);
    expect(deluged.inference).toEqual(plain.inference);
  });

  it("derived bearish flow fires FLOW_BEARISH even under a seeded bullish deluge", () => {
    const { signals } = run(UP_BARS, [...BEARISH_DERIVED, ...SEED_DELUGE]);
    expect(sig(signals, "FLOW_BEARISH").fired).toBe(true);
    expect(sig(signals, "FLOW_BULLISH").fired).toBe(false);
  });
});

describe("FLOW signal firing rules", () => {
  it("FLOW_BULLISH fires on dominant derived bullish premium", () => {
    const { signals } = run(UP_BARS, BULLISH_DERIVED);
    const s = sig(signals, "FLOW_BULLISH");
    expect(s.fired).toBe(true);
    expect(s.evidence).toContain("chain-derived");
  });

  it("needs the minimum record count, however one-sided", () => {
    const { signals } = run(UP_BARS, [derived("bullish", 500_000), derived("bullish", 500_000)]);
    expect(sig(signals, "FLOW_BULLISH").fired).toBe(false);
  });

  it("balanced derived flow fires neither side", () => {
    const items = [
      derived("bullish", 100_000),
      derived("bullish", 100_000),
      derived("bearish", 100_000),
      derived("bearish", 100_000),
    ];
    const { signals } = run(UP_BARS, items);
    expect(sig(signals, "FLOW_BULLISH").fired).toBe(false);
    expect(sig(signals, "FLOW_BEARISH").fired).toBe(false);
  });

  it("no flow input at all — both signals abstain with the reason", () => {
    const { signals } = run(UP_BARS, null);
    expect(sig(signals, "FLOW_BULLISH").fired).toBe(false);
    expect(sig(signals, "FLOW_BULLISH").evidence).toContain("no flow data");
  });
});

describe("inference confidence modifier (flow confirms or opposes, never creates)", () => {
  it("aligned flow steps a trend inference up", () => {
    const { inference } = run(UP_BARS, BULLISH_DERIVED);
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("trend-up");
      expect(inference.confidence).toBe("HIGH");
    }
  });

  it("opposing flow steps a trend inference down", () => {
    const { inference } = run(UP_BARS, BEARISH_DERIVED);
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("trend-up");
      expect(inference.confidence).toBe("LOW");
    }
  });

  it("aligned flow confirms a bearish trend too", () => {
    const { inference } = run(DOWN_BARS, BEARISH_DERIVED);
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("trend-down");
      expect(inference.confidence).toBe("HIGH");
    }
  });

  it("flow alone never creates a thesis (flat name, bullish flow)", () => {
    const flat = barsFromCloses(Array.from({ length: 60 }, () => 100));
    const { inference } = run(flat, BULLISH_DERIVED);
    // The flat name may infer via range/breakout rules or abstain;
    // what flow must not do is produce a directional inference.
    if (inference.inferred) {
      expect(inference.thesis).not.toBe("bullish");
    }
  });
});
