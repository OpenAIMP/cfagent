/**
 * Issue #1114 (epic #1096 Phase 2) — strategy composition algebra.
 *
 * A leg-graph model over the strategy catalog plus composition
 * operators (overlay / combine / transform / repair / roll), so
 * hybrid structures — condor + butterfly, a short strangle wrapped
 * in wings, a losing vertical repaired into a butterfly — can be
 * generated as single candidates and passed through the SAME quant
 * gate as catalog strategies:
 *
 *  - pricing: `researchEconomics` only (this module contains no
 *    Black-Scholes / payoff code — pinned by test);
 *  - admissibility: `researchGates.runStageGates` only (no parallel
 *    admissibility table — the gate sees the candidate's dominant
 *    economics family; the hybrid identity lives in the graph
 *    label/operator/parents);
 *  - honesty: defined-risk is computed from tail slopes, not from
 *    the finite pricing grid; undefined-risk compositions are
 *    rejected unless explicitly enabled, and then cap at Watchlist.
 *
 * Stock legs are represented in the graph (catalog conversion) and
 * risk-analyzed (a short stock leg is undefined-risk), but composed
 * candidates containing stock legs are NOT priced here: the
 * researchEconomics grid is options-only, so the gate returns
 * Unverified with that limitation stated rather than pricing half
 * a structure.
 *
 * READ-ONLY: nothing in this module can place, modify, or cancel
 * orders.
 */

import {
  composedStructureEconomics,
  type ResearchLeg,
  type StructureEconomics,
} from "./researchEconomics";
import {
  runStageGates,
  type GateResult,
  type IdeaStatus,
  type Outlook,
  type ChainProvenance,
} from "./researchGates";
import type { ResearchConfig } from "./researchConfig";
import { RESEARCH_CONFIG_DEFAULTS } from "./researchConfig";
import type { ChainSnapshot, ProviderChainLeg } from "./researchPipeline";
import type { StrategyLeg } from "../trading";

/* ------------------------------------------------------------------ */
/* Leg-graph model                                                     */
/* ------------------------------------------------------------------ */

export interface OptionGraphLeg extends ResearchLeg {
  kind: "option";
}

export interface StockGraphLeg {
  kind: "stock";
  symbol: string;
  /** Signed share count (+ long, − short). */
  quantity: number;
  price: number;
  expiry: string;
}

export type GraphLeg = OptionGraphLeg | StockGraphLeg;

export type CompositionOperator =
  | "overlay"
  | "combine"
  | "transform"
  | "repair"
  | "roll";

export interface StrategyGraph {
  id: string;
  label: string;
  source: "catalog" | "composed";
  operator?: CompositionOperator;
  /** Graph ids this graph was composed from (empty for catalog graphs). */
  parents: string[];
  legs: GraphLeg[];
}

export function graphFromResearchLegs(input: {
  id: string;
  label: string;
  source: "catalog" | "composed";
  operator?: CompositionOperator;
  parents?: string[];
  legs: ResearchLeg[];
}): StrategyGraph {
  return {
    id: input.id,
    label: input.label,
    source: input.source,
    operator: input.operator,
    parents: input.parents ?? [],
    legs: input.legs.map((leg) => ({ ...leg, kind: "option" as const })),
  };
}

/** Convert a catalog/engine leg set (`StrategyLeg[]`) into a graph. */
export function graphFromCatalogLegs(input: {
  id: string;
  label: string;
  legs: StrategyLeg[];
}): StrategyGraph {
  const legs: GraphLeg[] = input.legs.map((leg) => {
    if (leg.optionType === "STOCK") {
      return {
        kind: "stock",
        symbol: leg.symbol.split(":")[0].toUpperCase(),
        quantity: (leg.side === "BUY" ? 1 : -1) * leg.quantity,
        price: leg.entryPrice,
        expiry: leg.expirationDate,
      } satisfies StockGraphLeg;
    }
    return {
      kind: "option",
      optionType: leg.optionType === "CALL" ? "call" : "put",
      strike: leg.strike,
      expiry: leg.expirationDate,
      dte: leg.daysToExpiration ?? 0,
      bid: leg.bid,
      ask: leg.ask,
      iv: leg.impliedVolatility,
      volume: leg.volume,
      openInterest: leg.openInterest,
      quantity: (leg.side === "BUY" ? 1 : -1) * leg.quantity,
      quoteTimestamp: leg.quoteTimestamp ? Date.parse(leg.quoteTimestamp) || null : null,
    } satisfies OptionGraphLeg;
  });
  return { id: input.id, label: input.label, source: "catalog", parents: [], legs };
}

export function optionLegsOf(graph: StrategyGraph): ResearchLeg[] {
  return graph.legs
    .filter((leg): leg is OptionGraphLeg => leg.kind === "option")
    .map(({ kind: _kind, ...leg }) => leg);
}

export function hasStockLeg(graph: StrategyGraph): boolean {
  return graph.legs.some((leg) => leg.kind === "stock");
}

function legKey(leg: GraphLeg): string {
  return leg.kind === "stock"
    ? `stock|${leg.symbol}`
    : `option|${leg.optionType}|${leg.strike}|${leg.expiry}`;
}

/**
 * Consolidate legs: identical contracts net their signed quantities;
 * a leg whose net quantity reaches zero drops out. Quotes are taken
 * from the first occurrence (identical contracts share one quote).
 */
export function consolidateLegs(legs: GraphLeg[]): GraphLeg[] {
  const byKey = new Map<string, GraphLeg>();
  for (const leg of legs) {
    const key = legKey(leg);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...leg });
      continue;
    }
    existing.quantity += leg.quantity;
  }
  return [...byKey.values()].filter((leg) => Math.abs(leg.quantity) > 1e-9);
}

/* ------------------------------------------------------------------ */
/* Defined-risk analysis (tail slopes, not the finite pricing grid)    */
/* ------------------------------------------------------------------ */

export interface RiskAnalysis {
  definedRisk: boolean;
  reasons: string[];
  /** Payoff slope as spot → ∞, per spread unit (contracts; stock at shares/100). */
  upsideTailSlope: number;
  hasShortStock: boolean;
  /** Short option legs expiring within the assignment-risk window. */
  nearTermShortLegs: ResearchLeg[];
}

export function analyzeRisk(graph: StrategyGraph, assignmentRiskDte = 7): RiskAnalysis {
  const reasons: string[] = [];
  let upsideTailSlope = 0;
  let hasShortStock = false;
  const nearTermShortLegs: ResearchLeg[] = [];
  for (const leg of graph.legs) {
    if (leg.kind === "stock") {
      upsideTailSlope += leg.quantity / 100;
      if (leg.quantity < 0) hasShortStock = true;
      continue;
    }
    if (leg.optionType === "call") upsideTailSlope += leg.quantity;
    if (leg.quantity < 0 && leg.dte <= assignmentRiskDte) {
      nearTermShortLegs.push(leg);
    }
  }
  // As spot → 0 every option payoff is bounded (puts cap at strike),
  // so upside is the only unbounded direction for option legs; a
  // short stock leg is unbounded there too and is already counted
  // in the tail slope.
  const definedRisk = upsideTailSlope >= -1e-9;
  if (!definedRisk) {
    reasons.push(
      `Upside tail slope is ${upsideTailSlope.toFixed(2)} contracts — net short call/stock exposure is uncovered, so loss is theoretically unbounded.`
    );
  }
  if (hasShortStock) {
    reasons.push("Contains a short stock leg (unbounded upside exposure).");
  }
  return { definedRisk, reasons, upsideTailSlope, hasShortStock, nearTermShortLegs };
}

/* ------------------------------------------------------------------ */
/* Chain lookup (provider chain shape from researchPipeline)           */
/* ------------------------------------------------------------------ */

function validContract(leg: ProviderChainLeg): boolean {
  return leg.bid > 0 && leg.ask >= leg.bid;
}

function findInExpiry(
  chain: ChainSnapshot,
  expiry: string,
  optionType: "call" | "put",
  pick: (legs: ProviderChainLeg[]) => ProviderChainLeg | null
): ProviderChainLeg | null {
  const exp = chain.expiries.find((e) => e.expiry === expiry);
  if (!exp) return null;
  return pick(exp.legs.filter((l) => l.optionType === optionType && validContract(l)));
}

function strikesInExpiry(
  chain: ChainSnapshot,
  expiry: string,
  optionType: "call" | "put"
): number[] {
  const exp = chain.expiries.find((e) => e.expiry === expiry);
  if (!exp) return [];
  return [...new Set(exp.legs.filter((l) => l.optionType === optionType).map((l) => l.strike))].sort(
    (a, b) => a - b
  );
}

function toGraphLeg(leg: ProviderChainLeg, quantity: number, quoteTs: number): ResearchLeg {
  return {
    optionType: leg.optionType,
    strike: leg.strike,
    expiry: leg.expiry,
    dte: leg.dte,
    bid: leg.bid,
    ask: leg.ask,
    iv: leg.iv ?? null,
    volume: leg.volume ?? null,
    openInterest: leg.openInterest ?? null,
    quantity,
    quoteTimestamp: quoteTs,
  };
}

export type ComposeOutcome =
  | { ok: true; graph: StrategyGraph }
  | { ok: false; reason: string };

function composed(
  base: StrategyGraph,
  operator: CompositionOperator,
  id: string,
  label: string,
  legs: GraphLeg[],
  parents?: string[]
): ComposeOutcome {
  return {
    ok: true,
    graph: {
      id,
      label,
      source: "composed",
      operator,
      parents: parents ?? [base.id],
      legs: consolidateLegs(legs),
    },
  };
}

/**
 * For every (optionType, expiry) group, find the short quantity that
 * remains uncovered when strikes are swept from the tail inward
 * (calls from the highest strike down, puts from the lowest up).
 */
function uncoveredShorts(graph: StrategyGraph): Array<{
  optionType: "call" | "put";
  expiry: string;
  extremeStrike: number;
  quantity: number;
}> {
  const groups = new Map<string, ResearchLeg[]>();
  for (const leg of optionLegsOf(graph)) {
    const key = `${leg.optionType}|${leg.expiry}`;
    groups.set(key, [...(groups.get(key) ?? []), leg]);
  }
  const out: Array<{ optionType: "call" | "put"; expiry: string; extremeStrike: number; quantity: number }> = [];
  for (const legs of groups.values()) {
    const byStrike = new Map<number, number>();
    for (const leg of legs) {
      byStrike.set(leg.strike, (byStrike.get(leg.strike) ?? 0) + leg.quantity);
    }
    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    const type = legs[0].optionType;
    const ordered = type === "call" ? [...strikes].reverse() : strikes;
    let cumulative = 0;
    let uncovered = 0;
    let extreme = ordered[0];
    for (const strike of ordered) {
      cumulative += byStrike.get(strike) ?? 0;
      if (cumulative < uncovered) {
        uncovered = cumulative;
        extreme = strike;
      }
    }
    if (uncovered < 0) {
      out.push({
        optionType: type,
        expiry: legs[0].expiry,
        extremeStrike: extreme,
        quantity: -uncovered,
      });
    }
  }
  return out;
}

function addWings(
  graph: StrategyGraph,
  chain: ChainSnapshot,
  operator: CompositionOperator,
  idSuffix: string,
  label: string
): ComposeOutcome {
  const uncovered = uncoveredShorts(graph);
  const stockShort = graph.legs.some((leg) => leg.kind === "stock" && leg.quantity < 0);
  if (uncovered.length === 0 && !stockShort) {
    return { ok: false, reason: "No uncovered short legs to wrap — structure is already defined-risk." };
  }
  if (stockShort) {
    return { ok: false, reason: "Cannot wrap a short stock leg with option wings in this algebra; hedge the stock leg separately." };
  }
  const legs: GraphLeg[] = [...graph.legs];
  for (const u of uncovered) {
    const strikes = strikesInExpiry(chain, u.expiry, u.optionType);
    const wingStrike =
      u.optionType === "call"
        ? strikes.find((s) => s > u.extremeStrike)
        : [...strikes].reverse().find((s) => s < u.extremeStrike);
    if (wingStrike === undefined) {
      return {
        ok: false,
        reason: `No ${u.optionType} strike beyond ${u.extremeStrike} in expiry ${u.expiry} to use as a protective wing.`,
      };
    }
    const contract = findInExpiry(chain, u.expiry, u.optionType, (cands) =>
      cands.find((c) => c.strike === wingStrike) ?? null
    );
    if (!contract) {
      return { ok: false, reason: `Wing contract ${u.optionType} ${wingStrike} ${u.expiry} has no valid quote.` };
    }
    legs.push({ ...toGraphLeg(contract, u.quantity, chain.asOf), kind: "option" });
  }
  return composed(graph, operator, `${graph.id}${idSuffix}`, label, legs);
}

/* ------------------------------------------------------------------ */
/* Operators                                                           */
/* ------------------------------------------------------------------ */

/** Overlay protective wings on uncovered shorts (strangle → condor-wrapped strangle). */
export function overlay(graph: StrategyGraph, chain: ChainSnapshot): ComposeOutcome {
  return addWings(graph, chain, "overlay", "+wings", `${graph.label} + protective wings`);
}

/** Transform any undefined-risk structure into its defined-risk wrapped form. */
export function transformToDefinedRisk(graph: StrategyGraph, chain: ChainSnapshot): ComposeOutcome {
  if (analyzeRisk(graph).definedRisk) {
    return { ok: false, reason: "Structure is already defined-risk; nothing to transform." };
  }
  return addWings(graph, chain, "transform", "+defined-risk", `${graph.label} (defined-risk)`);
}

/** Combine two structures into one candidate; identical contracts consolidate. */
export function combine(
  a: StrategyGraph,
  b: StrategyGraph,
  opts: { id: string; label: string }
): ComposeOutcome {
  return {
    ok: true,
    graph: {
      id: opts.id,
      label: opts.label,
      source: "composed",
      operator: "combine",
      parents: [a.id, b.id],
      legs: consolidateLegs([...a.legs, ...b.legs]),
    },
  };
}

/** Transform a long straddle into a long strangle by widening both strikes one chain step. */
export function transformStraddleToStrangle(graph: StrategyGraph, chain: ChainSnapshot): ComposeOutcome {
  const options = optionLegsOf(graph);
  if (options.length !== 2) {
    return { ok: false, reason: "Straddle→strangle requires exactly two option legs (one call, one put at one strike)." };
  }
  const call = options.find((l) => l.optionType === "call");
  const put = options.find((l) => l.optionType === "put");
  if (!call || !put || call.strike !== put.strike || call.expiry !== put.expiry || call.quantity <= 0 || put.quantity <= 0) {
    return { ok: false, reason: "Legs are not a long straddle (long call + long put, same strike and expiry)." };
  }
  const strikes = strikesInExpiry(chain, call.expiry, "call");
  const callStrike = strikes.find((s) => s > call.strike);
  const putStrikes = strikesInExpiry(chain, call.expiry, "put");
  const putStrike = [...putStrikes].reverse().find((s) => s < put.strike);
  if (callStrike === undefined || putStrike === undefined) {
    return { ok: false, reason: "Chain has no strike beyond the straddle body to widen into a strangle." };
  }
  const newCall = findInExpiry(chain, call.expiry, "call", (c) => c.find((x) => x.strike === callStrike) ?? null);
  const newPut = findInExpiry(chain, call.expiry, "put", (c) => c.find((x) => x.strike === putStrike) ?? null);
  if (!newCall || !newPut) {
    return { ok: false, reason: "Strangle wing contracts have no valid quotes." };
  }
  return composed(graph, "transform", `${graph.id}->strangle`, `${graph.label} → Strangle`, [
    { ...toGraphLeg(newCall, call.quantity, chain.asOf), kind: "option" },
    { ...toGraphLeg(newPut, put.quantity, chain.asOf), kind: "option" },
  ]);
}

/**
 * Repair a LOSING two-leg vertical into a butterfly: the short strike
 * becomes the body (add one more short there) and a long wing is
 * added beyond it, mirroring the original long strike's distance.
 * Refuses a position that is not losing — repair is not a free
 * transform to apply to winning trades.
 */
export function repairVerticalToButterfly(
  graph: StrategyGraph,
  chain: ChainSnapshot,
  input: { currentPnlPerUnit: number }
): ComposeOutcome {
  if (!(input.currentPnlPerUnit < 0)) {
    return { ok: false, reason: `Position is not losing (P&L/unit ${input.currentPnlPerUnit}); repair refused.` };
  }
  const options = optionLegsOf(graph);
  if (options.length !== 2 || hasStockLeg(graph)) {
    return { ok: false, reason: "Repair requires a two-leg option vertical (no stock legs)." };
  }
  const [a, b] = options;
  if (a.optionType !== b.optionType || a.expiry !== b.expiry || a.strike === b.strike) {
    return { ok: false, reason: "Legs are not a single-expiry vertical of one option type." };
  }
  const long = a.quantity > 0 ? a : b;
  const short = a.quantity > 0 ? b : a;
  if (!(long.quantity > 0 && short.quantity < 0)) {
    return { ok: false, reason: "Vertical must be one long and one short leg." };
  }
  const unit = Math.min(Math.abs(long.quantity), Math.abs(short.quantity));
  const width = Math.abs(short.strike - long.strike);
  const wingTarget = short.strike + (short.strike > long.strike ? width : -width);
  const strikes = strikesInExpiry(chain, long.expiry, long.optionType);
  const wingStrike = strikes
    .filter((s) => (short.strike > long.strike ? s > short.strike : s < short.strike))
    .sort((x, y) => Math.abs(x - wingTarget) - Math.abs(y - wingTarget))[0];
  if (wingStrike === undefined) {
    return { ok: false, reason: `No strike beyond the short strike ${short.strike} to complete the butterfly.` };
  }
  const wing = findInExpiry(chain, long.expiry, long.optionType, (c) => c.find((x) => x.strike === wingStrike) ?? null);
  if (!wing) {
    return { ok: false, reason: "Butterfly wing contract has no valid quote." };
  }
  const legs: GraphLeg[] = [
    ...graph.legs,
    { ...short, quantity: -unit, kind: "option" as const },
    { ...toGraphLeg(wing, unit, chain.asOf), kind: "option" as const },
  ];
  return composed(graph, "repair", `${graph.id}->butterfly`, `${graph.label} repaired → Butterfly`, legs);
}

/**
 * Roll a structure: every option leg re-opens in the next later
 * expiry present in the chain (or `toExpiry`), optionally shifting
 * each strike by N chain steps. Stock legs carry over unchanged.
 */
export function roll(
  graph: StrategyGraph,
  chain: ChainSnapshot,
  opts: { toExpiry?: string; strikeShiftSteps?: number }
): ComposeOutcome {
  const shift = opts.strikeShiftSteps ?? 0;
  const expiries = [...chain.expiries].sort((x, y) => x.dte - y.dte);
  const out: GraphLeg[] = [];
  for (const leg of graph.legs) {
    if (leg.kind === "stock") {
      out.push(leg);
      continue;
    }
    let target: ChainSnapshot["expiries"][number] | undefined;
    if (opts.toExpiry) {
      target = expiries.find((e) => e.expiry === opts.toExpiry);
      if (!target) return { ok: false, reason: `Target expiry ${opts.toExpiry} is not in the chain.` };
    } else {
      const currentDte = chain.expiries.find((e) => e.expiry === leg.expiry)?.dte ?? leg.dte;
      target = expiries.find((e) => e.dte > currentDte);
      if (!target) {
        return { ok: false, reason: `No expiry later than ${leg.expiry} in the chain to roll into.` };
      }
    }
    const strikes = strikesInExpiry(chain, target.expiry, leg.optionType);
    const idx = strikes.indexOf(leg.strike);
    let targetStrike: number | undefined;
    if (idx >= 0) {
      targetStrike = strikes[idx + shift];
    } else {
      // Strike not listed in the target expiry: nearest available.
      targetStrike = [...strikes].sort((x, y) => Math.abs(x - leg.strike) - Math.abs(y - leg.strike))[0];
    }
    if (targetStrike === undefined) {
      return { ok: false, reason: `Strike shift ${shift} moves ${leg.optionType} ${leg.strike} off the chain in ${target.expiry}.` };
    }
    const contract = findInExpiry(chain, target.expiry, leg.optionType, (c) =>
      c.find((x) => x.strike === targetStrike) ?? null
    );
    if (!contract) {
      return { ok: false, reason: `No valid quote for ${leg.optionType} ${targetStrike} in ${target.expiry}.` };
    }
    out.push({ ...toGraphLeg(contract, leg.quantity, chain.asOf), kind: "option" });
  }
  return composed(
    graph,
    "roll",
    `${graph.id}@roll`,
    `${graph.label} (rolled${shift ? ` ${shift > 0 ? "+" : ""}${shift} strike${Math.abs(shift) === 1 ? "" : "s"}` : ""})`,
    out
  );
}

/* ------------------------------------------------------------------ */
/* Quant gate — the same gates catalog candidates pass                 */
/* ------------------------------------------------------------------ */

export interface CompositionConfig {
  /** Maximum number of legs in a composed candidate. */
  maxLegs: number;
  /** Undefined-risk compositions are rejected unless this is explicitly true. */
  allowUndefinedRisk: boolean;
}

export const DEFAULT_COMPOSITION_CONFIG: CompositionConfig = {
  maxLegs: 8,
  allowUndefinedRisk: false,
};

export interface GatedCandidate {
  status: IdeaStatus;
  economics: StructureEconomics;
  gateResults: GateResult[];
  reasons: string[];
  definedRisk: boolean;
  /** Contractual max loss × 100 for defined-risk structures; null when undefined-risk. */
  marginEstimate: number | null;
  assignmentRisk: boolean;
  limitations: string[];
}

export function gateComposedCandidate(input: {
  graph: StrategyGraph;
  /** Dominant economics family the real thesis gate evaluates (e.g. "iron_condor"). */
  structure: string;
  symbol: string;
  outlook: Outlook;
  thesis: string;
  spot: number;
  provenance: ChainProvenance;
  now: number;
  falsificationPresent: boolean;
  sources: string[];
  limitations?: string[];
  expectedMovePct?: number | null;
  eventRisk?: string | null;
  config?: CompositionConfig;
  researchConfig?: ResearchConfig;
  /** Precomputed economics from the pipeline builder (e.g. PMCC model). When absent, priced generically here. */
  economicsOverride?: StructureEconomics;
}): GatedCandidate {
  const compConfig = input.config ?? DEFAULT_COMPOSITION_CONFIG;
  const researchConfig = input.researchConfig ?? RESEARCH_CONFIG_DEFAULTS;
  const legs = optionLegsOf(input.graph);
  const risk = analyzeRisk(input.graph, researchConfig.assignmentRiskDte);
  const limitations = [...(input.limitations ?? [])];
  const compositionReasons: string[] = [];

  let economics: StructureEconomics;
  try {
    economics =
      input.economicsOverride ??
      composedStructureEconomics(input.structure, legs, input.spot, [
        `Composed from ${input.graph.parents.length ? input.graph.parents.join(" + ") : input.graph.id} via ${input.graph.operator ?? "catalog construction"}.`,
      ]);
  } catch (err) {
    return {
      status: "rejected",
      economics: {
        structure: input.structure,
        legs: [],
        netDebit: 0,
        netCredit: 0,
        maxLoss: 0,
        maxGain: null,
        breakevens: [],
        derivationNotes: [],
      },
      gateResults: [],
      reasons: [`Pricing failed: ${err instanceof Error ? err.message : String(err)}.`],
      definedRisk: risk.definedRisk,
      marginEstimate: null,
      assignmentRisk: risk.nearTermShortLegs.length > 0,
      limitations,
    };
  }

  if (input.graph.legs.length > compConfig.maxLegs) {
    compositionReasons.push(
      `Leg count ${input.graph.legs.length} exceeds the composition cap of ${compConfig.maxLegs}.`
    );
  }

  const stockLegs = hasStockLeg(input.graph);
  if (stockLegs) {
    limitations.push(
      "Contains stock legs: researchEconomics prices options only, so this candidate is reported Unverified rather than priced on its option legs alone."
    );
  }

  const outcome = runStageGates(
    {
      symbol: input.symbol,
      outlook: input.outlook,
      thesis: input.thesis,
      quote: { price: input.spot, timestamp: input.now, source: input.sources[0] ?? "discovery" },
      chain: { underlyingPrice: input.spot, asOf: input.now, provenance: input.provenance },
      legs,
      structure: input.structure,
      economics,
      expectedMovePct: input.expectedMovePct ?? null,
      eventRisk: input.eventRisk ?? null,
      hasNearTermShortLeg: risk.nearTermShortLegs.length > 0,
      sources: input.sources,
      limitations,
      falsificationPresent: input.falsificationPresent,
    },
    { config: researchConfig, now: input.now }
  );

  let status: IdeaStatus = outcome.status;
  const reasons: string[] = [...compositionReasons];
  if (outcome.rejectionReason) reasons.push(outcome.rejectionReason);

  if (compositionReasons.length > 0) status = "rejected";
  if (!risk.definedRisk) {
    if (!compConfig.allowUndefinedRisk) {
      status = "rejected";
      reasons.push(
        "Undefined-risk composition rejected by default (defined-risk is the default posture; explicit enablement required)."
      );
    } else if (status === "qualified") {
      status = "watchlist";
      reasons.push("Undefined-risk composition: explicitly enabled, capped at Watchlist.");
    }
  }
  if (stockLegs && status !== "rejected") {
    status = "unverified";
  }

  return {
    status,
    economics,
    gateResults: outcome.gateResults,
    reasons,
    definedRisk: risk.definedRisk,
    marginEstimate: risk.definedRisk ? Number((economics.maxLoss * 100).toFixed(2)) : null,
    assignmentRisk: risk.nearTermShortLegs.length > 0,
    limitations,
  };
}
