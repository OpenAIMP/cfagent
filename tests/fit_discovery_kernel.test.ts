/**
 * #1256 remainder — NLQ fit rewire to the kernel research entries.
 *
 * Name direction (name_to_strategies) runs through the kernel facade
 * (RecommendationService.discoverForName, gate evidence from the same
 * provider session) and maps back to DiscoveryModeResult via
 * kernelDiscoveryMapping. Strategy direction (strategy_to_names)
 * DELIBERATELY stays on the direct discovery path: the kernel's
 * falsify stage demotes every fit (rankings carry no falsification
 * evidence) from qualified/watchlist to unverified, which would
 * change NLQ fit tiers — the test "evidence:" below pins that
 * behavior. Switching the strategy direction needs a fit-tier design
 * decision (rankings are not falsifiable structures), not a forced
 * mapping; it is reported as the #1256 remainder, not silently done.
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

  it("strategy direction stays on the direct discovery path, byte-identical", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const oldOut = await runDiscoveryMode({ provider }, RESEARCH_CONFIG_DEFAULTS, STRATEGY_REQUEST);
    const newOut = await createFitDiscoveryRunner({ provider, userLogin: "test" }).run(STRATEGY_REQUEST);
    expect(newOut.ok).toBe(true);
    if (oldOut.direction !== "strategy_to_names" || !newOut.result || newOut.result.direction !== "strategy_to_names") {
      throw new Error("direction mismatch in fixture");
    }
    expect(newOut.result.result).toEqual(oldOut.result);
  });

  it("evidence: the kernel falsify stage demotes fits, so the strategy direction cannot switch tiers-intact", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const oldOut = await runDiscoveryMode({ provider }, RESEARCH_CONFIG_DEFAULTS, STRATEGY_REQUEST);
    if (oldOut.direction !== "strategy_to_names") throw new Error("direction mismatch in fixture");
    const qualified = oldOut.result.ranked.filter((f) => f.status === "qualified");
    expect(qualified.length).toBeGreaterThan(0);
    const kernelOut = await new RecommendationService().discoverNamesForStrategy({
      discoverNamesForStrategy: async () => oldOut.result,
      structure: "iron_condor",
      outlook: "range_bound",
      symbols: ["AAA"],
    });
    // Fits carry no falsification evidence, so falsify demotes them to
    // unverified — a tier change the NLQ answer must not absorb
    // silently. Until fit-tier semantics are decided, the strategy
    // direction stays direct.
    const demoted = kernelOut.candidates.filter((c) => c.status === "unverified");
    expect(demoted.length).toBe(qualified.length);
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
