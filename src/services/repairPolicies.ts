/**
 * RepairPolicy — one proposal contract for portfolio repair
 * (issue #1361, epic #1151 slice C5; #1257 family rationalization).
 *
 * Repair existed at two levels with an unfactored boundary:
 * - RatioRepair (#355): position-level proposals for underwater long
 *   stock, computed from the book (RepairAnalysis).
 * - CompositionRepair: structure-level repair/roll operators, handed to
 *   the bundle as pre-computed CompositionRepairInput values.
 * Both are now RepairPolicy implementations over the ONE RepairOption
 * contract; the bundle consumes policies, not modules. All mappings
 * moved verbatim from buildRecommendationBundle, so bundle output is
 * unchanged.
 *
 * Issue #1642 DECISION (parent #1638, doc §6): explicit two-level
 * contract over one proposal contract — NOT a single merged repair
 * model. The levels are semantically different operations (ratio
 * repair measures breakeven/max-recovery with no directly measurable
 * risk removed; composition repair measures max-loss reduction when
 * the composition gate measured it), so merging them would invent a
 * number for one level or discard the other's measurement. This
 * module IS the decision implemented; #1642 ratifies it, hardens it
 * (composition costs clamp at zero, matching the ratio policy), and
 * pins its caller map (tests/repair_contract_p1642.test.ts).
 * Caller map: bundle → buildRepairOptions (only RepairOption
 * consumer); generateRepairProposals is the position producer (bundle
 * route input + standalone analyze endpoint); strategyComposition
 * operators are construction uses, never proposal inputs — this
 * policy takes priced inputs only and never imports that module.
 * Known limitation: no production caller currently supplies
 * compositionRepairs to the bundle (tests only); the composition
 * policy is dormant-by-design until its first producer lands.
 */
import type { RepairAnalysis } from "./repairProposals";
import { round2 } from "./cvarOptimizer";

/** One repair proposal, as the bundle presents it. */
export interface RepairOption {
  kind: "ratio_repair" | "composition";
  label: string;
  costDollars: number;
  riskRemovedDollars: number | null;
  /** riskRemoved − cost when risk removed is known; otherwise −cost
   *  (cost-first among unknowns) — the basis is stated per option. */
  rankScore: number;
  rankBasis: string;
  noDownsideProtection?: boolean;
  detail: string;
}

/** A pre-computed composition repair/roll candidate (caller-supplied). */
export interface CompositionRepairInput {
  label: string;
  costDollars: number;
  /** Contractual max-loss reduction in dollars, when the composition
   *  gate measured it; omit when unknown (ranked cost-first, flagged). */
  riskRemovedDollars?: number;
  detail: string;
}

export interface RepairPolicyInput {
  repairAnalysis?: RepairAnalysis | null;
  compositionRepairs?: CompositionRepairInput[];
}

/** A repair policy: one level of repair, one proposal contract. */
export interface RepairPolicy {
  readonly policyKind: RepairOption["kind"];
  options(input: RepairPolicyInput): RepairOption[];
}

/** #355 ratio repairs: position-level proposals from the book. */
export class RatioRepairPolicy implements RepairPolicy {
  readonly policyKind = "ratio_repair" as const;

  options(input: RepairPolicyInput): RepairOption[] {
    return (input.repairAnalysis?.proposals ?? []).map((p) => {
      const cost = round2(Math.max(0, p.netDebitPerUnit) * 100 * p.units);
      return {
        kind: "ratio_repair" as const,
        label: `${p.symbol} 1x2 call ratio repair (breakeven → $${p.breakevenAtExpiry})`,
        costDollars: cost,
        riskRemovedDollars: null,
        rankScore: -cost,
        rankBasis:
          "Risk removed not directly measurable for the #355 ratio repair (it states breakeven/max-recovery, no downside protection); ranked cost-first among unknowns.",
        noDownsideProtection: p.noDownsideProtection,
        detail: p.rationale,
      };
    });
  }
}

/** Composition repairs: structure-level candidates from the caller. */
export class CompositionRepairPolicy implements RepairPolicy {
  readonly policyKind = "composition" as const;

  options(input: RepairPolicyInput): RepairOption[] {
    // Issue #1642: costs clamp at zero, matching RatioRepairPolicy
    // (which clamps via Math.max(0, ...)). A negative caller-supplied
    // cost must never inflate rankScore. The unknown-risk branch
    // normalizes -0 to 0 so money fields never carry signed zero.
    return (input.compositionRepairs ?? []).map((r) => {
      const cost = Math.max(0, r.costDollars);
      return {
      kind: "composition" as const,
      label: r.label,
      costDollars: cost,
      riskRemovedDollars: r.riskRemovedDollars ?? null,
      rankScore:
        r.riskRemovedDollars !== undefined
          ? round2(r.riskRemovedDollars - cost)
          : cost === 0 ? 0 : -cost,
      rankBasis:
        r.riskRemovedDollars !== undefined
          ? "Ranked by risk removed minus cost (composition gate measurement)."
          : "Risk removed unknown; ranked cost-first among unknowns.",
      detail: r.detail,
      };
    });
  }
}

/** The default policy set: both repair levels, in contract order. */
export const DEFAULT_REPAIR_POLICIES: RepairPolicy[] = [
  new RatioRepairPolicy(),
  new CompositionRepairPolicy(),
];

/** Per-level provenance for one policy level's contribution. */
export interface RepairLevelMarker {
  /** Whether this level's input was supplied at all (as opposed to
   *  supplied-but-empty, or never supplied). A ratio level counts
   *  as supplied when a non-null analysis was passed; a
   *  composition level counts as supplied when an array was
   *  passed, even an empty one. */
  supplied: boolean;
  /** How many options this level contributed to the ranking. */
  optionCount: number;
}

/** Per-level markers, keyed by policy kind. */
export type RepairLevelsMarker = {
  [K in RepairOption["kind"]]: RepairLevelMarker;
};

/**
 * Run every policy and rank the combined options (rankScore desc,
 * label asc). Status keys on the inputs being supplied, exactly as
 * the builder did: a supplied-but-empty analysis still counts as
 * supplied — the absence of proposals is data, not a missing input.
 *
 * #1732 (PR-2 visible marker): the return also carries `levels`,
 * the per-level marker. Before this slice a bundle consumer could
 * not tell from output alone that the composition leg is
 * structurally empty in production (no production caller supplies
 * compositionRepairs — tests only): a zero-option composition leg
 * looked identical whether it was never supplied or supplied and
 * empty. The marker is additive only — `status` and `options`
 * are unchanged for every input.
 */
export function buildRepairOptions(
  input: RepairPolicyInput,
  policies: RepairPolicy[] = DEFAULT_REPAIR_POLICIES,
): {
  status: "proposals" | "none_supplied";
  options: RepairOption[];
  levels: RepairLevelsMarker;
} {
  const perPolicy = policies.map((policy) => ({
    policyKind: policy.policyKind,
    options: policy.options(input),
  }));
  const options = perPolicy.flatMap((p) => p.options);
  options.sort((a, b) => b.rankScore - a.rankScore || a.label.localeCompare(b.label));
  const levels = {
    ratio_repair: {
      supplied: input.repairAnalysis !== null && input.repairAnalysis !== undefined,
      optionCount: perPolicy
        .filter((p) => p.policyKind === "ratio_repair")
        .reduce((n, p) => n + p.options.length, 0),
    },
    composition: {
      supplied: input.compositionRepairs !== undefined,
      optionCount: perPolicy
        .filter((p) => p.policyKind === "composition")
        .reduce((n, p) => n + p.options.length, 0),
    },
  } satisfies RepairLevelsMarker;
  return {
    status:
      input.repairAnalysis || (input.compositionRepairs?.length ?? 0) > 0
        ? "proposals"
        : "none_supplied",
    options,
    levels,
  };
}
