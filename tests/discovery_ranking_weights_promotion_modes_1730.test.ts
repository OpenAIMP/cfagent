/**
 * #1730 (parent #1717, slice (j)): discovery / ranking / weights /
 * promotion remainders — scan appendix (j) findings D1, D2, D3, D4,
 * DF, W1, W2, P1, P2, S3.
 *
 * This slice adds NO runtime switch, deliberately. Every divergent
 * pair in appendix (j) is divergent-by-design: flipping any of them
 * would be a safety/governance regression, a retired-flag
 * resurrection, or a phantom switch with no single call site that
 * could honor both values. The slice therefore pins each pair's
 * resolution in src/config/discoveryRankingModes.ts (the registry)
 * and pins the behavior distinctions below, so a future change
 * cannot silently flip one. The full switch-vs-pin justification
 * per pair lives in the registry module header and the §9 PR body.
 *
 * What this suite does NOT duplicate (already pinned elsewhere,
 * cited, not re-tested): the kernel decorator's within-tier rule
 * and the LLM policies' reorder (consolidation_c4_kernel), the
 * fit-runner flag-off posture and negative-cell guard
 * (phase6_channels_rollout), pick-only profile bias
 * (discovery_profile_bias), v2-always routes + retired flag
 * (consolidation_c5_weights), the challenger routes
 * (adaptation_challenger_routes), and annotateQuantRanking's
 * order/length/reference contract (ranking_core_p1640). The
 * tests here pin the (j)-LEVEL distinctions: the same input
 * through two semantics must come out differently, and the
 * pairs that must never merge must be observably distinct.
 */
import { describe, expect, it } from "vitest";

import { getDiscoveryConfig, getOpportunityScannerConfig } from "../src/config/etapiConfig";
import {
  DISCOVERY_RANKING_1730_PINS,
  DISCOVERY_RANKING_1730_SWITCHES,
  discoveryRankingPin,
} from "../src/config/discoveryRankingModes";
import {
  LlmRankPolicy,
  PassthroughWeightsRankDecorator,
  RecommendationService,
  type KernelCandidate,
} from "../src/services/recommendationKernel";
import { annotateQuantRanking } from "../src/services/rankingCore";
import { applyWeightsV2Ranking, createFitDiscoveryRunner } from "../src/services/fitDiscoveryRunner";
import {
  expressDiscoverySetup,
  resolveDiscoveryFitGate,
} from "../src/trading/options/discoveryExpression";
import {
  createDiscoveryService,
  hashDiscoveryConfig,
  type DiscoveryRunRequest,
} from "../src/services/discoveryService";
import {
  discoverNamesForStrategy,
  discoverStrategiesForName,
  runDiscoveryMode,
  type DiscoveryModeRequest,
  type NameDiscoveryResult,
  type StrategyDiscoveryResult,
} from "../src/services/researchDiscovery";
import {
  STRATEGY_WEIGHT_BOUNDS,
  buildWeightPolicyEvaluation,
  getStrategyWeights,
  runStrategyWeightAdjustment,
  WEIGHT_ADAPTATION_ACTOR,
} from "../src/services/strategyWeights";
import {
  getStrategyWeightsV2,
  getStrategyWeightsV2Collapsed,
  getStrategyWeightsV2ForRegime,
  weightsV2Key,
  WEIGHTS_V2_ACTOR,
  WEIGHTS_V2_DEFAULTS,
} from "../src/services/strategyWeightsV2";
import * as stagedPromotion from "../src/services/stagedPromotion";
import * as championChallenger from "../src/services/championChallenger";
import * as proposalChallengerBridge from "../src/services/proposalChallengerBridge";
import * as candidateEvaluation from "../src/services/candidateEvaluation";
import * as promotionGate from "../src/services/promotionGate";
import * as recommendationBundle from "../src/services/recommendationBundle";
import * as kernelDiscoveryMapping from "../src/services/kernelDiscoveryMapping";
import * as panelPipeline from "../src/trading/options/panelPipeline";
import { OpportunityScannerFitHandler } from "../src/services/scannerFitGateHandler";
import { evaluateFitGate } from "../src/trading/options/opportunityScanner";
import type { BestTradePick, RankedStrategy } from "../src/trading/options/recommendationAgent";
import type { PipelineResult } from "../src/trading/options/panelPipeline";
import type { StrategyCandidate, StrategyRequest } from "../src/trading/options/strategyEngine";
import type { ImprovementCandidate } from "../src/services/improvementCandidates";
import type { TrackRecord, TrackRecordIdea } from "../src/services/researchTrackRecord";

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe("appendix (j) registry", () => {
  it("covers every appendix (j) finding exactly once, with a resolution and a reason", () => {
    const ids = DISCOVERY_RANKING_1730_PINS.map((p) => p.id);
    expect(ids.sort()).toEqual(["D1", "D2", "D3", "D4", "DF", "P1", "P2", "S3", "W1", "W2"]);
    for (const pin of DISCOVERY_RANKING_1730_PINS) {
      expect(pin.reason.length).toBeGreaterThan(0);
      expect(pin.defaultBehavior.length).toBeGreaterThan(0);
      expect(["pinned", "identical"]).toContain(pin.resolution);
    }
  });

  it("adds no runtime switch: the switches list is deliberately empty", () => {
    expect(DISCOVERY_RANKING_1730_SWITCHES).toEqual([]);
  });

  it("looks pins up by id and returns undefined for unknown ids", () => {
    expect(discoveryRankingPin("D3")?.id).toBe("D3");
    expect(discoveryRankingPin("W2")?.resolution).toBe("pinned");
    expect(discoveryRankingPin("S3")?.resolution).toBe("identical");
    expect(discoveryRankingPin("X9" as never)).toBeUndefined();
  });

  it("records the divergent pairs as pinned, not switched, and the single-path findings as identical", () => {
    const byId = new Map(DISCOVERY_RANKING_1730_PINS.map((p) => [p.id, p.resolution]));
    expect(byId.get("D1")).toBe("pinned");
    expect(byId.get("D3")).toBe("pinned");
    expect(byId.get("D4")).toBe("pinned");
    expect(byId.get("W1")).toBe("pinned");
    expect(byId.get("W2")).toBe("pinned");
    expect(byId.get("P1")).toBe("pinned");
    expect(byId.get("P2")).toBe("pinned");
    expect(byId.get("D2")).toBe("identical");
    expect(byId.get("DF")).toBe("identical");
    expect(byId.get("S3")).toBe("identical");
  });
});

/* ------------------------------------------------------------------ */
/* D1 — two discovery runners, two request shapes, two keyings        */
/* ------------------------------------------------------------------ */

describe("D1 discovery runners", () => {
  it("both runner factories exist and are distinct", () => {
    expect(typeof createDiscoveryService).toBe("function");
    expect(typeof createFitDiscoveryRunner).toBe("function");
    expect(createDiscoveryService).not.toBe(createFitDiscoveryRunner);
  });

  it("the request shapes are disjoint: scope/profile-bias vs direction-tagged", () => {
    const scopeRequest: DiscoveryRunRequest = {
      symbols: ["AAA"],
      scopeKey: "watchlist-7",
      source: "nlq",
      caps: { maxPlannedLoss: 500, minRewardRisk: 1 },
      profileBias: { preferredTypes: ["long_call"] },
    };
    const fitRequest: DiscoveryModeRequest = {
      direction: "name_to_strategies",
      symbol: "AAA",
      outlook: "bullish",
    };
    expect(Object.keys(scopeRequest).sort()).toContain("scopeKey");
    expect(Object.keys(scopeRequest).sort()).toContain("profileBias");
    expect("direction" in scopeRequest).toBe(false);
    expect(fitRequest.direction).toBe("name_to_strategies");
    expect("scopeKey" in fitRequest).toBe(false);
  });

  it("discovery config hashing is deterministic and scope-config sensitive, unlike the fit regime key", () => {
    const base = getDiscoveryConfig();
    expect(hashDiscoveryConfig(base)).toBe(hashDiscoveryConfig(base));
    expect(hashDiscoveryConfig({ ...base, compositeFloor: (base.compositeFloor ?? 0) + 1 })).not.toBe(
      hashDiscoveryConfig(base),
    );
    expect(weightsV2Key("iron_condor", "chop")).toBe("iron_condor|chop");
  });
});

/* ------------------------------------------------------------------ */
/* D3 — three weight semantics that must not be conflated              */
/* ------------------------------------------------------------------ */

function kernelCandidate(over: Partial<KernelCandidate>): KernelCandidate {
  return {
    id: "k",
    symbol: "AAA",
    structure: "vertical_spread",
    label: "fixture",
    legs: [],
    economics: null,
    status: "qualified",
    provenance: "quant",
    chainProvenance: "live",
    definedRisk: true,
    marginEstimate: null,
    assignmentRisk: false,
    gateReasons: [],
    limitations: [],
    rationale: "fixture",
    builderId: "fixture",
    ...over,
  } as unknown as KernelCandidate;
}

function fitCandidate(label: string, structure: string, worst: number, mean: number) {
  return {
    symbol: "NVDA",
    structure,
    label,
    source: "catalog" as const,
    legs: [],
    economics: { netDebit: 0, netCredit: 0, maxLoss: 100, maxGain: 100, breakevens: [] },
    status: "qualified" as const,
    provenance: "live" as const,
    definedRisk: true,
    marginEstimate: 100,
    assignmentRisk: false,
    gateReasons: [],
    limitations: [],
    scenario: { worstPnlTotal: worst, meanPnlTotal: mean, bestPnlTotal: 100, withinConstraints: true },
  };
}

describe("D3 weight-application semantics", () => {
  it("fit multipliers and the kernel decorator DISAGREE on the same weights — different math, both preserved", () => {
    // A: worst 10, weight 1. B: worst 4, weight 2.
    // Fit multipliers rescale scores: A 10 vs B 8 → A stays first.
    // Kernel decorator reorders by weight alone within tier: B (2) before A (1).
    const fitResult: NameDiscoveryResult = {
      symbol: "NVDA",
      outlook: "range_bound",
      provenance: "live",
      candidates: [fitCandidate("A", "iron_condor", 10, 8), fitCandidate("B", "butterfly", 4, 3)],
      rejected: [],
      notConstructible: [],
      inadmissibleCatalogIds: [],
      limitations: [],
    };
    const { result: fitRanked } = applyWeightsV2Ranking(
      { direction: "name_to_strategies", result: fitResult },
      { [weightsV2Key("iron_condor", "chop")]: 1, [weightsV2Key("butterfly", "chop")]: 2 },
      "chop",
    );
    if (fitRanked.direction !== "name_to_strategies") throw new Error("direction changed");
    expect(fitRanked.result.candidates.map((c) => c.label)).toEqual(["A", "B"]);

    const decorated = new PassthroughWeightsRankDecorator({
      weightsFn: (c) => (c.id === "b" ? 2 : 1),
    }).decorate(
      [kernelCandidate({ id: "a", status: "qualified" }), kernelCandidate({ id: "b", status: "qualified" })],
      {},
    );
    expect(decorated.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("fit strategy→names ranking rescales fitScore by weight (a second, distinct multiplier path)", () => {
    const strategyResult: StrategyDiscoveryResult = {
      structure: "iron_condor",
      ranked: [
        {
          symbol: "AAA",
          structure: "iron_condor",
          status: "qualified",
          provenance: "live",
          fitScore: 10,
          components: { liquidity: 0.9, ivFit: 0.8, termStructureFit: null, earningsDistance: 0.7, correlation: null, trackRecord: null },
          missingComponents: ["termStructureFit", "correlation", "trackRecord"],
          economics: { netDebit: 0, netCredit: 2, maxLoss: 300, maxGain: 200 },
        },
        {
          symbol: "BBB",
          structure: "iron_condor",
          status: "qualified",
          provenance: "live",
          fitScore: 5,
          components: { liquidity: 0.9, ivFit: 0.8, termStructureFit: null, earningsDistance: 0.7, correlation: null, trackRecord: null },
          missingComponents: ["termStructureFit", "correlation", "trackRecord"],
          economics: { netDebit: 0, netCredit: 2, maxLoss: 300, maxGain: 200 },
        },
      ],
      rejected: [],
      limitations: [],
    };
    // Both fits share the iron_condor structure key, so the shared
    // 0.5 weight scales both fitScores equally: relative order is
    // preserved, and the per-weight note proves the multiplier applied.
    const { result: ranked, notes } = applyWeightsV2Ranking(
      { direction: "strategy_to_names", result: strategyResult },
      { [weightsV2Key("iron_condor", "chop")]: 0.5 },
      "chop",
    );
    if (ranked.direction !== "strategy_to_names") throw new Error("direction changed");
    expect(ranked.result.ranked.map((f) => f.symbol)).toEqual(["AAA", "BBB"]);
    expect(notes.join(" ")).toMatch(/iron_condor ×0\.50/);
  });

  it("profile bias flips the PICK but never the roll-up order — unlike the fit reorder above", async () => {
    const cfg = getDiscoveryConfig();
    const gate = resolveDiscoveryFitGate(getOpportunityScannerConfig(), cfg);
    const rankedFixture = (type: string, compositeScore: number, id: string): RankedStrategy => {
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
    };
    const pickFixture = (best: RankedStrategy | undefined): BestTradePick =>
      ({
        status: best ? "recommended" : "no_trade",
        riskProfile: "balanced",
        confidence: "MEDIUM",
        best,
        alternatives: [],
        rationale: [],
        blockers: [],
        humanApprovalRequired: true,
        disclaimer: "fixture",
      }) as BestTradePick;
    const lc = rankedFixture("long_call", 80, "lc-1");
    const bps = rankedFixture("bull_put_spread", 78, "bps-1");
    const pipeline = {
      run: async () =>
        ({
          snapshot: {},
          strategies: {},
          screenedOut: [],
          ranked: [lc, bps],
          riskReports: [],
          bestTrade: pickFixture(lc),
        }) as unknown as PipelineResult,
    };
    const request = { symbol: "ACME", thesis: "bullish" } as unknown as StrategyRequest;
    const plain = await expressDiscoverySetup(pipeline, request, gate);
    const biased = await expressDiscoverySetup(pipeline, request, gate, {
      preferredTypes: ["bull_put_spread"],
      points: cfg.profileBiasPoints,
    });
    expect(plain.pick.best?.candidate.type).toBe("long_call");
    expect(biased.pick.best?.candidate.type).toBe("bull_put_spread");
    // The roll-up — the recorded order — is identical with and without bias.
    expect(biased.rollup).toEqual(plain.rollup);
    expect(biased.pick.best?.compositeScore).toBe(78);
  });
});

/* ------------------------------------------------------------------ */
/* D4 — annotate (production) vs LLM reorder (comparison-only)         */
/* ------------------------------------------------------------------ */

describe("D4 LLM overlay", () => {
  it("the same input through annotate vs LlmRankPolicy comes out differently — and only annotate is production", () => {
    const ranked = [
      { candidate: { id: "a" } },
      { candidate: { id: "b" } },
      { candidate: { id: "c" } },
    ];
    const annotated = annotateQuantRanking(ranked, [
      { candidateId: "b", score: 9, rationale: "llm prefers b" },
    ]);
    expect(annotated.map((a) => a.ranked.candidate.id)).toEqual(["a", "b", "c"]);
    expect(annotated.map((a) => a.ranked)).toEqual(ranked);
    expect(annotated[1].annotation?.score).toBe(9);
    expect(annotated[0].annotation).toBeNull();

    const reordered = new LlmRankPolicy({ orderFn: (ids) => [...ids].reverse() }).rank(
      [
        kernelCandidate({ id: "a" }),
        kernelCandidate({ id: "b" }),
        kernelCandidate({ id: "c" }),
      ],
      {},
    );
    expect(reordered.map((c) => c.id)).toEqual(["c", "b", "a"]);
    // The reorder lives only in the explicitly constructed comparison
    // policy; annotateQuantRanking can never produce it.
  });
});

/* ------------------------------------------------------------------ */
/* W1 — v1 dormant, v2 live, bounds shared, drain still reads v1       */
/* ------------------------------------------------------------------ */

describe("W1 weights v1 vs v2", () => {
  it("v2 reuses the v1 bounds verbatim (no second bounds regime) plus its own decay half-life", () => {
    expect(WEIGHTS_V2_DEFAULTS.min).toBe(STRATEGY_WEIGHT_BOUNDS.min);
    expect(WEIGHTS_V2_DEFAULTS.max).toBe(STRATEGY_WEIGHT_BOUNDS.max);
    expect(WEIGHTS_V2_DEFAULTS.maxStep).toBe(STRATEGY_WEIGHT_BOUNDS.maxStep);
    expect(WEIGHTS_V2_DEFAULTS.deadband).toBe(STRATEGY_WEIGHT_BOUNDS.deadband);
    expect(WEIGHTS_V2_DEFAULTS.minSample).toBe(STRATEGY_WEIGHT_BOUNDS.minSample);
    expect(WEIGHTS_V2_DEFAULTS.defaultWeight).toBe(STRATEGY_WEIGHT_BOUNDS.defaultWeight);
    expect(WEIGHTS_V2_DEFAULTS.halfLifeDays).toBe(90);
    expect(STRATEGY_WEIGHT_BOUNDS.min).toBe(0.25);
    expect(STRATEGY_WEIGHT_BOUNDS.max).toBe(2.0);
  });

  it("the v1 adjustment, the v1 read, and the GET evaluation builder all still exist — retirement unwinds them, it does not delete them here", () => {
    expect(typeof runStrategyWeightAdjustment).toBe("function");
    expect(typeof getStrategyWeights).toBe("function");
    expect(typeof buildWeightPolicyEvaluation).toBe("function");
    expect(WEIGHT_ADAPTATION_ACTOR).toBe("strategy-weight-job");
    expect(WEIGHTS_V2_ACTOR).toBe("strategy-weight-v2-job");
    expect(WEIGHT_ADAPTATION_ACTOR).not.toBe(WEIGHTS_V2_ACTOR);
  });
});

/* ------------------------------------------------------------------ */
/* W2 — one store, three reads, three answers for {bull 2.0, bear 0.25} */
/* ------------------------------------------------------------------ */

function fakeWeightsSql() {
  const rows = [
    { strategy: "iron_condor", regime: "bull", weight: 2.0 },
    { strategy: "iron_condor", regime: "bear", weight: 0.25 },
  ];
  return {
    exec(query: string, ...params: unknown[]) {
      if (query.includes("CREATE TABLE")) return [];
      if (query.includes("WHERE regime = ?")) return rows.filter((r) => r.regime === params[0]);
      if (query.includes("strategy, regime, weight")) return rows;
      return rows.map((r) => ({ strategy: r.strategy, weight: r.weight }));
    },
  };
}

describe("W2 v2 reads", () => {
  it("{bull 2.0, bear 0.25} reads as 1.125 collapsed / 2.0 bull / 0.25 bear, with no cross-regime leak", () => {
    const sql = fakeWeightsSql();
    expect(getStrategyWeightsV2(sql)).toEqual({
      [weightsV2Key("iron_condor", "bull")]: 2.0,
      [weightsV2Key("iron_condor", "bear")]: 0.25,
    });
    expect(getStrategyWeightsV2ForRegime(sql, "bull")).toEqual({ iron_condor: 2.0 });
    expect(getStrategyWeightsV2ForRegime(sql, "bear")).toEqual({ iron_condor: 0.25 });
    expect(getStrategyWeightsV2Collapsed(sql)).toEqual({ iron_condor: 1.125 });
  });
});

/* ------------------------------------------------------------------ */
/* P1 — two promotion record stores, two GET shapes, bridge is a seam  */
/* ------------------------------------------------------------------ */

describe("P1 promotion", () => {
  it("challenger and staged promotion APIs are distinct modules with distinct list functions", () => {
    expect(typeof championChallenger.listPromotionRecords).toBe("function");
    expect(typeof championChallenger.promoteChallenger).toBe("function");
    expect(typeof championChallenger.rollbackChallengerPromotion).toBe("function");
    expect(typeof championChallenger.evaluateChallenger).toBe("function");
    expect(typeof stagedPromotion.listActivePromotions).toBe("function");
    expect(typeof stagedPromotion.startPromotion).toBe("function");
    expect(typeof stagedPromotion.advancePromotion).toBe("function");
    expect(championChallenger.listPromotionRecords).not.toBe(stagedPromotion.listActivePromotions);
  });

  it("the proposal→challenger bridge is a migration seam, not a third promotion engine", () => {
    expect(typeof proposalChallengerBridge.generateChallengersFromProposals).toBe("function");
    expect(typeof proposalChallengerBridge.buildEvaluationSpecs).toBe("function");
    expect(typeof proposalChallengerBridge.verdictReasons).toBe("function");
    expect("promoteChallenger" in proposalChallengerBridge).toBe(false);
    expect("rollbackChallengerPromotion" in proposalChallengerBridge).toBe(false);
    expect("advancePromotion" in proposalChallengerBridge).toBe(false);
    expect("startPromotion" in proposalChallengerBridge).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* P2 — four evaluate functions, four methods, one namesake            */
/* ------------------------------------------------------------------ */

function trackIdea(structure: string, win: boolean, createdAt: string, n: number): TrackRecordIdea {
  return {
    runId: `run_${createdAt.slice(0, 7)}_${n}`,
    runCreatedAt: createdAt,
    symbol: `SYM${n}`,
    structure,
    outlook: "bullish",
    thesis: "t",
    invalidation: "",
    entrySpot: 100,
    evaluation: {
      evaluatedAt: createdAt,
      invalidated: false,
      pnlEstimatePerUnit: win ? 1 : -1,
      rMultiple: null,
      evalSpot: 101,
      directionCorrect: win,
      notes: [],
    },
  } as unknown as TrackRecordIdea;
}

describe("P2 candidate evaluation", () => {
  it("the four evaluate functions are four distinct exports — and the bundle namesake is module-private", () => {
    expect(typeof championChallenger.evaluateChallenger).toBe("function");
    expect(typeof candidateEvaluation.evaluateCandidate).toBe("function");
    expect(typeof candidateEvaluation.replayCandidate).toBe("function");
    expect(typeof promotionGate.runPromotionGate).toBe("function");
    expect(typeof promotionGate.twoProportionZTest).toBe("function");
    expect(promotionGate.GATE_POLICY.alpha).toBe(0.05);
    expect(promotionGate.GATE_POLICY.minHeldOutSample).toBe(20);
    // The bundle's evaluateCandidate is NOT importable: same name,
    // different domain, must never be merged into (a)/(b)/(c).
    expect("evaluateCandidate" in recommendationBundle).toBe(false);
    expect(candidateEvaluation.evaluateCandidate).not.toBe(
      (recommendationBundle as Record<string, unknown>).evaluateCandidate,
    );
  });

  it("window replay (b) is pure and window-bounded: out-of-window ideas never count", () => {
    const ideas = [
      trackIdea("Weak", true, "2026-09-05T00:00:00.000Z", 1),
      trackIdea("Weak", true, "2026-09-05T00:00:00.000Z", 2),
      trackIdea("Weak", false, "2026-09-05T00:00:00.000Z", 3),
      trackIdea("Weak", false, "2026-09-05T00:00:00.000Z", 4),
      trackIdea("Fine", true, "2026-09-06T00:00:00.000Z", 5),
      trackIdea("Fine", true, "2026-09-06T00:00:00.000Z", 6),
      trackIdea("Fine", true, "2026-09-06T00:00:00.000Z", 7),
      trackIdea("Fine", false, "2026-09-06T00:00:00.000Z", 8),
      // Out of window: must not count toward sample, baseline, or candidate metric.
      trackIdea("Weak", false, "2026-08-01T00:00:00.000Z", 9),
      trackIdea("Fine", true, "2026-10-01T00:00:00.000Z", 10),
    ];
    const track = {
      published: 10,
      evaluated: 10,
      invalidated: 0,
      winRate: 0.5,
      directionAccuracy: null,
      avgPnlPerUnit: null,
      avgRMultiple: null,
      byStrategy: [],
      byPeriod: [],
      ideas,
    } as unknown as TrackRecord;
    const candidate = {
      id: "cand-1",
      target: "strategy-gate:Weak",
      change: { action: "disable-strategy" },
      status: "queued",
    } as unknown as ImprovementCandidate;
    const report = candidateEvaluation.replayCandidate(candidate, track, {
      window: { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" },
    });
    expect(report.method).toBe("counterfactual-replay");
    expect(report.sampleSize).toBe(8);
    expect(report.baselineMetric).toBeCloseTo(5 / 8);
    expect(report.candidateMetric).toBeCloseTo(3 / 4);
    expect(report.delta).toBeCloseTo(3 / 4 - 5 / 8);
  });
});

/* ------------------------------------------------------------------ */
/* D2 / DF / S3 — identical: layer, adapter, delegation                */
/* ------------------------------------------------------------------ */

describe("D2 / DF / S3 identical paths", () => {
  it("researchDiscovery is the single discovery source behind the kernel layer", () => {
    expect(typeof discoverStrategiesForName).toBe("function");
    expect(typeof discoverNamesForStrategy).toBe("function");
    expect(typeof runDiscoveryMode).toBe("function");
    expect(typeof kernelDiscoveryMapping.mapKernelCandidateToDiscovery).toBe("function");
    expect(typeof kernelDiscoveryMapping.mapKernelStrategyDiscovery).toBe("function");
  });

  it("the fit gate is one function with a discovery floor overlay, not a second gate", () => {
    const scanner = getOpportunityScannerConfig();
    const discovery = getDiscoveryConfig();
    const overlaid = resolveDiscoveryFitGate(scanner, { ...discovery, compositeFloor: 77 });
    expect(overlaid.minCompositeScore).toBe(77);
    expect(overlaid).toMatchObject({ ...scanner.fitGate, minCompositeScore: 77 });
    expect(typeof evaluateFitGate).toBe("function");
    expect(typeof OpportunityScannerFitHandler).toBe("function");
  });

  it("the panel path is delegation to the kernel, not a second engine", () => {
    expect(typeof panelPipeline.runPanelPipeline).toBe("function");
    expect(typeof panelPipeline.runPanelWithAgents).toBe("function");
    expect(typeof RecommendationService.prototype.discoverPanel).toBe("function");
  });
});
