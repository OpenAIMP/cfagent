import { describe, expect, it } from "vitest";

import { getDiscoveryConfig } from "../src/config/etapiConfig";
import type { YahooDailyBar } from "../src/trading/yahooHistory";
import type { IvStats } from "../src/trading/options/ivHistoryStore";
import {
  characterizeName,
  detectSignals,
  type ChainAggregates,
  type DiscoveryNameInputs,
} from "../src/trading/options/discoverySignals";
import { inferThesis } from "../src/trading/options/discoveryInference";
import type { EventCalendarInfo } from "../src/trading/options/strategyEngine";

/**
 * Issue #18 slice 1 — EVENT_NEAR + MOVE_UNDERPRICED and the §6.2
 * inference modifiers.
 *
 * Acceptance pins: earnings-adjacent setups are labeled (the
 * EVENT_NEAR evidence line carries the label), and EVENT_NEAR
 * suppresses range_bound inference unless an IV signal dominates
 * (IV_EXPENSIVE) — verified by fixture pairs that differ only in
 * the calendar / IV rank.
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

/** Tight, drift-free range: the range-pinned fixture. */
const FLAT_BARS = barsFromCloses(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 99.5 : 100.5)));
/** The pinned range with a soft final close: still pinned, but far
 *  enough below the prior high that BREAKOUT_WATCH stays quiet — so
 *  a suppressed range has no other rule to fall into. */
const FLAT_DIPPED_BARS = barsFromCloses([
  ...Array.from({ length: 59 }, (_, i) => (i % 2 === 0 ? 99.5 : 100.5)),
  98.5,
]);
/** ±4% sawtooth: high realized vol, no trend, no range pin. */
const WILD_BARS = barsFromCloses(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 104 : 96)));

const LIQUID_CHAIN: ChainAggregates = {
  contractCount: 12,
  totalOpenInterest: 52_000,
  totalVolume: 8_400,
  medianSpreadPct: 4,
  atmIv: 0.2,
};

function ivStats(ivRank: number): IvStats {
  return {
    latest: { date: "2026-10-21", atmIv: 0.2 },
    observations: 120,
    ivRank,
    ivPercentile: ivRank,
    warmingUp: false,
  } as unknown as IvStats;
}

function calendar(daysToEarnings: number | null, covered = true): EventCalendarInfo {
  return {
    covered,
    source: "test",
    earningsDate: daysToEarnings === null ? null : "2026-11-05",
    daysToEarnings,
    exDividendDate: null,
    daysToExDiv: null,
  };
}

function run(
  bars: YahooDailyBar[],
  stats: IvStats | null,
  cal: EventCalendarInfo | null,
  chain: ChainAggregates | null = LIQUID_CHAIN,
) {
  const inputs: DiscoveryNameInputs = { symbol: "ACME", bars, ivStats: stats, chain, eventCalendar: cal };
  const c = characterizeName(inputs, CFG);
  const signals = detectSignals(c, CFG);
  return { c, signals, inference: inferThesis(c, signals, CFG, MULTIPLES) };
}

const sig = (signals: ReturnType<typeof detectSignals>, t: string) => signals.find((s) => s.type === t)!;

describe("config", () => {
  it("pins the Phase 2 calibration defaults", () => {
    expect(CFG.eventNearDays).toBe(21);
    expect(CFG.moveUnderpricedMaxRatio).toBe(0.8);
  });
});

describe("characterization — event + realized vol", () => {
  it("carries the calendar facts and computes realized vol from bars", () => {
    const { c } = run(WILD_BARS, null, calendar(10));
    expect(c.daysToEarnings).toBe(10);
    expect(c.earningsDate).toBe("2026-11-05");
    expect(c.eventCovered).toBe(true);
    expect(c.realizedVol).not.toBeNull();
    expect(c.realizedVol!).toBeGreaterThan(0.4);
  });

  it("no calendar input -> uncovered, no earnings facts", () => {
    const { c } = run(WILD_BARS, null, null);
    expect(c.eventCovered).toBe(false);
    expect(c.daysToEarnings).toBeNull();
  });
});

describe("EVENT_NEAR", () => {
  it("fires inside the window and its evidence labels the name earnings-adjacent", () => {
    const { signals } = run(FLAT_BARS, ivStats(50), calendar(14));
    const s = sig(signals, "EVENT_NEAR");
    expect(s.fired).toBe(true);
    expect(s.evidence).toContain("earnings-adjacent");
    expect(s.evidence).toContain("14d");
  });

  it("does not fire outside the window, uncovered, or with no earnings scheduled", () => {
    expect(sig(run(FLAT_BARS, ivStats(50), calendar(30)).signals, "EVENT_NEAR").fired).toBe(false);
    expect(sig(run(FLAT_BARS, ivStats(50), calendar(10, false)).signals, "EVENT_NEAR").fired).toBe(false);
    expect(sig(run(FLAT_BARS, ivStats(50), calendar(null)).signals, "EVENT_NEAR").fired).toBe(false);
  });
});

describe("MOVE_UNDERPRICED", () => {
  it("fires when the implied move is cheap against realized vol into a near event", () => {
    // atmIv 0.20 (chain) vs realized ~0.6: ratio 0.33 <= 0.8.
    const { signals } = run(WILD_BARS, null, calendar(10));
    expect(sig(signals, "MOVE_UNDERPRICED").fired).toBe(true);
  });

  it("never fires without a near event, however cheap the implied move", () => {
    expect(sig(run(WILD_BARS, null, calendar(45)).signals, "MOVE_UNDERPRICED").fired).toBe(false);
    expect(sig(run(WILD_BARS, null, null).signals, "MOVE_UNDERPRICED").fired).toBe(false);
  });

  it("does not fire when the market already prices the move", () => {
    // The sawtooth's realized vol annualizes past 1.2; an ATM IV of
    // 1.1 is a ratio of ~0.87 — the move is priced, not underpriced.
    const richChain = { ...LIQUID_CHAIN, atmIv: 1.1 };
    const { signals } = run(WILD_BARS, null, calendar(10), richChain);
    expect(sig(signals, "MOVE_UNDERPRICED").fired).toBe(false);
  });
});

describe("inference modifiers (§6.2)", () => {
  it("EVENT_NEAR suppresses range_bound when no IV signal dominates", () => {
    const { inference } = run(FLAT_DIPPED_BARS, ivStats(50), calendar(10));
    expect(inference.inferred).toBe(false);
    if (!inference.inferred) {
      expect(inference.reason).toContain("range_bound");
      expect(inference.reason).toContain("EVENT_NEAR");
    }
  });

  it("control: the same range infers range_bound with no near event", () => {
    const { inference } = run(FLAT_BARS, ivStats(50), null);
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("range-pinned");
      expect(inference.thesis).toBe("range_bound");
    }
  });

  it("IV_EXPENSIVE dominates: the rich-IV range rule still fires into the event", () => {
    const { inference } = run(FLAT_BARS, ivStats(90), calendar(10));
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("range-pinned-rich-iv");
      expect(inference.firedSignals).toContain("EVENT_NEAR");
    }
  });

  it("event + underpriced move infers large_move (rule event-move-underpriced)", () => {
    const { inference } = run(WILD_BARS, null, calendar(10));
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("event-move-underpriced");
      expect(inference.thesis).toBe("large_move");
      expect(inference.expectedIvDirection).toBe("rise");
      expect(inference.confidence).toBe("MEDIUM");
    }
  });

  it("cheap IV alongside raises the event rule to HIGH", () => {
    const { inference } = run(WILD_BARS, ivStats(10), calendar(10));
    expect(inference.inferred).toBe(true);
    if (inference.inferred) {
      expect(inference.ruleId).toBe("event-move-underpriced");
      expect(inference.confidence).toBe("HIGH");
    }
  });
});
