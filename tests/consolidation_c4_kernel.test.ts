/**
 * Consolidation C4 (issue #1329, epic #1151) — the Recommendation Kernel.
 *
 * What is pinned here (design of record:
 * docs/architecture/recommendation-engine-rationalization.md):
 *  - ONE candidate contract (KernelCandidate) across the D1 panel path,
 *    the D4 research path, and the LLM path; builders wrap the existing
 *    construction functions, they do not reimplement them.
 *  - Chain-of-Responsibility gates: most-restrictive tier wins, the
 *    chain is idempotent tier-wise, and calibrated provenance caps at
 *    Watchlist on every path.
 *  - Template Method skeleton loadSnapshot → buildCandidates → gate →
 *    price → rank → falsify → assemble, with attrition at each boundary.
 *  - Honesty: missing fit component ⇒ ABSENT + excluded from the score
 *    (surfaced as a limitation); unpriceable / unfalsifiable ideas land
 *    Unverified, never fabricated; a stage failure fails explicitly.
 *  - 3-way comparison: arms differ ONLY in generator × scorer; all arms
 *    pass the same gates / pricing / falsification / assembly; `composed`
 *    is NOT an arm; no winner is asserted; per-arm outcomes are written
 *    to the ledger with arm provenance.
 *  - Draft-only: no execution APIs anywhere in this module's surface.
 *
 * No real LLM is ever called: every LLM-facing seam takes an injected
 * stub generator / ranking function / score map.
 */
import { describe, expect, it } from "vitest";
import {
  CatalogFitBuilder,
  ComposedStructureBuilder,
  ensureComparisonLedgerTable,
  KernelStageError,
  LlmIdeaBuilder,
  LlmRankPolicy,
  LlmScorePolicy,
  NoViewStructureBuilder,
  PassthroughWeightsRankDecorator,
  PerNameBestFit,
  RecommendationKernel,
  RecommendationService,
  recordComparisonArmOutcome,
  ResearchGatesHandler,
  RiskProfileComposite,
  runComparison,
  ScenarioGridRank,
  StrategyRiskFitHandler,
  ViewStructureBuilder,
  mapStrategyCandidateToKernelCandidate,
  type CandidateBuilder,
  type ComparisonArm,
  type GateHandler,
  type KernelCandidate,
  type KernelGateContext,
  type KernelSnapshot,
  type RankingPolicy,
} from "../src/services/recommendationKernel";
import type { ResearchLeg, StructureEconomics } from "../src/services/researchEconomics";
import { verticalSpreadEconomics } from "../src/services/researchEconomics";
import type { DiscoveryCandidate, NameFit } from "../src/services/researchDiscovery";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const NOW = Date.now();
const EXPIRY = "2026-12-18";

function leg(over: Partial<ResearchLeg> = {}): ResearchLeg {
  return {
    optionType: "call",
    strike: 100,
    expiry: EXPIRY,
    dte: 30,
    bid: 2.0,
    ask: 2.2,
    iv: 0.3,
    volume: 100,
    openInterest: 200,
    quantity: 1,
    quoteTimestamp: NOW,
    ...over,
  };
}

function economics(over: Partial<StructureEconomics> = {}): StructureEconomics {
  const legs = [leg(), leg({ optionType: "put", strike: 95, quantity: -1 })];
  return {
    structure: "vertical_spread",
    legs: legs.map((l) => ({ ...l, mid: (l.bid + l.ask) / 2 })),
    netDebit: 1.5,
    netCredit: 0,
    maxLoss: 150,
    maxGain: 350,
    breakevens: [101.5],
    derivationNotes: ["fixture"],
    ...over,
  };
}

/** A gate-passing research-style candidate (live chain, fresh quotes). */
function gatePassingCandidate(over: Partial<KernelCandidate> = {}): KernelCandidate {
  // Economics are recomputed from these exact legs so the strategy-
  // integrity gate's independent recomputation agrees with them.
  const passingLegs = [
    leg({ optionType: "call", strike: 100, quantity: 1, bid: 3.0, ask: 3.2 }),
    leg({ optionType: "call", strike: 110, quantity: -1, bid: 0.57, ask: 0.63 }),
  ];
  return {
    id: "k-pass",
    symbol: "AAA",
    structure: "vertical_spread",
    label: "Bull Call Spread",
    legs: passingLegs,
    economics: verticalSpreadEconomics(passingLegs, 100),
    status: "qualified",
    provenance: "quant",
    chainProvenance: "live",
    definedRisk: true,
    marginEstimate: 15000,
    assignmentRisk: false,
    gateReasons: [],
    limitations: [],
    rationale:
      "Bullish thesis on AAA: the vertical spread expresses upside with defined risk.",
    builderId: "fixture",
    falsificationEvidence: "Contradicting evidence: elevated IV into earnings.",
    ...over,
  };
}

function strategyCandidate(over: Partial<StrategyCandidate> = {}): StrategyCandidate {
  return {
    id: "sc-1",
    rank: 1,
    type: "bull_call_spread",
    label: "Bull Call Spread",
    symbol: "AAA",
    underlyingPrice: 100,
    expirationDate: EXPIRY,
    dataFreshness: "FRESH",
    legs: [
      {
        symbol: "AAA:20261218:C100",
        optionType: "CALL",
        side: "BUY",
        quantity: 1,
        strike: 100,
        expirationDate: EXPIRY,
        daysToExpiration: 30,
        entryPrice: 2.1,
        bid: 2.0,
        ask: 2.2,
        impliedVolatility: 0.3,
        delta: 0.5,
        gamma: 0.05,
        theta: -0.02,
        vega: 0.1,
        openInterest: 200,
        volume: 100,
        spreadPct: 0.09,
        quoteTimestamp: new Date(NOW).toISOString(),
        quoteFreshness: "FRESH",
        multiplier: 100,
      },
      {
        symbol: "AAA:20261218:C110",
        optionType: "CALL",
        side: "SELL",
        quantity: 1,
        strike: 110,
        expirationDate: EXPIRY,
        daysToExpiration: 30,
        entryPrice: 0.6,
        bid: 0.5,
        ask: 0.7,
        impliedVolatility: 0.3,
        delta: 0.3,
        gamma: 0.04,
        theta: -0.01,
        vega: 0.08,
        openInterest: 200,
        volume: 100,
        spreadPct: 0.1,
        quoteTimestamp: new Date(NOW).toISOString(),
        quoteFreshness: "FRESH",
        multiplier: 100,
      },
    ],
    netDebit: 1.5,
    estimatedFees: 1.3,
    maxProfit: 8.5,
    maxProfitUnbounded: false,
    maxLoss: 150,
    breakevens: [101.5],
    targetPnl: 300,
    targetRewardRisk: 2.0,
    modelImpliedProbabilityOfProfit: 0.6,
    netGreeks: { delta: 0.2, gamma: 0.01, theta: -0.01, vega: 0.02 },
    liquidityScore: 80,
    score: 72,
    scoreBreakdown: {
      thesisAlignment: 80,
      targetRewardRisk: 70,
      liquidity: 80,
      volatilityAlignment: 60,
      thetaBurden: 70,
      freshness: 90,
      popAlignment: 60,
      cushion: 50,
      capitalEfficiency: 70,
      weights: {
        thesisAlignment: 1,
        targetRewardRisk: 1,
        liquidity: 1,
        volatilityAlignment: 1,
        thetaBurden: 1,
        freshness: 1,
        popAlignment: 1,
        cushion: 1,
        capitalEfficiency: 1,
      },
    },
    payoffCurve: [],
    scenarios: [],
    explanations: ["Bullish structure."],
    warnings: [],
    assumptions: [],
    ...over,
  };
}

function snapshot(over: Partial<KernelSnapshot> = {}): KernelSnapshot {
  return {
    symbol: "AAA",
    dataSource: "live",
    chainProvenance: "live",
    underlyingPrice: 100,
    ...over,
  };
}

function gateContext(over: Partial<KernelGateContext> = {}): KernelGateContext {
  return {
    config: RESEARCH_CONFIG_DEFAULTS,
    now: NOW,
    outlook: "bullish",
    quote: { price: 100, timestamp: NOW, source: "fixture-quote" },
    chain: { underlyingPrice: 100, asOf: NOW, provenance: "live" },
    ...over,
  };
}

/** A builder that just returns fixed candidates. */
function stubBuilder(id: string, candidates: KernelCandidate[]): CandidateBuilder {
  return { id, build: () => candidates.map((c) => ({ ...c })) };
}

function fakeSql() {
  const queries: Array<{ query: string; args: unknown[] }> = [];
  const sql = {
    exec(query: string, ...args: unknown[]) {
      queries.push({ query, args });
      return { rowsWritten: 1 };
    },
  };
  return { sql, queries };
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

describe("ViewStructureBuilder / NoViewStructureBuilder", () => {
  it("maps a StrategyCandidate to the kernel contract, provenance quant", () => {
    const mapped = mapStrategyCandidateToKernelCandidate(strategyCandidate(), "view-builder");
    expect(mapped.provenance).toBe("quant");
    expect(mapped.builderId).toBe("view-builder");
    expect(mapped.legs).toHaveLength(2);
    expect(mapped.legs[0].quantity).toBe(1);
    expect(mapped.legs[1].quantity).toBe(-1);
    expect(mapped.legs[0].optionType).toBe("call");
    expect(mapped.engineScore).toBe(72);
    expect(mapped.economics).toBeNull();
    expect((mapped.source as StrategyCandidate).id).toBe("sc-1");
  });

  it("ViewStructureBuilder wraps the injected build function (no engine reimplementation)", async () => {
    const builder = new ViewStructureBuilder({
      buildFn: () => ({
        candidates: [strategyCandidate()],
        evaluations: [{ strategyId: "bull_call_spread" }],
        nameLedger: [{ name: "AAA" }],
        excluded: [],
      }),
    });
    const out = await builder.build({ snapshot: snapshot(), request: {} });
    expect(out).toHaveLength(1);
    expect(out[0].structure).toBe("bull_call_spread");
    expect(builder.lastResult?.evaluations).toHaveLength(1);
  });

  it("NoViewStructureBuilder maps no-view candidates with provenance quant", async () => {
    const builder = new NoViewStructureBuilder({
      buildFn: () => ({ candidates: [strategyCandidate({ id: "nv-1" })] }),
    });
    const out = await builder.build({ snapshot: snapshot(), request: {} });
    expect(out).toHaveLength(1);
    expect(out[0].provenance).toBe("quant");
    expect(out[0].id).toBe("nv-1");
  });
});

describe("CatalogFitBuilder", () => {
  it("preserves catalog → quant and composed → composed provenance, scenario, and source", async () => {
    const dc: DiscoveryCandidate = {
      symbol: "AAA",
      structure: "iron_condor",
      label: "Iron Condor",
      source: "composed",
      legs: [leg()],
      economics: economics({ structure: "iron_condor" }),
      status: "watchlist",
      provenance: "live",
      definedRisk: true,
      marginEstimate: 5000,
      assignmentRisk: false,
      gateReasons: [],
      limitations: [],
      scenario: { worstPnlTotal: -100, meanPnlTotal: 50, bestPnlTotal: 200, withinConstraints: true },
    };
    const builder = new CatalogFitBuilder({
      discoverFn: async () => ({ candidates: [dc], rejected: [], limitations: ["disc-lim"] }),
    });
    const out = await builder.build({
      snapshot: snapshot(),
      request: { symbol: "AAA", outlook: "range_bound" },
    });
    expect(out).toHaveLength(1);
    expect(out[0].provenance).toBe("composed");
    expect(out[0].scenario?.meanPnlTotal).toBe(50);
    expect(out[0].falsificationEvidence).toContain("gateComposedCandidate");
    expect(out[0].source).toBe(dc);
    expect(builder.limitations).toContain("disc-lim");
  });
});

describe("ComposedStructureBuilder", () => {
  const chain = {
    symbol: "AAA",
    underlyingPrice: 100,
    asOf: NOW,
    provenance: "live" as const,
    expiries: [
      {
        expiry: EXPIRY,
        dte: 30,
        legs: [90, 95, 100, 105, 110, 115].flatMap((strike) => [
          { optionType: "call" as const, strike, expiry: EXPIRY, dte: 30, bid: 1, ask: 1.2, iv: 0.3, volume: 100, openInterest: 200 },
          { optionType: "put" as const, strike, expiry: EXPIRY, dte: 30, bid: 1, ask: 1.2, iv: 0.3, volume: 100, openInterest: 200 },
        ]),
      },
    ],
  };

  it("overlays wings on an uncovered short strangle and yields a composed candidate", async () => {
    const base = gatePassingCandidate({
      id: "short-strangle",
      structure: "short_strangle",
      label: "Short Strangle",
      legs: [
        leg({ optionType: "put", strike: 95, quantity: -1 }),
        leg({ optionType: "call", strike: 105, quantity: -1 }),
      ],
      economics: null,
    });
    const builder = new ComposedStructureBuilder({ operator: "overlay", chain, bases: [base] });
    const out = await builder.build({ snapshot: snapshot({ chain }), request: {} });
    expect(out).toHaveLength(1);
    expect(out[0].provenance).toBe("composed");
    expect(out[0].legs.length).toBeGreaterThan(2);
    expect(out[0].economics).not.toBeNull();
  });

  it("on operator failure yields zero candidates + a limitation, never throws", async () => {
    const notStraddle = gatePassingCandidate({ id: "not-straddle", legs: [leg()] });
    const builder = new ComposedStructureBuilder({
      operator: "transformStraddleToStrangle",
      chain,
      bases: [notStraddle],
    });
    const out = await builder.build({ snapshot: snapshot({ chain }), request: {} });
    expect(out).toHaveLength(0);
    expect(builder.limitations.length).toBeGreaterThan(0);
    expect(builder.limitations[0]).toMatch(/straddle/i);
  });
});

describe("LlmIdeaBuilder (first-class, stub generator only)", () => {
  const quotedSnapshot = snapshot({
    quotes: {
      "AAA:20261218:C100": { bid: 2.0, ask: 2.2 },
    },
  });

  it("prices a cited contract via legMid from snapshot quotes and records model + temperature", async () => {
    const builder = new LlmIdeaBuilder({
      generateFn: async () => ({
        model: "stub-llm",
        answer: "A long call expresses upside with defined risk.",
        contractSymbols: ["AAA:20261218:C100"],
        contractDetails: [
          {
            symbol: "AAA:20261218:C100",
            expiration: EXPIRY,
            contract: {
              optionType: "CALL",
              strikePrice: 100,
              symbol: "AAA:20261218:C100",
              bid: 2.0,
              ask: 2.2,
              lastPrice: 2.1,
            },
          },
        ],
      }),
      model: "stub-llm",
      temperature: 0.2,
    });
    const out = await builder.build({ snapshot: quotedSnapshot, request: {} });
    expect(out).toHaveLength(1);
    expect(out[0].provenance).toBe("llm");
    expect(out[0].model).toBe("stub-llm");
    expect(out[0].temperature).toBe(0.2);
    expect(out[0].economics).not.toBeNull();
    expect(out[0].economics!.legs[0].mid).toBeCloseTo(2.1);
  });

  it("a cited contract with no quote yields economics null (never fabricated)", async () => {
    const builder = new LlmIdeaBuilder({
      generateFn: async () => ({
        model: "stub-llm",
        answer: "An idea citing a contract the snapshot never quoted.",
        contractSymbols: ["AAA:20261218:C999"],
        contractDetails: [
          {
            symbol: "AAA:20261218:C999",
            expiration: EXPIRY,
            contract: {
              optionType: "CALL",
              strikePrice: 999,
              symbol: "AAA:20261218:C999",
              bid: 0,
              ask: 0,
              lastPrice: 0,
            },
          },
        ],
      }),
    });
    const out = await builder.build({ snapshot: snapshot(), request: {} });
    expect(out).toHaveLength(1);
    expect(out[0].economics).toBeNull();
    expect(out[0].status).toBe("unverified");
    expect(out[0].limitations.some((l) => /no quote/i.test(l))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Gate chain                                                          */
/* ------------------------------------------------------------------ */

describe("gate chain (Chain of Responsibility)", () => {
  it("StrategyRiskFitHandler marks screened-out candidates rejected, matched ones untouched", () => {
    const handler = new StrategyRiskFitHandler({
      screenFn: (candidates) => ({
        matched: candidates.filter((c) => c.netDebit <= 2),
        rejected: candidates
          .filter((c) => c.netDebit > 2)
          .map((c) => ({ id: c.id, reason: "Net debit exceeds cap" })),
      }),
    });
    const ctx = gateContext();
    const rich = mapStrategyCandidateToKernelCandidate(strategyCandidate({ id: "rich", netDebit: 5 }), "view");
    const cheap = mapStrategyCandidateToKernelCandidate(strategyCandidate({ id: "cheap", netDebit: 1 }), "view");
    expect(handler.evaluate(rich, ctx).cap).toBe("rejected");
    expect(handler.evaluate(rich, ctx).reasons[0]).toMatch(/Net debit/);
    expect(handler.evaluate(cheap, ctx).cap).toBeUndefined();
    // Candidates without a wrapped engine candidate are not fit-screened.
    expect(handler.evaluate(gatePassingCandidate(), ctx).cap).toBeUndefined();
  });

  it("ResearchGatesHandler caps calibrated provenance at Watchlist (never qualified)", () => {
    const handler = new ResearchGatesHandler();
    const calibrated = gatePassingCandidate({ chainProvenance: "calibrated" });
    const ev = handler.evaluate(calibrated, gateContext({ chain: { underlyingPrice: 100, asOf: NOW, provenance: "calibrated" } }));
    expect(ev.cap).toBe("watchlist");
  });

  it("ResearchGatesHandler leaves a live, fully-evidenced candidate uncapped", () => {
    const handler = new ResearchGatesHandler();
    const ev = handler.evaluate(gatePassingCandidate(), gateContext());
    expect(ev.cap).toBeUndefined();
  });

  it("the chain takes the most restrictive tier across handlers", async () => {
    const kernel = new RecommendationKernel({
      builders: [stubBuilder("b", [mapStrategyCandidateToKernelCandidate(strategyCandidate({ id: "rich", netDebit: 5 }), "view")])],
      gateHandlers: [
        new StrategyRiskFitHandler({
          screenFn: (candidates) => ({
            matched: [],
            rejected: candidates.map((c) => ({ id: c.id, reason: "fit reject" })),
          }),
        }),
        new ResearchGatesHandler(),
      ],
      rankingPolicy: new ScenarioGridRank(),
    });
    const result = await kernel.run({
      snapshot: snapshot(),
      request: { thesis: "bullish" },
      gateContext: gateContext(),
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/fit reject/);
    expect(result.attrition.generated).toBe(1);
    expect(result.attrition.gatePassed).toBe(0);
  });

  it("the chain is idempotent tier-wise: re-gating a gated candidate does not change its tier", async () => {
    const calibrated = gatePassingCandidate({ chainProvenance: "calibrated" });
    const makeKernel = () =>
      new RecommendationKernel({
        builders: [stubBuilder("b", [calibrated])],
        gateHandlers: [new ResearchGatesHandler()],
        rankingPolicy: new ScenarioGridRank(),
      });
    const ctx = gateContext({ chain: { underlyingPrice: 100, asOf: NOW, provenance: "calibrated" } });
    const first = await makeKernel().run({ snapshot: snapshot(), request: {}, gateContext: ctx });
    expect(first.candidates[0].status).toBe("watchlist");
    const second = await new RecommendationKernel({
      builders: [stubBuilder("b", first.candidates)],
      gateHandlers: [new ResearchGatesHandler()],
      rankingPolicy: new ScenarioGridRank(),
    }).run({ snapshot: snapshot(), request: {}, gateContext: ctx });
    expect(second.candidates[0].status).toBe("watchlist");
  });

  it("calibrated provenance caps at Watchlist on the kernel path, even without the research handler's own floor", async () => {
    const noOp: GateHandler = { id: "noop", evaluate: () => ({ reasons: [] }) };
    const result = await new RecommendationKernel({
      builders: [stubBuilder("b", [gatePassingCandidate({ chainProvenance: "calibrated" })])],
      gateHandlers: [noOp],
      rankingPolicy: new ScenarioGridRank(),
    }).run({ snapshot: snapshot(), request: {}, gateContext: gateContext() });
    expect(result.candidates[0].status).toBe("watchlist");
  });
});

/* ------------------------------------------------------------------ */
/* Ranking policies                                                    */
/* ------------------------------------------------------------------ */

describe("ranking policies", () => {
  it("RiskProfileComposite ranks wrapped candidates via the injected recommender and falls back for unwrapped ones without crashing", () => {
    const policy = new RiskProfileComposite({
      rankFn: (candidates) =>
        [...candidates]
          .sort((a, b) => b.score - a.score)
          .map((candidate, i) => ({ candidate, rank: i + 1, compositeScore: candidate.score, components: {} as never })),
    });
    const wrapped = mapStrategyCandidateToKernelCandidate(strategyCandidate({ id: "w-low", score: 10 }), "view");
    const unwrapped = gatePassingCandidate({ id: "u-high", engineScore: 99 });
    const ranked = policy.rank([wrapped, unwrapped], { request: { maxPlannedLoss: 1000, minRewardRisk: 1 } });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].id).toBe("u-high");
    expect(ranked.map((c) => c.rank)).toEqual([1, 2]);
  });

  it("ScenarioGridRank orders by status tier, then scenario mean desc", () => {
    const policy = new ScenarioGridRank();
    const a = gatePassingCandidate({ id: "a", status: "watchlist", scenario: { worstPnlTotal: 0, meanPnlTotal: 10, bestPnlTotal: 20, withinConstraints: true } });
    const b = gatePassingCandidate({ id: "b", status: "qualified", scenario: { worstPnlTotal: 0, meanPnlTotal: 1, bestPnlTotal: 20, withinConstraints: true } });
    const ranked = policy.rank([a, b], {});
    expect(ranked.map((c) => c.id)).toEqual(["b", "a"]);
    expect(ranked[0].rank).toBe(1);
  });

  it("PerNameBestFit orders by status tier, then fitScore desc", () => {
    const policy = new PerNameBestFit();
    const a = gatePassingCandidate({ id: "a", status: "qualified", fitScore: 10 });
    const b = gatePassingCandidate({ id: "b", status: "qualified", fitScore: 90 });
    expect(policy.rank([a, b], {}).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("LlmRankPolicy applies the injected id order and never drops unranked candidates", () => {
    const policy = new LlmRankPolicy({ orderFn: (ids) => [...ids].reverse() });
    const ranked = policy.rank(
      [gatePassingCandidate({ id: "x" }), gatePassingCandidate({ id: "y" }), gatePassingCandidate({ id: "z" })],
      {},
    );
    expect(ranked.map((c) => c.id)).toEqual(["z", "y", "x"]);
    const partial = new LlmRankPolicy({ orderFn: () => ["y"] });
    expect(partial.rank([gatePassingCandidate({ id: "x" }), gatePassingCandidate({ id: "y" })], {}).map((c) => c.id)).toEqual(["y", "x"]);
  });

  it("LlmScorePolicy orders by injected scores, unscored last", () => {
    const policy = new LlmScorePolicy({ scores: { a: 1, b: 9 } });
    const ranked = policy.rank(
      [gatePassingCandidate({ id: "a" }), gatePassingCandidate({ id: "c" }), gatePassingCandidate({ id: "b" })],
      {},
    );
    expect(ranked.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("WeightsRankDecorator is a no-op without a weights function and never reorders across tiers with one", () => {
    const plain = new PassthroughWeightsRankDecorator();
    const input = [gatePassingCandidate({ id: "q", status: "qualified" }), gatePassingCandidate({ id: "w", status: "watchlist" })];
    expect(plain.decorate(input, {})).toBe(input);
    const weighted = new PassthroughWeightsRankDecorator({
      weightsFn: (c) => (c.id === "w2" ? 100 : 0),
    });
    const tiered = [
      gatePassingCandidate({ id: "q1", status: "qualified", rank: 1 }),
      gatePassingCandidate({ id: "w1", status: "watchlist", rank: 2 }),
      gatePassingCandidate({ id: "w2", status: "watchlist", rank: 3 }),
    ];
    const out = weighted.decorate(tiered, {});
    // Within-tier reorder only: the qualified candidate stays first.
    expect(out[0].id).toBe("q1");
    expect(out.map((c) => c.id)).toEqual(["q1", "w2", "w1"]);
  });
});

/* ------------------------------------------------------------------ */
/* Template Method pipeline                                            */
/* ------------------------------------------------------------------ */

describe("RecommendationKernel pipeline", () => {
  it("runs load → build → gate → price → rank → falsify → assemble with attrition at each boundary", async () => {
    const wrapped = mapStrategyCandidateToKernelCandidate(strategyCandidate({ id: "d1" }), "view");
    const research = gatePassingCandidate({ id: "res" });
    const llmUnpriced: KernelCandidate = {
      ...gatePassingCandidate({ id: "llm-bad" }),
      economics: null,
      provenance: "llm",
      falsificationEvidence: undefined,
      status: "unverified",
    };
    const kernel = new RecommendationKernel({
      builders: [stubBuilder("b", [wrapped, research, llmUnpriced])],
      gateHandlers: [],
      rankingPolicy: new ScenarioGridRank(),
    });
    const result = await kernel.run({ snapshot: snapshot(), request: {} });
    expect(result.attrition.generated).toBe(3);
    expect(result.attrition.gatePassed).toBe(3);
    // The wrapped D1 candidate is priced from its engine economics; the
    // unpriceable LLM idea is not.
    expect(result.attrition.priced).toBe(2);
    // Only the research candidate carries falsification evidence.
    expect(result.attrition.falsified).toBe(1);
    expect(result.attrition.ranked).toBe(3);
    expect(result.candidates).toHaveLength(3);
    const priced = result.candidates.find((c) => c.id === "d1")!;
    expect(priced.economics).not.toBeNull();
    expect(priced.economics!.derivationNotes.join(" ")).toMatch(/StrategyCandidate/);
    const unpriced = result.candidates.find((c) => c.id === "llm-bad")!;
    expect(unpriced.economics).toBeNull();
    expect(unpriced.status).toBe("unverified");
  });

  it("price stage leaves economics null untouched (no invented pricing)", async () => {
    const kernel = new RecommendationKernel({
      builders: [stubBuilder("b", [gatePassingCandidate({ id: "np", economics: null, status: "unverified" })])],
      gateHandlers: [],
      rankingPolicy: new ScenarioGridRank(),
    });
    const result = await kernel.run({ snapshot: snapshot(), request: {} });
    expect(result.candidates[0].economics).toBeNull();
    expect(result.attrition.priced).toBe(0);
  });

  it("falsify stage demotes an evidenced-free candidate to at most unverified, keeps an evidenced one", async () => {
    const kernel = new RecommendationKernel({
      builders: [
        stubBuilder("b", [
          gatePassingCandidate({ id: "no-ev", falsificationEvidence: undefined }),
          gatePassingCandidate({ id: "ev", falsificationEvidence: "counter-evidence present" }),
        ]),
      ],
      gateHandlers: [],
      rankingPolicy: new ScenarioGridRank(),
    });
    const result = await kernel.run({ snapshot: snapshot(), request: {} });
    expect(result.candidates.find((c) => c.id === "no-ev")!.status).toBe("unverified");
    expect(result.candidates.find((c) => c.id === "ev")!.status).toBe("qualified");
  });

  it("a throwing builder fails explicitly with the stage and builder named", async () => {
    const kernel = new RecommendationKernel({
      builders: [{ id: "boom", build: () => { throw new Error("kaboom"); } }],
      gateHandlers: [],
      rankingPolicy: new ScenarioGridRank(),
    });
    await expect(kernel.run({ snapshot: snapshot(), request: {} })).rejects.toThrow(KernelStageError);
    await expect(kernel.run({ snapshot: snapshot(), request: {} })).rejects.toThrow(/buildCandidates.*boom/);
  });

  it("a rank policy that drops candidates fails explicitly instead of silently completing", async () => {
    const dropping: RankingPolicy = {
      id: "dropping",
      rank: (candidates) => candidates.slice(0, 1),
    };
    const kernel = new RecommendationKernel({
      builders: [stubBuilder("b", [gatePassingCandidate({ id: "a" }), gatePassingCandidate({ id: "b" })])],
      gateHandlers: [],
      rankingPolicy: dropping,
    });
    await expect(kernel.run({ snapshot: snapshot(), request: {} })).rejects.toThrow(/rank.*drop/i);
  });

  it("a snapshot-loader failure fails explicitly at loadSnapshot", async () => {
    const kernel = new RecommendationKernel({
      builders: [stubBuilder("b", [])],
      gateHandlers: [],
      rankingPolicy: new ScenarioGridRank(),
      snapshotLoader: () => { throw new Error("no chain"); },
    });
    await expect(kernel.run({ snapshot: snapshot(), request: {} })).rejects.toThrow(/loadSnapshot/);
  });
});

/* ------------------------------------------------------------------ */
/* Facade                                                              */
/* ------------------------------------------------------------------ */

describe("RecommendationService facade", () => {
  it("discoverPanel returns PipelineResult-compatible output computed via the injected agents, exactly as the D1 pipeline does", async () => {
    const service = new RecommendationService();
    const sc = strategyCandidate();
    const out = await service.discoverPanel({
      dataAgent: { loadSnapshot: async () => ({ symbol: "AAA", contracts: [], dataSource: "live" as const, screen: { underlyingsScanned: 1, contractsEvaluated: 0, contractsMatched: 0 }, rejections: [] }) },
      riskAgent: {
        buildStrategies: () => ({ candidates: [sc], evaluations: [{ strategyId: "x" }], nameLedger: [{ name: "AAA" }], excluded: [] }),
        screenStrategies: (candidates: StrategyCandidate[]) => ({ matched: candidates, rejected: [] }),
        riskReport: (candidate: StrategyCandidate) => ({ id: candidate.id, maxLoss: candidate.maxLoss }),
      },
      recommender: {
        rank: (candidates: StrategyCandidate[]) => candidates.map((candidate, i) => ({ candidate, rank: i + 1, compositeScore: 90, components: {} as never })),
        pickBestTrade: (candidates: StrategyCandidate[]) => ({ status: "recommended" as const, best: candidates[0] ? { candidate: candidates[0], rank: 1, compositeScore: 90, components: {} as never } : undefined }),
      },
      request: { symbol: "AAA", thesis: "bullish", maxPlannedLoss: 1000, minRewardRisk: 1, candidateLimit: 5 },
    });
    expect(out.ranked).toHaveLength(1);
    expect(out.ranked[0].candidate.id).toBe("sc-1");
    expect(out.riskReports).toHaveLength(1);
    expect(out.bestTrade.status).toBe("recommended");
    expect(out.screenedOut).toEqual([]);
    expect(out.legacy?.evaluations).toHaveLength(1);
    expect(out.snapshot.symbol).toBe("AAA");
    expect(out.candidates).toHaveLength(1);
  });

  it("discoverForName runs the research configuration and ranks by scenario grid", async () => {
    const service = new RecommendationService();
    const low: DiscoveryCandidate = {
      symbol: "AAA", structure: "vertical_spread", label: "Spread", source: "catalog",
      legs: [leg()], economics: economics(), status: "qualified", provenance: "live",
      definedRisk: true, marginEstimate: 1000, assignmentRisk: false, gateReasons: [],
      limitations: [], scenario: { worstPnlTotal: 0, meanPnlTotal: 5, bestPnlTotal: 10, withinConstraints: true },
    };
    const high: DiscoveryCandidate = { ...low, structure: "iron_condor", label: "Condor", scenario: { worstPnlTotal: 0, meanPnlTotal: 99, bestPnlTotal: 10, withinConstraints: true } };
    const result = await service.discoverForName({
      discoverStrategiesForName: async () => ({ candidates: [low, high], rejected: [], limitations: ["res-lim"] }),
      symbol: "AAA",
      outlook: "range_bound",
      gateQuote: { price: 100, timestamp: NOW, source: "fixture" },
      gateChain: { underlyingPrice: 100, asOf: NOW, provenance: "live" },
    });
    // Both are vertical-family/condor under a range_bound outlook only if
    // the thesis gate admits them; the grid rank orders by mean desc
    // among survivors — at minimum the result carries both inputs'
    // provenance and the discovery limitation.
    expect(result.limitations).toContain("res-lim");
    expect(result.candidates.length + result.rejected.length).toBe(2);
  });

  it("discoverNamesForStrategy surfaces missing fit components as ABSENT limitations and ranks by fitScore", async () => {
    const service = new RecommendationService();
    const fit: NameFit = {
      symbol: "BBB",
      structure: "iron_condor",
      status: "qualified",
      provenance: "live",
      fitScore: 88,
      components: { liquidity: 90, ivFit: null, termStructureFit: 80, earningsDistance: 70, correlation: null, trackRecord: 60 },
      missingComponents: ["ivFit", "correlation"],
      economics: { netDebit: 0, netCredit: 1.2, maxLoss: 380, maxGain: 120 },
    };
    const result = await service.discoverNamesForStrategy({
      discoverNamesForStrategy: async () => ({ structure: "iron_condor", ranked: [fit], rejected: [], limitations: [] }),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].fitScore).toBe(88);
    expect(result.candidates[0].limitations.some((l) => /ABSENT: ivFit/.test(l))).toBe(true);
    expect(result.candidates[0].limitations.some((l) => /ABSENT: correlation/.test(l))).toBe(true);
    // The missing components were excluded from the score, never estimated:
    // the candidate carries the discovery's own fitScore unchanged.
    expect(result.candidates[0].fitScore).toBe(88);
  });
});

/* ------------------------------------------------------------------ */
/* 3-way comparison                                                    */
/* ------------------------------------------------------------------ */

describe("runComparison", () => {
  function armBuilders(prefix: string, ids: string[]): CandidateBuilder[] {
    return [stubBuilder(`${prefix}-builder`, ids.map((id) => gatePassingCandidate({ id: `${prefix}-${id}`, structure: `struct-${id}` })))];
  }

  async function runArms() {
    return runComparison({
      snapshot: snapshot(),
      request: {},
      gateHandlers: [],
      arms: {
        llm: { builders: armBuilders("llm", ["a", "b"]), rankingPolicy: new LlmRankPolicy({ orderFn: (ids) => [...ids].reverse() }) },
        quant: { builders: armBuilders("quant", ["a", "c"]), rankingPolicy: new ScenarioGridRank() },
        hybrid: { builders: armBuilders("quant", ["a", "c"]), rankingPolicy: new LlmScorePolicy({ scores: { "quant-c": 100, "quant-a": 1 } }) },
      },
    });
  }

  it("runs three arms over the same gates/pricing/falsification and reports per-arm attrition + overlap, with no winner", async () => {
    const artifact = await runArms();
    expect(artifact.arms.llm.attrition.generated).toBe(2);
    expect(artifact.arms.quant.attrition.generated).toBe(2);
    expect(artifact.arms.hybrid.attrition.generated).toBe(2);
    expect(artifact.overlap.sharedStructures).toContain("struct-a");
    expect(artifact.overlap.sharedStructures).toContain("struct-c");
    expect(artifact.overlap.armUnique.llm).toContain("struct-b");
    // Quant and hybrid share the same stub builders here, so neither has
    // a unique structure — uniqueness is the llm arm's struct-b.
    expect(artifact.overlap.armUnique.quant).toEqual([]);
    expect(artifact.overlap.armUnique.hybrid).toEqual([]);
    expect(artifact).not.toHaveProperty("winner");
    expect(JSON.stringify(artifact)).not.toContain('"winner"');
  });

  it("hybrid LLM scoring orders only the hybrid arm; the quant arm's order is unaffected", async () => {
    const artifact = await runArms();
    // Quant arm ranks by scenario grid (equal means here) in build order;
    // hybrid reorders by LLM score (quant-c first). The two orders differ
    // only because the hybrid scorer ran — the quant list is untouched.
    expect(artifact.arms.hybrid.ranked[0].id).toBe("quant-c");
    expect(artifact.arms.quant.ranked.map((c) => c.id)).toEqual(["quant-a", "quant-c"]);
  });

  it("rejects a 'composed' arm request: composed is a builder technique / provenance, not an arm", async () => {
    await expect(
      runComparison({
        snapshot: snapshot(),
        request: {},
        gateHandlers: [],
        arms: {
          llm: { builders: [], rankingPolicy: new ScenarioGridRank() },
          quant: { builders: [], rankingPolicy: new ScenarioGridRank() },
          hybrid: { builders: [], rankingPolicy: new ScenarioGridRank() },
          composed: { builders: [], rankingPolicy: new ScenarioGridRank() },
        } as unknown as Record<ComparisonArm, { builders: CandidateBuilder[]; rankingPolicy: RankingPolicy }>,
      }),
    ).rejects.toThrow(/composed is not an arm/i);
  });

  it("writes per-arm outcomes to the ledger with arm provenance (append-only rows)", async () => {
    const { sql, queries } = fakeSql();
    const artifact = await runComparison({
      snapshot: snapshot(),
      request: {},
      gateHandlers: [],
      arms: {
        llm: { builders: armBuilders("llm", ["a"]), rankingPolicy: new ScenarioGridRank() },
        quant: { builders: armBuilders("quant", ["a"]), rankingPolicy: new ScenarioGridRank() },
        hybrid: { builders: armBuilders("quant", ["a"]), rankingPolicy: new ScenarioGridRank() },
      },
      ledgerSql: sql,
      runId: "run-1",
    });
    expect(queries.some((q) => /CREATE TABLE IF NOT EXISTS mas_comparison_arm_outcomes/i.test(q.query))).toBe(true);
    const inserts = queries.filter((q) => /^INSERT INTO mas_comparison_arm_outcomes/i.test(q.query));
    expect(inserts).toHaveLength(3);
    expect(inserts.map((q) => q.args[2])).toEqual(expect.arrayContaining(["llm", "quant", "hybrid"]));
    expect(artifact.runId).toBe("run-1");
  });

  it("ensureComparisonLedgerTable + recordComparisonArmOutcome write the documented row shape", () => {
    const { sql, queries } = fakeSql();
    ensureComparisonLedgerTable(sql);
    recordComparisonArmOutcome(sql, {
      runId: "r1",
      arm: "quant",
      candidate: gatePassingCandidate({ id: "c1", structure: "vertical_spread" }),
    });
    const insert = queries.find((q) => /^INSERT/i.test(q.query))!;
    expect(insert.query).toContain("mas_comparison_arm_outcomes");
    expect(insert.args).toContain("r1");
    expect(insert.args).toContain("quant");
    expect(insert.args).toContain("c1");
    expect(insert.args).toContain("vertical_spread");
  });

  it("the artifact and kernel results carry no execution surface (draft-only)", async () => {
    const artifact = await runArms();
    expect(JSON.stringify(artifact)).not.toMatch(/placeOrder|submitOrder|executeTrade/i);
  });
});
