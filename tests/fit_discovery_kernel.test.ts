/**
 * #1256 remainder — NLQ fit rewire to the kernel research entries.
 *
 * Name direction (name_to_strategies) runs through the kernel facade
 * (RecommendationService.discoverForName, gate evidence from the same
 * provider session) and maps back to DiscoveryModeResult via
 * kernelDiscoveryMapping. Strategy direction (strategy_to_names)
 * runs through the kernel facade too (RecommendationService
 * .discoverNamesForStrategy, #1256): the discovery itself attaches
 * genuine falsification evidence to each ranked fit (gate verdict +
 * live chain/quote session + fit components), so falsify keeps
 * qualified/watchlist tiers honestly; evidence-less fits still
 * demote, per the invariant (see the falsification block below).
 *
 * Order divergence, enumerated (not silent): the discovery orders
 * name candidates by tier, then scenario WORST desc, then mean desc;
 * the kernel's ScenarioGridRank orders by tier, then scenario MEAN
 * desc. On this fixture the two orders coincide; when worst and mean
 * disagree, the kernel order wins (the kernel's ranking policy is
 * the governed one). The policy-difference test below pins that the
 * policies CAN differ, so the divergence is characterized, not
 * discovered by users.
 */
import { describe, expect, it, vi } from "vitest";
import { runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { createFitDiscoveryRunner } from "../src/services/fitDiscoveryRunner";
import {
  runDiscoveryMode,
  type DiscoveryCandidate,
} from "../src/services/researchDiscovery";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import type { ChainSnapshot, ProviderChainLeg, ResearchDataProvider } from "../src/services/researchPipeline";
import {
  RecommendationService,
  ScenarioGridRank,
  PerNameBestFit,
  type KernelCandidate,
} from "../src/services/recommendationKernel";

// Fixture "now" is the test run's clock: the kernel's data-integrity
// gate rejects future quote timestamps, so a fixed calendar date
// would demote every fixture candidate to unverified regardless of
// the rewire. Leg DTEs are explicit, so expiry dates stay fixed.
const NOW = Date.now();
const EXP1 = "2026-12-18";
const EXP2 = "2027-01-15";
const EXP3 = "2027-06-18";
const STRIKES = [75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125];

function chainLeg(optionType: "call" | "put", strike: number, expiry: string, dte: number, mid: number): ProviderChainLeg {
  return { optionType, strike, expiry, dte, bid: Number((mid * 0.98).toFixed(2)), ask: Number((mid * 1.02).toFixed(2)), iv: 0.4, volume: 200, openInterest: 1000 };
}
function makeChain(symbol: string): ChainSnapshot {
  const expiries = [
    { expiry: EXP1, dte: 35 },
    { expiry: EXP2, dte: 63 },
    { expiry: EXP3, dte: 228 },
  ].map(({ expiry, dte }) => {
    const legs: ProviderChainLeg[] = [];
    for (const strike of STRIKES) {
      const mid = Math.max(0.4, 9 - Math.abs(strike - 100) * 0.18);
      legs.push(chainLeg("call", strike, expiry, dte, mid));
      legs.push(chainLeg("put", strike, expiry, dte, mid));
    }
    return { expiry, dte, legs };
  });
  return { symbol, underlyingPrice: 100, asOf: NOW, provenance: "live", expiries };
}
function makeProvider(chains: Record<string, ChainSnapshot>): ResearchDataProvider {
  return {
    async getUniverseSymbols() { return Object.keys(chains); },
    async getQuote(symbol: string) { return chains[symbol] ? { symbol, price: 100, timestamp: NOW, quoteStatus: "live", source: "fixture:quote" } : null; },
    async getChain(symbol: string) { return chains[symbol] ?? { symbol, underlyingPrice: 100, asOf: NOW, provenance: "unavailable" as const, expiries: [] }; },
    async getTechnicals() { return { trend: "flat" as const, momentum: 0, notes: [] }; },
    async getCatalysts() { return null; },
    async getRegime() { return { regime: "chop" as const, notes: [], asOf: NOW }; },
  };
}

const NAME_REQUEST = { direction: "name_to_strategies", symbol: "AAA", outlook: "range_bound" } as const;
const STRATEGY_REQUEST = { direction: "strategy_to_names", structure: "iron_condor", outlook: "range_bound", symbols: ["AAA"] } as const;

describe("NLQ fit through the kernel (#1256)", () => {
  it("name direction routes through the kernel facade (discoverForName)", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const spy = vi.spyOn(RecommendationService.prototype, "discoverForName");
    try {
      const outcome = await createFitDiscoveryRunner({ provider, userLogin: "test" }).run(NAME_REQUEST);
      expect(outcome.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("name direction preserves the direct discovery's tiers and candidate set", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const oldOut = await runDiscoveryMode({ provider }, RESEARCH_CONFIG_DEFAULTS, NAME_REQUEST);
    const newOut = await createFitDiscoveryRunner({ provider, userLogin: "test" }).run(NAME_REQUEST);
    expect(newOut.ok).toBe(true);
    if (oldOut.direction !== "name_to_strategies" || !newOut.result || newOut.result.direction !== "name_to_strategies") {
      throw new Error("direction mismatch in fixture");
    }
    const oldTiers = new Map(oldOut.result.candidates.map((c) => [`${c.structure}:${c.source}`, c.status]));
    const newTiers = new Map(newOut.result.result.candidates.map((c) => [`${c.structure}:${c.source}`, c.status]));
    expect([...newTiers.entries()].sort()).toEqual([...oldTiers.entries()].sort());
    expect(newOut.result.result.rejected).toEqual(oldOut.result.rejected);
  });

  it("kernel order (ScenarioGridRank: tier, mean desc) is the runner's order on a worst/mean disagreement", () => {
    // Hand-built disagreement case: A has the better worst cell, B the
    // better mean cell. The discovery's worst-first order puts A first;
    // the kernel's mean-first order puts B first. This pins the
    // enumerated divergence: the kernel order wins after the rewire.
    const mk = (id: string, worst: number, mean: number): KernelCandidate =>
      ({
        id,
        symbol: "AAA",
        structure: id,
        label: id,
        legs: [],
        economics: {},
        status: "qualified",
        provenance: "quant",
        chainProvenance: "live",
        definedRisk: true,
        marginEstimate: null,
        assignmentRisk: false,
        gateReasons: [],
        limitations: [],
        rationale: "",
        builderId: "test",
        scenario: { worstPnlTotal: worst, meanPnlTotal: mean, bestPnlTotal: mean, withinConstraints: true },
      }) as KernelCandidate;
    const a = mk("a", 100, 110);
    const b = mk("b", 0, 300);
    const STATUS_RANK: Record<string, number> = { qualified: 0, watchlist: 1, unverified: 2, rejected: 3 };
    const discoveryOrder = [a, b].sort(
      (x, y) =>
        STATUS_RANK[x.status] - STATUS_RANK[y.status] ||
        y.scenario!.worstPnlTotal - x.scenario!.worstPnlTotal ||
        y.scenario!.meanPnlTotal - x.scenario!.meanPnlTotal ||
        x.structure.localeCompare(y.structure),
    );
    const kernelOrder = new ScenarioGridRank().rank([a, b], {});
    expect(discoveryOrder.map((c) => c.id)).toEqual(["a", "b"]);
    expect(kernelOrder.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("strategy direction routes through the kernel, tier-identical to direct discovery", async () => {
    // SUPERSEDES the old byte-identical pin: the runner now runs the
    // kernel path, so the result carries falsificationEvidence and
    // the kernel order (tier, fitScore) — tiers and candidate set
    // match direct discovery; byte-identity does not hold by design.
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const oldOut = await runDiscoveryMode({ provider }, RESEARCH_CONFIG_DEFAULTS, STRATEGY_REQUEST);
    const newOut = await createFitDiscoveryRunner({ provider, userLogin: "test" }).run(STRATEGY_REQUEST);
    expect(newOut.ok).toBe(true);
    if (oldOut.direction !== "strategy_to_names" || !newOut.result || newOut.result.direction !== "strategy_to_names") {
      throw new Error("direction mismatch in fixture");
    }
    const oldTiers = new Map(oldOut.result.ranked.map((f) => [f.symbol, f.status]));
    const newTiers = new Map(newOut.result.result.ranked.map((f) => [f.symbol, f.status]));
    expect([...newTiers.entries()].sort()).toEqual([...oldTiers.entries()].sort());
    expect(newOut.result.result.rejected).toEqual(oldOut.result.rejected);
    for (const fit of newOut.result.result.ranked) {
      expect(typeof fit.falsificationEvidence).toBe("string");
    }
  });

  // NOTE: the old "evidence:" pin (kernel falsify demotes every fit)
  // is superseded by the falsification block below: evidenced fits
  // keep their tiers, and the control test "evidence-less fits still
  // demote" pins the invariant for fits without evidence.
});

describe("NLQ fit falsification (#1256)", () => {
  it("evidence builder names the evaluated record, never a constant", async () => {
    const { buildFitFalsificationEvidence } = await import("../src/services/researchDiscovery");
    const base = {
      symbol: "AAA",
      structure: "iron_condor",
      status: "qualified" as const,
      gateReasons: [] as string[],
      chainAsOf: NOW,
      chainProvenance: "live" as const,
      quoteSource: "fixture:quote",
      components: { liquidity: 0.9, ivFit: 0.8, termStructureFit: 0.7, earningsDistance: 1, correlation: 0.6, trackRecord: null },
      missingComponents: ["trackRecord"] as const,
      fitScore: 0.82,
    };
    const a = buildFitFalsificationEvidence(base);
    const b = buildFitFalsificationEvidence({ ...base, components: { ...base.components, ivFit: 0.4 }, fitScore: 0.71 });
    const c = buildFitFalsificationEvidence({ ...base, symbol: "BBB", chainAsOf: NOW + 60_000 });
    expect(a).toContain("AAA");
    expect(a).toContain("iron_condor");
    expect(a).toContain("qualified");
    expect(a).toContain("falsificationPresent");
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("strategy direction routes through the kernel facade (discoverNamesForStrategy)", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const spy = vi.spyOn(RecommendationService.prototype, "discoverNamesForStrategy");
    try {
      const outcome = await createFitDiscoveryRunner({ provider, userLogin: "test" }).run(STRATEGY_REQUEST);
      expect(outcome.ok).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("strategy direction: evidenced fits keep their tiers through the kernel", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const oldOut = await runDiscoveryMode({ provider }, RESEARCH_CONFIG_DEFAULTS, STRATEGY_REQUEST);
    if (oldOut.direction !== "strategy_to_names") throw new Error("direction mismatch in fixture");
    const qualified = oldOut.result.ranked.filter((f) => f.status === "qualified");
    expect(qualified.length).toBeGreaterThan(0);
    // Every ranked fit must carry genuine evidence from its own
    // evaluated record — the discovery gate + fit components.
    for (const fit of oldOut.result.ranked) {
      expect(typeof fit.falsificationEvidence).toBe("string");
      expect(fit.falsificationEvidence).toContain(fit.symbol);
    }
    const kernelOut = await new RecommendationService().discoverNamesForStrategy({
      discoverNamesForStrategy: async () => oldOut.result,
      structure: "iron_condor",
      outlook: "range_bound",
      symbols: ["AAA"],
    });
    const byId = new Map(kernelOut.candidates.map((c) => [c.id, c.status]));
    for (const fit of oldOut.result.ranked) {
      expect(byId.get(`fit:${fit.symbol}:${fit.structure}`)).toBe(fit.status);
    }
  });

  it("strategy direction: evidence-less fits still demote (invariant preserved)", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const oldOut = await runDiscoveryMode({ provider }, RESEARCH_CONFIG_DEFAULTS, STRATEGY_REQUEST);
    if (oldOut.direction !== "strategy_to_names") throw new Error("direction mismatch in fixture");
    const stripped = {
      ...oldOut.result,
      ranked: oldOut.result.ranked.map((f) => ({ ...f, falsificationEvidence: undefined })),
    };
    const kernelOut = await new RecommendationService().discoverNamesForStrategy({
      discoverNamesForStrategy: async () => stripped,
      structure: "iron_condor",
      outlook: "range_bound",
      symbols: ["AAA"],
    });
    const qualified = oldOut.result.ranked.filter((f) => f.status === "qualified");
    expect(qualified.length).toBeGreaterThan(0);
    const demoted = kernelOut.candidates.filter((c) => c.status === "unverified");
    expect(demoted.length).toBe(qualified.length);
  });

  it("null-economics fits stay unverified even with evidence (economics leg of the invariant)", async () => {
    // Kernel-level case: the real strategy path rejects null-economics
    // symbols before fit-scoring, so this combination cannot arise
    // from discovery — but the invariant must hold regardless: falsify
    // requires BOTH economics and evidence to keep a tier.
    const result = {
      structure: "iron_condor",
      ranked: [
        {
          symbol: "AAA",
          structure: "iron_condor",
          status: "qualified" as const,
          provenance: "live" as const,
          fitScore: 0.9,
          components: { liquidity: 0.9, ivFit: 0.8, termStructureFit: 0.7, earningsDistance: 1, correlation: 0.6, trackRecord: 0.5 },
          missingComponents: [] as string[],
          economics: null,
          falsificationEvidence: "fit falsification (researchDiscovery: gateComposedCandidate falsificationPresent): AAA iron_condor gated qualified",
        },
      ],
      rejected: [],
      limitations: [],
    };
    const kernelOut = await new RecommendationService().discoverNamesForStrategy({
      discoverNamesForStrategy: async () => result as never,
      structure: "iron_condor",
      outlook: "range_bound",
      symbols: ["AAA"],
    });
    expect(kernelOut.candidates).toHaveLength(1);
    expect(kernelOut.candidates[0].status).toBe("unverified");
  });

  it("kernel order (tier, fitScore) wins on a tier/score disagreement", () => {
    // Hand-built disagreement: a watchlist fit with the higher
    // fitScore vs a qualified fit with the lower one. Discovery
    // orders fitScore-first (watchlist first); the kernel's
    // PerNameBestFit orders tier-first (qualified first). The kernel
    // order wins after the rewire — pinned, not silent.
    const mk = (symbol: string, status: "qualified" | "watchlist", fitScore: number): KernelCandidate =>
      ({
        id: `fit:${symbol}:iron_condor`,
        symbol,
        structure: "iron_condor",
        label: `${symbol} fit`,
        legs: [],
        economics: { structure: "iron_condor", legs: [], netDebit: 0, netCredit: 1, maxLoss: 100, maxGain: 50, breakevens: [], derivationNotes: [] },
        status,
        provenance: "quant",
        chainProvenance: "live",
        definedRisk: false,
        marginEstimate: null,
        assignmentRisk: false,
        gateReasons: [],
        limitations: [],
        rationale: "",
        builderId: "name-fit",
        fitScore,
        falsificationEvidence: "test evidence",
      }) as KernelCandidate;
    const watch = mk("AAA", "watchlist", 0.95);
    const qual = mk("BBB", "qualified", 0.6);
    const discoveryOrder = [watch, qual].sort((x, y) => (y.fitScore ?? 0) - (x.fitScore ?? 0) || x.symbol.localeCompare(y.symbol));
    expect(discoveryOrder.map((c) => c.symbol)).toEqual(["AAA", "BBB"]);
    const kernelOrder = new PerNameBestFit().rank([watch, qual], {});
    expect(kernelOrder.map((c) => c.symbol)).toEqual(["BBB", "AAA"]);
  });
});

describe("NLQ fit rendering carries null economics (#1256)", () => {
  const econ = { structure: "iron_condor", legs: [], netDebit: 0, netCredit: 1.2, maxLoss: 380, maxGain: 120, breakevens: [], derivationNotes: [] };
  const base: DiscoveryCandidate = {
    symbol: "AAA",
    structure: "iron_condor",
    label: "Iron Condor",
    source: "catalog",
    legs: [],
    economics: econ,
    status: "qualified",
    provenance: "live",
    definedRisk: true,
    marginEstimate: 380,
    assignmentRisk: false,
    gateReasons: [],
    limitations: [],
    scenario: { worstPnlTotal: 5, meanPnlTotal: 50, bestPnlTotal: 120, withinConstraints: true },
  } as DiscoveryCandidate;

  it("name direction: a null-economics candidate is counted and rendered unverified, never dropped or zero-filled", async () => {
    const nullEcon = { ...base, economics: null as never, status: "unverified" as const };
    const result = {
      direction: "name_to_strategies",
      result: {
        symbol: "AAA",
        outlook: "range_bound",
        provenance: "live",
        candidates: [base, nullEcon],
        rejected: [],
        notConstructible: [],
        inadmissibleCatalogIds: [],
        limitations: [],
      },
    } as const;
    const out = await runOptionsStrategyAction(
      {} as never,
      "options_fit_discovery",
      { fitDiscovery: { direction: "name_to_strategies", symbol: "AAA", outlook: "range_bound" } } as never,
      { fitDiscoveryRunner: { run: async () => ({ ok: true, result, weightsApplied: false, notes: [] }) } },
    );
    expect(out.count).toBe(2);
    const nullRow = out.rows[1];
    expect(nullRow["maxLoss"]).toBe("unverified");
    expect(nullRow["netDebitCredit"]).toBe("economics unverified");
    expect(JSON.stringify(out.rows)).not.toContain("Unlimited");
    expect(out.rows[0]["maxLoss"]).toBe("$380.00");
  });

  it("strategy direction: a null-economics fit is counted and rendered unverified", async () => {
    const result = {
      direction: "strategy_to_names",
      result: {
        structure: "iron_condor",
        ranked: [
          { symbol: "BBB", structure: "iron_condor", status: "qualified", provenance: "live", fitScore: 88, components: {}, missingComponents: [], economics: { netDebit: 0, netCredit: 1.2, maxLoss: 380, maxGain: 120 } },
          { symbol: "CCC", structure: "iron_condor", status: "unverified", provenance: "live", fitScore: 70, components: {}, missingComponents: [], economics: null },
        ],
        rejected: [],
        limitations: [],
      },
    } as const;
    const out = await runOptionsStrategyAction(
      {} as never,
      "options_fit_discovery",
      { fitDiscovery: { direction: "strategy_to_names", structure: "iron_condor", outlook: "range_bound" } } as never,
      { fitDiscoveryRunner: { run: async () => ({ ok: true, result, weightsApplied: false, notes: [] }) } },
    );
    expect(out.count).toBe(2);
    expect(out.rows[1]["maxLoss"]).toBe("unverified");
    expect(out.rows[0]["maxLoss"]).toBe("$380.00");
  });
});
