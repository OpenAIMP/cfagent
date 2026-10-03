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
  strikeFilter?: (strikes: number[], underlying: number) => boolean;
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

function expiryPairs(spec: TemplateSpec, chains: ChainView[], multi: boolean): Array<{ near: ChainView; far?: ChainView }> {
  const eligibleNear = chains.filter((chain) => chain.dte >= (spec.minDte ?? 0));
  if (!multi) return eligibleNear.map((near) => ({ near }));
  const pairs: Array<{ near: ChainView; far?: ChainView }> = [];
  for (const near of chains.slice(0, MAX_NEAR_EXPIRIES)) {
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
  const pairs = expiryPairs(spec, ctx.chains, multi);
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
      items.push({
        legs,
        distance: ks.reduce((sum, strike) => sum + Math.abs(strike - ctx.underlying), 0) / Math.max(ctx.underlying, 1),
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
  return {
    id: options.id,
    label: options.label,
    category: options.category,
    description: options.description,
    aliases: options.aliases ?? [],
    theses: options.theses,
    usesStock,
    multiExpiry,
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
