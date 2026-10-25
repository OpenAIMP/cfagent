import { describe, expect, it } from "vitest";

import { getDiscoveryConfig, getOpportunityScannerConfig } from "../src/config/etapiConfig";
import type { YahooDailyBar } from "../src/trading/technicals";
import type { BestTradePick, PipelineResult, RankedStrategy, StrategyCandidate } from "../src/trading/options/optionsAgentPipeline";
import type { OptionsDataSnapshot } from "../src/trading/options/optionsDataAgent";
import type { StrategyRequest } from "../src/trading/options/strategyEngine";
import {
  expressDiscoverySetup,
  resolveDiscoveryFitGate,
} from "../src/trading/options/discoveryExpression";
import { InMemoryDiscoverySetupStore } from "../src/trading/options/discoverySetupStore";
import { runDiscovery, type DiscoveryServiceDeps } from "../src/services/discoveryService";

/**
 * Issue #18 slice 5 — Strategy Profile biasing. The rule from the
 * issue: biasing may influence RANKING only — never which signals
 * fire, never the inference, never the recorded scores. The
 * profile contributes its allowed strategy types; the boost size
 * is discovery config (profileBiasPoints). These fixtures prove:
 * a preferred type can win the pick when the boost overcomes the
 * raw gap; the recorded score stays the RAW composite; and a
 * service run with a profile produces byte-identical signals and
 * inference to the same run without one.
 */

const CFG = getDiscoveryConfig();
const GATE = resolveDiscoveryFitGate(getOpportunityScannerConfig(), CFG);

function rankedFixture(type: string, compositeScore: number, id: string): RankedStrategy {
  const candidate = {
    id,
    type,
    label: `${type} ${id}`,
    symbol: "ACME",
    expirationDate: "2026-11-20",
    dataFreshness: "FRESH",
    modelImpliedProbabilityOfProfit: 0.42,
  } as unknown as StrategyCandidate;
  return {
    candidate,
    rank: 0,
    compositeScore,
    components: { engineScore: 0, probability: 0, rewardRisk: 0, capitalSafety: 0, liquidity: 0 },
  };
}

function pickFixture(best: RankedStrategy | undefined): BestTradePick {
  return {
    status: best ? "recommended" : "no_trade",
    riskProfile: "balanced",
    confidence: "MEDIUM",
    best,
    alternatives: [],
    rationale: [],
    blockers: [],
    humanApprovalRequired: true,
    disclaimer: "fixture",
  } as BestTradePick;
}

const REQUEST = { symbol: "ACME", thesis: "bullish" } as unknown as StrategyRequest;

/** Pipeline whose raw winner is the long call (80) over the bull
 *  put spread (78) — close enough for a 5-point bias to flip. */
function closePipeline(): { run(req: StrategyRequest): Promise<PipelineResult> } {
  const lc = rankedFixture("long_call", 80, "lc-1");
  const bps = rankedFixture("bull_put_spread", 78, "bps-1");
  const result = {
    snapshot: {},
    strategies: {},
    screenedOut: [],
    ranked: [lc, bps],
    riskReports: [],
    bestTrade: pickFixture(lc),
  } as unknown as PipelineResult;
  return { run: async () => result };
}

describe("config", () => {
  it("pins the bias size as calibration", () => {
    expect(CFG.profileBiasPoints).toBe(5);
  });
});

describe("expression-level bias (ranking only)", () => {
  it("without a bias the raw winner stays the pick", async () => {
    const expr = await expressDiscoverySetup(closePipeline(), REQUEST, GATE);
    expect(expr.pick.best?.candidate.type).toBe("long_call");
    expect(expr.pick.best?.compositeScore).toBe(80);
  });

  it("a preferred type wins the pick when the boost overcomes the raw gap — score recorded raw", async () => {
    const expr = await expressDiscoverySetup(closePipeline(), REQUEST, GATE, {
      preferredTypes: ["bull_put_spread"],
      points: CFG.profileBiasPoints,
    });
    expect(expr.pick.best?.candidate.type).toBe("bull_put_spread");
    // The recorded composite is the candidate's RAW score — the
    // boost exists only in the comparison, never in the record.
    expect(expr.pick.best?.compositeScore).toBe(78);
    // The roll-up stays raw too.
    expect(expr.rollup.map((r) => [r.type, r.compositeScore])).toEqual([
      ["long_call", 80],
      ["bull_put_spread", 78],
    ]);
  });

  it("a boost too small to close the gap changes nothing", async () => {
    const expr = await expressDiscoverySetup(closePipeline(), REQUEST, GATE, {
      preferredTypes: ["bull_put_spread"],
      points: 1,
    });
    expect(expr.pick.best?.candidate.type).toBe("long_call");
  });

  it("a bias for an absent type changes nothing", async () => {
    const expr = await expressDiscoverySetup(closePipeline(), REQUEST, GATE, {
      preferredTypes: ["iron_condor"],
      points: 25,
    });
    expect(expr.pick.best?.candidate.type).toBe("long_call");
  });

  it("bias never manufactures a pick from a no-trade result", async () => {
    const result = {
      snapshot: {},
      strategies: {},
      screenedOut: [],
      ranked: [rankedFixture("bull_put_spread", 78, "bps-1")],
      riskReports: [],
      bestTrade: pickFixture(undefined),
    } as unknown as PipelineResult;
    const expr = await expressDiscoverySetup({ run: async () => result }, REQUEST, GATE, {
      preferredTypes: ["bull_put_spread"],
      points: 25,
    });
    expect(expr.pick.best).toBeUndefined();
  });
});

// --- service-level acceptance: signals + inference untouched ---

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

const TREND_BARS = barsFromCloses([
  ...Array.from({ length: 60 }, (_, i) => 100 + ((132 - 100) / 59) * i),
  130,
]);

function snapshot(symbol: string): OptionsDataSnapshot {
  const contracts = Array.from({ length: 12 }, (_, i) => ({
    symbol: `${symbol}251120C${100 + i * 5}`,
    underlyingSymbol: symbol,
    underlyingPrice: 130,
    strikePrice: 120 + i * 5,
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
  return {
    symbol,
    contracts,
    dataSource: "live",
    screen: { underlyingsScanned: 1, contractsEvaluated: 12, contractsMatched: 12 },
    rejections: [],
  } as unknown as OptionsDataSnapshot;
}

function makeDeps(store: InMemoryDiscoverySetupStore): DiscoveryServiceDeps {
  const pipeline = closePipeline();
  return {
    loadSnapshot: async (symbol) => snapshot(symbol),
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
    runPipeline: (req) => pipeline.run(req),
    store,
    now: () => new Date("2026-10-22T13:00:00.000Z"),
  };
}

describe("service acceptance: the profile moves ranking, nothing else", () => {
  it("identical signals and inference with and without a profile; only the pick flips", async () => {
    const plain = await runDiscovery(makeDeps(new InMemoryDiscoverySetupStore()), {
      symbols: ["ACME"],
      scopeKey: "test:bias-plain",
      source: "test",
      caps: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
    });
    const biased = await runDiscovery(makeDeps(new InMemoryDiscoverySetupStore()), {
      symbols: ["ACME"],
      scopeKey: "test:bias-profile",
      source: "test",
      caps: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
      profileBias: { preferredTypes: ["bull_put_spread"] },
    });
    const plainItem = plain.run.items.find((i) => i.kind === "setup");
    const biasedItem = biased.run.items.find((i) => i.kind === "setup");
    expect(plainItem?.kind).toBe("setup");
    expect(biasedItem?.kind).toBe("setup");
    if (plainItem?.kind === "setup" && biasedItem?.kind === "setup") {
      // Signals + inference identical (the acceptance line).
      expect(biasedItem.firedSignals).toEqual(plainItem.firedSignals);
      expect(biasedItem.ruleId).toBe(plainItem.ruleId);
      expect(biasedItem.thesis).toBe(plainItem.thesis);
      // Ranking moved: raw scores differ because a different pick
      // was selected — each still the RAW composite of its pick.
      expect(plainItem.discoveryScore).toBe(80);
      expect(biasedItem.discoveryScore).toBe(78);
      expect(biasedItem.rollup).toEqual(plainItem.rollup);
    }
  });
});
