import type { StrategyLeg } from "../strategyEngine";
import { toLeg, toStockLeg } from "./legs";
import type { ChainView, GenerationResult, StrategyCategory, StrategyContext, StrategyDefinition } from "./types";
import type { OptionThesis } from "../strategyEngine";

export interface LegTemplate {
  type: "CALL" | "PUT" | "STOCK";
  side: "BUY" | "SELL";
  /** Contracts per leg (or 1 for stock, which uses ctx.stockShares). */
  qty?: number;
  /** Index into the ascending strike tuple. */
  k?: number;
  expiry?: "near" | "far";
}

export interface TemplateSpec {
  strikes: number;
  legs: LegTemplate[];
  /** equal: outer wings match; broken: unequal and not a skip-strike; skip: one wing is exactly twice the other; unequal: any difference. */
  wings?: "equal" | "broken" | "skip" | "unequal";
  /** Minimum DTE of the (single or near) expiry. */
  minDte?: number;
  /** Two-expiry structures: minimum DTE of the far expiry. */
  farMinDte?: number;
  /** Extra chain horizon to search beyond the minimum DTE floor. */
  searchMaxDte?: number;
  strikeFilter?: (strikes: number[], underlying: number) => boolean;
  /**
   * Issue #1654 slice 4: prefer combinations whose strikes sit near
   * the Fibonacci levels supplied on the StrategyContext (ctx.fibLevels).
   * Opt-in per spec — only the vertical debit/credit and butterfly
   * specs in catalog.ts set it, per the issue's target. When set AND
   * finite levels are supplied, proposals rank by mean distance of
   * each strike to its NEAREST Fib level (favoring spreads and
   * butterflies centered on a level); otherwise ranking is the
   * existing mean distance to spot. The flag alone changes nothing:
   * with no levels supplied the ranking is exactly today's, so the
   * wiring is dormant until slice 8's enrichment supplies levels.
   * It never invents strikes — every candidate still comes from the
   * loaded chain — and it is a preference, not a filter: a
   * combination far from every level can still win if nothing is
   * closer.
   */
  preferFibLevels?: boolean;
}

export interface TemplateStrategyOptions {
  id: string;
  label: string;
  category: StrategyCategory;
  description: string;
  aliases?: string[];
  theses: OptionThesis[];
  specs: TemplateSpec[];
  maxCombinations?: number;
}

const EPS = 1e-9;
const MAX_STRIKE_POOL = 20;
const MIN_EXPIRY_GAP_DAYS = 7;
const MAX_NEAR_EXPIRIES = 4;

function wingsMatch(mode: NonNullable<TemplateSpec["wings"]>, ks: number[]): boolean {
  const first = ks[1] - ks[0];
  const last = ks[ks.length - 1] - ks[ks.length - 2];
  const equal = Math.abs(first - last) < EPS;
  const skip = Math.abs(first * 2 - last) < EPS || Math.abs(last * 2 - first) < EPS;
  if (mode === "equal") return equal;
  if (mode === "skip") return skip;
  if (mode === "unequal") return !equal;
  return !equal && !skip;
}

function combinations(pool: number[], size: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, current: number[]) => {
    if (current.length === size) {
      out.push(current.slice());
      return;
    }
    for (let i = start; i < pool.length; i++) {
      current.push(pool[i]);
      walk(i + 1, current);
      current.pop();
    }
  };
  walk(0, []);
  return out;
}

function expiryPairs(spec: TemplateSpec, chains: ChainView[], multi: boolean, nearMaxDte: number): Array<{ near: ChainView; far?: ChainView }> {
  const eligibleNear = chains.filter((chain) =>
    chain.dte >= (spec.minDte ?? 0) && chain.dte <= nearMaxDte
  );
  if (!multi) return eligibleNear.map((near) => ({ near }));
  const pairs: Array<{ near: ChainView; far?: ChainView }> = [];
  for (const near of eligibleNear.slice(0, MAX_NEAR_EXPIRIES)) {
    for (const far of chains) {
      if (far.dte - near.dte >= MIN_EXPIRY_GAP_DAYS && far.dte >= (spec.farMinDte ?? 0) && near.dte >= (spec.minDte ?? 0)) {
        pairs.push({ near, far });
      }
    }
  }
  return pairs;
}

interface Proposal { legs: StrategyLeg[]; distance: number; tie: string }

function proposals(spec: TemplateSpec, ctx: StrategyContext): { items: Proposal[]; reason?: string } {
  const multi = spec.legs.some((leg) => leg.expiry === "far");
  const requestMaxDte = ctx.request.maxDte ?? Number.MAX_SAFE_INTEGER;
  // A strategy's catalog floor (e.g. LEAPS 365 DTE) overrides the
  // ordinary window for single-expiry strategies. A multi-expiry strategy
  // keeps maxDte on its near leg while farMinDte governs the long leg.
  const nearMaxDte = multi && spec.farMinDte !== undefined
    ? requestMaxDte
    : Math.max(requestMaxDte, spec.minDte ?? 0);
  const pairs = expiryPairs(spec, ctx.chains, multi, nearMaxDte);
  if (pairs.length === 0) {
    if (multi) return { items: [], reason: `Needs two expirations at least ${MIN_EXPIRY_GAP_DAYS} days apart${spec.farMinDte ? ` with the far leg at ${spec.farMinDte}+ DTE` : ""}; the loaded chain/DTE window does not provide them` };
    return { items: [], reason: `No expiration at ${spec.minDte}+ DTE in the loaded chain/DTE window` };
  }
  const items: Proposal[] = [];
  for (const { near, far } of pairs) {
    const chainFor = (leg: LegTemplate) => (leg.expiry === "far" ? far! : near);
    const optionLegs = spec.legs.filter((leg) => leg.type !== "STOCK");
    const strikeSets = [near, far].filter((chain): chain is ChainView => Boolean(chain)).map((chain) =>
      new Set([...chain.calls.keys(), ...chain.puts.keys()]));
    let pool = Array.from(new Set(strikeSets.flatMap((set) => Array.from(set)))).sort((a, b) => a - b);
    if (spec.strikes >= 3 && pool.length > MAX_STRIKE_POOL) {
      pool = pool.sort((a, b) => Math.abs(a - ctx.underlying) - Math.abs(b - ctx.underlying)).slice(0, MAX_STRIKE_POOL).sort((a, b) => a - b);
    }
    for (const ks of combinations(pool, spec.strikes)) {
      if (spec.wings && !wingsMatch(spec.wings, ks)) continue;
      if (spec.strikeFilter && !spec.strikeFilter(ks, ctx.underlying)) continue;
      const contracts = optionLegs.map((leg) => {
        const chain = chainFor(leg);
        return (leg.type === "CALL" ? chain.calls : chain.puts).get(ks[leg.k ?? 0]);
      });
      if (contracts.some((contract) => !contract)) continue;
      let optionIndex = 0;
      const legs = spec.legs.map((leg) => {
        if (leg.type === "STOCK") return toStockLeg(ctx.symbol, ctx.underlying, leg.side, ctx.stockShares * (leg.qty ?? 1), near.expiration);
        return toLeg(contracts[optionIndex++]!, leg.side, leg.qty ?? 1);
      });
      // Issue #1654 slice 4: Fib-aware ranking, opt-in per spec.
      // Finite levels only — non-finite entries are dropped, and
      // with no usable levels the ranking is exactly today's spot
      // distance. `distance` is only a sort key (see generate()),
      // so the absolute-dollar Fib distance needs no normalization.
      const fibLevels = spec.preferFibLevels
        ? (ctx.fibLevels ?? []).filter((level) => Number.isFinite(level))
        : [];
      const distance = fibLevels.length > 0
        ? ks.reduce((sum, strike) => sum + Math.min(...fibLevels.map((level) => Math.abs(strike - level))), 0) / ks.length
        : ks.reduce((sum, strike) => sum + Math.abs(strike - ctx.underlying), 0) / Math.max(ctx.underlying, 1);
      items.push({
        legs,
        distance,
        tie: `${near.dte}|${far?.dte ?? 0}|${ks.join(",")}`,
      });
    }
  }
  return { items };
}

/** Template Method + Factory: a declarative leg template becomes a full StrategyDefinition with shared generation logic. */
export function createTemplateStrategy(options: TemplateStrategyOptions): StrategyDefinition {
  const multiExpiry = options.specs.some((spec) => spec.legs.some((leg) => leg.expiry === "far"));
  const usesStock = options.specs.some((spec) => spec.legs.some((leg) => leg.type === "STOCK"));
  const requiredMaxDte = Math.max(
    0,
    ...options.specs.flatMap((spec) => [spec.minDte ?? 0, spec.farMinDte ?? 0]),
  );
  const dataHorizonDte = Math.max(
    requiredMaxDte,
    multiExpiry ? 365 : 0,
    ...options.specs.map((spec) => multiExpiry ? (spec.minDte ?? 0) + MIN_EXPIRY_GAP_DAYS : 0),
    ...options.specs.map((spec) => spec.searchMaxDte ?? 0),
  );
  return {
    id: options.id,
    label: options.label,
    category: options.category,
    description: options.description,
    aliases: options.aliases ?? [],
    theses: options.theses,
    usesStock,
    multiExpiry,
    ...(requiredMaxDte > 0 ? { requiredMaxDte } : {}),
    ...(dataHorizonDte > 0 ? { dataHorizonDte } : {}),
    generate(ctx, defaultMax): GenerationResult {
      const cap = options.maxCombinations ?? defaultMax;
      const all: Proposal[] = [];
      let reason: string | undefined;
      for (const spec of options.specs) {
        const result = proposals(spec, ctx);
        all.push(...result.items);
        reason = reason ?? result.reason;
      }
      if (all.length === 0) {
        return { sets: [], truncated: 0, skipReason: reason ?? "No valid leg combination exists in the loaded chain (required strikes or option types are missing)" };
      }
      all.sort((a, b) => a.distance - b.distance || a.tie.localeCompare(b.tie));
      return { sets: all.slice(0, cap).map((item) => item.legs), truncated: Math.max(0, all.length - cap) };
    },
  };
}
