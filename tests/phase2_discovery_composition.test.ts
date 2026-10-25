/**
 * Issue #1114 (Phase 2 of epic #1096) — Name↔Strategy discovery +
 * strategy composition algebra pins.
 *
 *  - Leg-graph model: catalog leg sets (ratios, multi-expiry, stock
 *    legs) convert to graphs; identical contracts consolidate (net,
 *    zero-net drops); defined-risk is computed from tail slopes — a
 *    net short call tail or a short stock leg is undefined-risk.
 *  - Composition operators: overlay (wings on a short strangle →
 *    condor-wrapped strangle), combine (condor + butterfly with
 *    consolidation), transform (straddle → strangle; anything →
 *    defined-risk), repair (losing vertical → butterfly; refuses a
 *    non-losing position), roll (later expiry / strike shift; refuses
 *    a missing target expiry).
 *  - Quant gate: composed candidates are priced ONLY by
 *    researchEconomics and admitted ONLY by the real researchGates
 *    (source pins: no Black-Scholes/payoff code and no parallel
 *    admissibility table in the new modules). Undefined-risk is
 *    rejected by default; the leg cap is enforced; calibrated chains
 *    cap a candidate at Watchlist (provenance honesty survives).
 *  - Discovery (researchPipeline mode): Name→Strategies enumerates
 *    the catalog (admissible / not-constructible recorded, never
 *    silently dropped) plus composed candidates, priced, gated, and
 *    ranked by the Phase 1 scenario grid; Strategy→Names ranks a
 *    universe by a fit score whose components are named — and a
 *    missing component (no catalyst feed, no track record) is
 *    reported absent, never fabricated.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  graphFromResearchLegs,
  graphFromCatalogLegs,
  consolidateLegs,
  analyzeRisk,
  optionLegsOf,
  overlay,
  combine,
  transformStraddleToStrangle,
  transformToDefinedRisk,
  repairVerticalToButterfly,
  roll,
  gateComposedCandidate,
  DEFAULT_COMPOSITION_CONFIG,
  type StrategyGraph,
} from "../src/services/strategyComposition";
import {
  runDiscoveryMode,
  discoverStrategiesForName,
  discoverNamesForStrategy,
} from "../src/services/researchDiscovery";
import {
  composedStructureEconomics,
  type ResearchLeg,
} from "../src/services/researchEconomics";
import type {
  ChainSnapshot,
  ProviderChainLeg,
  ResearchDataProvider,
} from "../src/services/researchPipeline";
import { RESEARCH_CONFIG_DEFAULTS } from "../src/services/researchConfig";
import type { StrategyLeg } from "../src/trading/options/strategyEngine";

const NOW = Date.UTC(2026, 10, 2, 15, 0, 0);
const EXP1 = "2026-12-18";
const EXP2 = "2027-01-15";
const EXP3 = "2027-06-18";
const STRIKES = [75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125];

function chainLeg(
  optionType: "call" | "put",
  strike: number,
  expiry: string,
  dte: number,
  mid: number,
  opts: { iv?: number; volume?: number; openInterest?: number } = {}
): ProviderChainLeg {
  return {
    optionType,
    strike,
    expiry,
    dte,
    bid: Number((mid * 0.98).toFixed(2)),
    ask: Number((mid * 1.02).toFixed(2)),
    iv: opts.iv ?? 0.4,
    volume: opts.volume ?? 200,
    openInterest: opts.openInterest ?? 1000,
  };
}

function expiryLegs(
  expiry: string,
  dte: number,
  opts: { iv?: number; volume?: number; openInterest?: number } = {}
): ProviderChainLeg[] {
  const legs: ProviderChainLeg[] = [];
  for (const strike of STRIKES) {
    const mid = Math.max(0.4, 9 - Math.abs(strike - 100) * 0.18);
    legs.push(chainLeg("call", strike, expiry, dte, mid, opts));
    legs.push(chainLeg("put", strike, expiry, dte, mid, opts));
  }
  return legs;
}

function makeChain(
  symbol: string,
  opts: {
    iv?: number;
    volume?: number;
    openInterest?: number;
    provenance?: ChainSnapshot["provenance"];
  } = {}
): ChainSnapshot {
  return {
    symbol,
    underlyingPrice: 100,
    asOf: NOW,
    provenance: opts.provenance ?? "live",
    expiries: [
      { expiry: EXP1, dte: 35, legs: expiryLegs(EXP1, 35, opts) },
      { expiry: EXP2, dte: 63, legs: expiryLegs(EXP2, 63, opts) },
      { expiry: EXP3, dte: 228, legs: expiryLegs(EXP3, 228, opts) },
    ],
  };
}

function rLeg(
  optionType: "call" | "put",
  strike: number,
  quantity: number,
  expiry = EXP1,
  dte = 35
): ResearchLeg {
  const mid = Math.max(0.4, 9 - Math.abs(strike - 100) * 0.18);
  return {
    optionType,
    strike,
    expiry,
    dte,
    bid: Number((mid * 0.98).toFixed(2)),
    ask: Number((mid * 1.02).toFixed(2)),
    iv: 0.4,
    volume: 200,
    openInterest: 1000,
    quantity,
    quoteTimestamp: NOW,
  };
}

function graph(id: string, legs: ResearchLeg[]): StrategyGraph {
  return graphFromResearchLegs({ id, label: id, source: "catalog", legs });
}

const SHORT_STRANGLE = () => graph("short_strangle", [rLeg("put", 95, -1), rLeg("call", 105, -1)]);
const IRON_CONDOR = () =>
  graph("iron_condor", [rLeg("put", 90, 1), rLeg("put", 95, -1), rLeg("call", 105, -1), rLeg("call", 110, 1)]);

/* ------------------------------------------------------------------ */
/* Leg-graph model                                                     */
/* ------------------------------------------------------------------ */

describe("leg-graph model", () => {
  it("converts catalog leg sets including ratios, multi-expiry, and stock legs", () => {
    const catalogLegs: StrategyLeg[] = [
      {
        symbol: "AAA|call", optionType: "CALL", side: "SELL", quantity: 2, strike: 100,
        expirationDate: EXP1, daysToExpiration: 35, entryPrice: 3, bid: 2.9, ask: 3.1,
        impliedVolatility: 0.4, delta: -0.5, gamma: 0, theta: 0, vega: 0,
        openInterest: 1000, volume: 200, spreadPct: 0.05,
        quoteTimestamp: new Date(NOW).toISOString(), quoteFreshness: "FRESH", multiplier: 100,
      },
      {
        symbol: "AAA:STOCK", optionType: "STOCK", side: "BUY", quantity: 100, strike: 0,
        expirationDate: EXP1, entryPrice: 100, bid: 100, ask: 100,
        impliedVolatility: 0, delta: 1, gamma: 0, theta: 0, vega: 0,
        openInterest: 0, volume: 0, spreadPct: 0,
        quoteTimestamp: "", quoteFreshness: "UNKNOWN", multiplier: 1,
      },
    ];
    const g = graphFromCatalogLegs({ id: "covered_x", label: "Covered X", legs: catalogLegs });
    const options = optionLegsOf(g);
    expect(options).toHaveLength(1);
    expect(options[0].quantity).toBe(-2);
    expect(options[0].optionType).toBe("call");
    const stock = g.legs.find((l) => l.kind === "stock");
    expect(stock && stock.kind === "stock" ? stock.quantity : 0).toBe(100);
  });

  it("consolidates identical contracts and drops zero-net legs", () => {
    const legs = [rLeg("call", 100, 1), rLeg("call", 100, 2), rLeg("put", 95, -1), rLeg("put", 95, 1)];
    const out = consolidateLegs(legs.map((l) => ({ ...l, kind: "option" as const })));
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBe(3);
  });

  it("computes defined-risk from tail slopes", () => {
    expect(analyzeRisk(IRON_CONDOR()).definedRisk).toBe(true);
    expect(analyzeRisk(SHORT_STRANGLE()).definedRisk).toBe(false);
    // Ratio spread: long 1 / short 2 calls leaves a net short call tail.
    const ratio = graph("call_ratio_spread", [rLeg("call", 95, 1), rLeg("call", 105, -2)]);
    expect(analyzeRisk(ratio).definedRisk).toBe(false);
    // Long straddle is defined-risk (premium only).
    const straddle = graph("long_straddle", [rLeg("call", 100, 1), rLeg("put", 100, 1)]);
    expect(analyzeRisk(straddle).definedRisk).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Composition operators                                               */
/* ------------------------------------------------------------------ */

describe("composition operators", () => {
  const chain = makeChain("AAA");

  it("overlay adds wings beyond uncovered shorts → condor-wrapped strangle, defined-risk", () => {
    const out = overlay(SHORT_STRANGLE(), chain);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.graph.operator).toBe("overlay");
    expect(out.graph.legs).toHaveLength(4);
    expect(analyzeRisk(out.graph).definedRisk).toBe(true);
    const strikes = optionLegsOf(out.graph).map((l) => `${l.optionType}:${l.strike}:${l.quantity}`).sort();
    expect(strikes).toEqual(["call:105:-1", "call:110:1", "put:90:1", "put:95:-1"]);
  });

  it("overlay refuses a structure with no uncovered short legs", () => {
    const out = overlay(IRON_CONDOR(), chain);
    expect(out.ok).toBe(false);
  });

  it("combine merges condor + butterfly with consolidation", () => {
    const butterfly = graph("long_call_butterfly", [rLeg("call", 95, 1), rLeg("call", 100, -2), rLeg("call", 105, 1)]);
    const out = combine(IRON_CONDOR(), butterfly, { id: "condor_plus_butterfly", label: "Condor + Butterfly" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.graph.parents).toEqual(["iron_condor", "long_call_butterfly"]);
    // call 105: condor -1 and butterfly +1 net to zero and drop out.
    expect(out.graph.legs).toHaveLength(5);
    expect(optionLegsOf(out.graph).some((l) => l.optionType === "call" && l.strike === 105)).toBe(false);
  });

  it("transform straddle → strangle widens both strikes one step", () => {
    const straddle = graph("long_straddle", [rLeg("call", 100, 1), rLeg("put", 100, 1)]);
    const out = transformStraddleToStrangle(straddle, chain);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const legs = optionLegsOf(out.graph);
    expect(legs.find((l) => l.optionType === "call")?.strike).toBe(105);
    expect(legs.find((l) => l.optionType === "put")?.strike).toBe(95);
  });

  it("transform to defined-risk wraps a short straddle with wings", () => {
    const shortStraddle = graph("short_straddle", [rLeg("call", 100, -1), rLeg("put", 100, -1)]);
    const out = transformToDefinedRisk(shortStraddle, chain);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(analyzeRisk(out.graph).definedRisk).toBe(true);
    // Already defined-risk input is refused.
    expect(transformToDefinedRisk(IRON_CONDOR(), chain).ok).toBe(false);
  });

  it("repair converts a losing bull call spread into a butterfly and refuses a winning one", () => {
    const spread = graph("call_debit_spread", [rLeg("call", 90, 1), rLeg("call", 95, -1)]);
    const out = repairVerticalToButterfly(spread, chain, { currentPnlPerUnit: -1.25 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const legs = optionLegsOf(out.graph)
      .map((l) => `${l.strike}:${l.quantity}`)
      .sort();
    expect(legs).toEqual(["100:1", "90:1", "95:-2"]);
    expect(repairVerticalToButterfly(spread, chain, { currentPnlPerUnit: 0.5 }).ok).toBe(false);
  });

  it("roll moves legs to the next expiry, optionally shifting strikes; missing expiry refuses", () => {
    const out = roll(IRON_CONDOR(), chain, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(optionLegsOf(out.graph).every((l) => l.expiry === EXP2)).toBe(true);
    const shifted = roll(IRON_CONDOR(), chain, { strikeShiftSteps: 1 });
    expect(shifted.ok).toBe(true);
    if (!shifted.ok) return;
    expect(optionLegsOf(shifted.graph).map((l) => l.strike).sort((a, b) => a - b)).toEqual([95, 100, 110, 115]);
    const farChain: ChainSnapshot = { ...chain, expiries: chain.expiries.slice(0, 1) };
    expect(roll(IRON_CONDOR(), farChain, {}).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Quant gate                                                          */
/* ------------------------------------------------------------------ */

describe("quant gate for composed candidates", () => {
  const chain = makeChain("AAA");

  it("prices composed structures with researchEconomics' generic grid (condor max loss = wing − credit)", () => {
    const econ = composedStructureEconomics("iron_condor", optionLegsOf(IRON_CONDOR()), 100);
    // Put wing 95→90 and call wing 105→110: width 5; net credit from fixture mids.
    expect(econ.maxLoss).toBeGreaterThan(0);
    expect(econ.maxLoss).toBeLessThan(5);
    expect(econ.netCredit).toBeGreaterThan(0);
  });

  it("qualifies a condor-wrapped strangle on a live chain through the real gates", () => {
    const composed = overlay(SHORT_STRANGLE(), chain);
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const gated = gateComposedCandidate({
      graph: composed.graph,
      structure: "iron_condor",
      symbol: "AAA",
      outlook: "range_bound",
      thesis: "Range-bound discovery candidate: short strangle wrapped in protective wings.",
      spot: 100,
      provenance: "live",
      now: NOW,
      falsificationPresent: true,
      sources: ["fixture:chain"],
    });
    expect(gated.status).toBe("qualified");
    expect(gated.definedRisk).toBe(true);
    expect(gated.marginEstimate).toBeCloseTo(gated.economics.maxLoss * 100, 1);
  });

  it("caps a calibrated-chain candidate at watchlist (provenance honesty)", () => {
    const composed = overlay(SHORT_STRANGLE(), chain);
    if (!composed.ok) throw new Error("overlay failed");
    const gated = gateComposedCandidate({
      graph: composed.graph,
      structure: "iron_condor",
      symbol: "AAA",
      outlook: "range_bound",
      thesis: "Range-bound discovery candidate on a calibrated chain.",
      spot: 100,
      provenance: "calibrated",
      now: NOW,
      falsificationPresent: true,
      sources: ["fixture:chain"],
    });
    expect(gated.status).toBe("watchlist");
  });

  it("rejects undefined-risk by default; explicit enablement caps at watchlist", () => {
    const base = {
      graph: SHORT_STRANGLE(),
      structure: "long_strangle",
      symbol: "AAA",
      outlook: "volatile" as const,
      thesis: "Volatility discovery candidate with an undefined-risk short strangle.",
      spot: 100,
      provenance: "live" as const,
      now: NOW,
      falsificationPresent: true,
      sources: ["fixture:chain"],
    };
    const rejected = gateComposedCandidate(base);
    expect(rejected.status).toBe("rejected");
    expect(rejected.reasons.join(" ")).toMatch(/undefined-risk/i);
    const allowed = gateComposedCandidate({ ...base, config: { ...DEFAULT_COMPOSITION_CONFIG, allowUndefinedRisk: true } });
    expect(allowed.status).toBe("watchlist");
    expect(allowed.definedRisk).toBe(false);
    expect(allowed.marginEstimate).toBeNull();
  });

  it("enforces the leg-count cap", () => {
    const many = graph(
      "many_legs",
      Array.from({ length: DEFAULT_COMPOSITION_CONFIG.maxLegs + 1 }, (_, i) => rLeg("call", 75 + i * 5, 1))
    );
    const gated = gateComposedCandidate({
      graph: many,
      structure: "iron_condor",
      symbol: "AAA",
      outlook: "range_bound",
      thesis: "Leg cap enforcement candidate for the composition gate.",
      spot: 100,
      provenance: "live",
      now: NOW,
      falsificationPresent: true,
      sources: ["fixture:chain"],
    });
    expect(gated.status).toBe("rejected");
    expect(gated.reasons.join(" ")).toMatch(/leg/i);
  });
});

/* ------------------------------------------------------------------ */
/* Discovery service (researchPipeline mode)                           */
/* ------------------------------------------------------------------ */

function makeProvider(chains: Record<string, ChainSnapshot>): ResearchDataProvider {
  return {
    async getUniverseSymbols() {
      return Object.keys(chains);
    },
    async getQuote(symbol: string) {
      return chains[symbol]
        ? { symbol, price: 100, timestamp: NOW, quoteStatus: "live", source: "fixture:quote" }
        : null;
    },
    async getChain(symbol: string) {
      return chains[symbol] ?? { symbol, underlyingPrice: 100, asOf: NOW, provenance: "unavailable" as const, expiries: [] };
    },
    async getTechnicals() {
      return { trend: "flat" as const, momentum: 0, notes: [] };
    },
    async getCatalysts(symbol: string) {
      if (symbol === "AAA") return [{ description: "Earnings", date: "2026-11-24", direction: "neutral" as const }];
      return null;
    },
    async getRegime() {
      return { regime: "chop" as const, notes: [], asOf: NOW };
    },
  };
}

describe("discovery service", () => {
  it("Name→Strategies: catalog + composed candidates, priced, gated, scenario-ranked", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const result = await discoverStrategiesForName(
      { provider },
      RESEARCH_CONFIG_DEFAULTS,
      { symbol: "AAA", outlook: "range_bound", now: NOW }
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    const structures = result.candidates.map((c) => c.structure);
    expect(structures).toContain("iron_condor");
    expect(structures).toContain("butterfly");
    // At least one composed candidate (condor+butterfly and/or wrapped strangle).
    expect(result.candidates.some((c) => c.source === "composed")).toBe(true);
    // Ranked by scenario outcome: worst-cell P&L descending.
    const worsts = result.candidates.map((c) => c.scenario.worstPnlTotal);
    expect([...worsts].sort((a, b) => b - a)).toEqual(worsts);
    // Every candidate carries status, provenance, and economics.
    for (const c of result.candidates) {
      expect(["qualified", "watchlist", "unverified"]).toContain(c.status);
      expect(c.provenance).toBe("live");
      expect(c.economics.maxLoss).toBeGreaterThanOrEqual(0);
    }
    // Admissible-but-not-constructible catalog ids are recorded, not dropped.
    expect(result.notConstructible).toContain("jade_lizard");
  });

  it("Name→Strategies on a calibrated chain never reports qualified", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA", { provenance: "calibrated" }) });
    const result = await discoverStrategiesForName(
      { provider },
      RESEARCH_CONFIG_DEFAULTS,
      { symbol: "AAA", outlook: "range_bound", now: NOW }
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.status !== "qualified")).toBe(true);
  });

  it("Strategy→Names ranks by fit score with named components; missing data is absent, not fabricated", async () => {
    const provider = makeProvider({
      AAA: makeChain("AAA"),
      BBB: makeChain("BBB", { openInterest: 10, volume: 1 }),
      // CCC: clean liquidity but rich IV (0.55 vs the condor family's
      // 0.40 target) and no catalyst feed — fits worse than AAA and
      // must expose its missing components rather than invent them.
      CCC: makeChain("CCC", { iv: 0.55 }),
    });
    const result = await discoverNamesForStrategy(
      { provider },
      RESEARCH_CONFIG_DEFAULTS,
      { structure: "iron_condor", outlook: "range_bound", symbols: ["AAA", "BBB", "CCC"], now: NOW }
    );
    expect(result.ranked.length).toBeGreaterThan(0);
    expect(result.ranked[0].symbol).toBe("AAA");
    const aaa = result.ranked.find((r) => r.symbol === "AAA")!;
    expect(aaa.components.liquidity).not.toBeNull();
    expect(aaa.components.earningsDistance).not.toBeNull();
    const ccc = result.ranked.find((r) => r.symbol === "CCC");
    if (ccc) {
      // No catalyst feed for CCC and no track record anywhere: both absent.
      expect(ccc.components.earningsDistance).toBeNull();
      expect(ccc.components.trackRecord).toBeNull();
      expect(ccc.missingComponents).toContain("earningsDistance");
      expect(ccc.missingComponents).toContain("trackRecord");
    }
    // Scores are ordered descending.
    const scores = result.ranked.map((r) => r.fitScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("runDiscoveryMode dispatches both directions through one entry", async () => {
    const provider = makeProvider({ AAA: makeChain("AAA") });
    const byName = await runDiscoveryMode(
      { provider },
      RESEARCH_CONFIG_DEFAULTS,
      { direction: "name_to_strategies", symbol: "AAA", outlook: "range_bound", now: NOW }
    );
    expect(byName.direction).toBe("name_to_strategies");
    const byStrategy = await runDiscoveryMode(
      { provider },
      RESEARCH_CONFIG_DEFAULTS,
      { direction: "strategy_to_names", structure: "iron_condor", outlook: "range_bound", symbols: ["AAA"], now: NOW }
    );
    expect(byStrategy.direction).toBe("strategy_to_names");
  });
});

/* ------------------------------------------------------------------ */
/* Source pins: no second pricing engine, no parallel gate             */
/* ------------------------------------------------------------------ */

describe("research-reuse source pins", () => {
  it("new modules price and gate only through researchEconomics / researchGates", () => {
    const composition = readFileSync("src/services/strategyComposition.ts", "utf8");
    const discovery = readFileSync("src/services/researchDiscovery.ts", "utf8");
    for (const src of [composition, discovery]) {
      expect(src).not.toMatch(/blackScholesPrice|normCdf|payoffAtExpiry/);
      expect(src).not.toMatch(/function gateThesisCoherence|compatible\s*[:=]\s*\{[^}]*bullish/);
    }
    expect(composition).toContain("runStageGates");
    expect(discovery).toContain("evaluateScenarioGrid");
  });
});
