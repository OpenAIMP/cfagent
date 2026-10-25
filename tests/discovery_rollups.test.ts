import { describe, expect, it } from "vitest";

import type { YahooDailyBar } from "../src/trading/yahooHistory";
import type { BestTradePick, RankedStrategy } from "../src/trading/options/recommendationAgent";
import type { PipelineResult } from "../src/trading/options/panelPipeline";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";
import { InMemoryDiscoverySetupStore, type StoredDiscoverySetupRun } from "../src/trading/options/discoverySetupStore";
import {
  formatDiscoveryRunSummary,
  runDiscovery,
  type DiscoveryServiceDeps,
} from "../src/services/discoveryService";

/**
 * Issue #18 slice 4 — per-type roll-ups in setup cards. The
 * expression already computes the best candidate per strategy
 * type; the run item now carries that roll-up (slim projection)
 * and the shared card formatter renders it. Runs stored before
 * this slice have no rollup and must render unchanged.
 */

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

const TREND_BARS = barsFromCloses([...linearCloses(100, 132, 60), 130]);

function snapshot(symbol: string, spot: number, contractCount: number): OptionsDataSnapshot {
  const contracts = Array.from({ length: contractCount }, (_, i) => ({
    symbol: `${symbol}251120C${100 + i * 5}`,
    underlyingSymbol: symbol,
    underlyingPrice: spot,
    strikePrice: spot - 10 + i * 5,
    expirationDate: "2026-11-20",
    daysToExpiration: 29,
    moneyness: "ATM" as const,
    strikeDistancePct: 0,
    spreadPct: 3,
    technicalSignal: "",
    highlightReason: "",
    bid: 1,
    ask: 1.05,
    volume: 900,
    openInterest: 6_000,
    impliedVolatility: 0.3,
  }));
  return { symbol, spot, contracts } as unknown as OptionsDataSnapshot;
}

function ranked(type: string, label: string, score: number, rank: number): RankedStrategy {
  const candidate = {
    id: `cand-${type}-${rank}`,
    type,
    label,
    symbol: "ACME",
    expirationDate: "2026-11-20",
    dataFreshness: "FRESH",
    modelImpliedProbabilityOfProfit: 0.42,
  } as unknown as StrategyCandidate;
  return {
    candidate,
    rank,
    compositeScore: score,
    components: { engineScore: 0, probability: 0, rewardRisk: 0, capitalSafety: 0, liquidity: 0 },
  } as RankedStrategy;
}

function twoTypePipeline(): PipelineResult {
  const best = ranked("long_call", "Long call", 88, 1);
  const pick: BestTradePick = {
    status: "recommended",
    riskProfile: "balanced",
    confidence: "MEDIUM",
    best,
    alternatives: [],
    rationale: [],
  } as unknown as BestTradePick;
  return {
    snapshot: {},
    strategies: {},
    screenedOut: [],
    ranked: [best, ranked("bull_put_spread", "Bull put spread", 71, 2), ranked("long_call", "Long call", 60, 3)],
    riskReports: [],
    bestTrade: pick,
  } as unknown as PipelineResult;
}

function makeDeps(store: InMemoryDiscoverySetupStore): DiscoveryServiceDeps {
  return {
    loadSnapshot: async (symbol) => snapshot(symbol, 130, 12),
    fetchBars: async () => TREND_BARS,
    ivStatsFor: async () => null,
    calendarFor: async (symbol) => ({
      symbol,
      covered: false,
      source: "test",
      earningsDate: null,
      daysToEarnings: null,
      exDividendDate: null,
      daysToExDiv: null,
      fetchedAt: "2026-10-22T12:00:00.000Z",
    }),
    flowFor: async () => [],
    runPipeline: async () => twoTypePipeline(),
    store,
    now: () => new Date("2026-10-22T13:00:00.000Z"),
  };
}

describe("roll-up on expressed setup items", () => {
  it("carries the best-per-type roll-up, slim-projected and best-first", async () => {
    const store = new InMemoryDiscoverySetupStore();
    const outcome = await runDiscovery(makeDeps(store), {
      symbols: ["ACME"],
      scopeKey: "test:rollup",
      source: "test",
      caps: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
    });
    const item = outcome.run.items.find((i) => i.kind === "setup");
    expect(item?.kind).toBe("setup");
    if (item?.kind === "setup") {
      expect(item.rollup).toEqual([
        { type: "long_call", label: "Long call", compositeScore: 88 },
        { type: "bull_put_spread", label: "Bull put spread", compositeScore: 71 },
      ]);
    }
  });

  it("the card renders the roll-up line under the setup", async () => {
    const store = new InMemoryDiscoverySetupStore();
    const outcome = await runDiscovery(makeDeps(store), {
      symbols: ["ACME"],
      scopeKey: "test:rollup",
      source: "test",
      caps: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
    });
    const card = formatDiscoveryRunSummary(outcome);
    expect(card).toContain("Roll-up: Long call 88 · Bull put spread 71");
  });
});

describe("formatter tolerance for pre-slice runs", () => {
  it("a stored setup without a rollup renders no roll-up line", () => {
    const run: StoredDiscoverySetupRun = {
      id: "legacy-run",
      modelVersion: "discovery-v1",
      createdAt: "2026-10-21T13:00:00.000Z",
      scopeKey: "test:legacy",
      source: "test",
      configHash: "abcd1234",
      counts: { considered: 1, setups: 1, abstentions: 0, prescreenedOut: 0, errors: 0 },
      items: [
        {
          kind: "setup",
          symbol: "ACME",
          thesis: "bullish",
          ruleId: "trend-up",
          confidence: "MEDIUM",
          discoveryScore: 72,
          gateBucket: "fit",
          targetPrice: 150,
          targetDate: "2026-12-18",
          firedSignals: ["TREND_UP"],
          evidence: "fast above slow",
        },
      ],
    };
    const card = formatDiscoveryRunSummary({ run, deltas: [], errors: [] });
    expect(card).toContain("ACME bullish");
    expect(card).not.toContain("Roll-up:");
  });
});
