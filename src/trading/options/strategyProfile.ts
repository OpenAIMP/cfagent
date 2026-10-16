/**
 * Saved Strategy Profiles (issue #28) — "my strategy" as a named,
 * reusable, versioned object.
 *
 * A profile captures the constraints a user otherwise re-derives ad hoc
 * from every prompt: thesis style, allowed strategy types, max loss cap,
 * target reward/risk floor, DTE window, event policy, IV view, bias, the
 * scan posture (risk profile / mode), and fit-gate thresholds (issue
 * #24). Profiles are stored per user (strategyProfileStore.ts) and can be
 * selected from NLQ ("scan my watchlist against my income profile"), the
 * unified options API (profileId / profileName), or the REST CRUD routes.
 *
 * Application semantics are layered and deterministic: the profile forms
 * the BASE layer; fields the caller expressed in the request itself
 * ("explicit" fields, declared by each call site) always win over the
 * profile. The merge core (applyProfileFields) is shared by the scanner,
 * the NLQ single-name path, and the unified service so every surface
 * applies a profile identically, and the applied profile is stamped into
 * scan provenance (OpportunityScanResult.profileRef +
 * requestSnapshot.profile) so verdicts stay comparable across sessions.
 *
 * Discovery's Phase-2 use of profiles as a ranking bias is NOT this
 * module's concern (issue #28 scope note).
 */

import { defaultRegistry } from "./strategies/catalog";
import type { ExpectedIvDirection, OptionStrategyType, OptionThesis, StrategyRequest } from "./strategyEngine";
import type { RiskProfile } from "./recommendationAgent";
import type { FitGateParams, ScanMode } from "./opportunityScanner";

/** The user-authored fields of a saved profile. EVERY field is optional:
 * a profile constrains only what it sets. */
export interface StrategyProfileSpec {
  thesis?: OptionThesis;
  allowedStrategies?: OptionStrategyType[];
  maxPlannedLoss?: number;
  minRewardRisk?: number;
  minDte?: number;
  maxDte?: number;
  eventPolicy?: "warn" | "exclude";
  expectedIvDirection?: ExpectedIvDirection;
  optimizationBias?: number;
  /** Scan posture (issue #23 vocabulary): applied unless the caller declares its own. */
  riskProfile?: RiskProfile;
  /** Scan posture (issue #23): applied unless the caller declares its own. */
  mode?: ScanMode;
  /** Fit-gate thresholds (issue #24), layered under per-call gate overrides. */
  fitGate?: Partial<FitGateParams>;
}

/** A stored profile: the spec plus identity, ownership, and versioning. */
export interface StrategyProfile extends StrategyProfileSpec {
  id: string;
  userLogin: string;
  name: string;
  /** Starts at 1; every update replaces the spec and bumps this by one. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** The compact provenance stamp carried on scan results (issue #27/#28). */
export interface ProfileRef {
  id: string;
  name: string;
  version: number;
}

export function toProfileRef(profile: StrategyProfile): ProfileRef {
  return { id: profile.id, name: profile.name, version: profile.version };
}

/**
 * The StrategyRequest-level fields a profile can supply, in the FIXED
 * order used for appliedFields and the disclosure line. statedTarget /
 * perSymbol are scan-template fields, not StrategyRequest fields, and are
 * never touched by a profile; riskProfile / mode / fitGate are option-
 * level and are layered by the scanner itself, not by this merge.
 */
export const PROFILE_REQUEST_FIELDS = [
  "thesis",
  "allowedStrategies",
  "maxPlannedLoss",
  "minRewardRisk",
  "minDte",
  "maxDte",
  "eventPolicy",
  "expectedIvDirection",
  "optimizationBias",
] as const;

const CONFIDENCE_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;

/**
 * Validate a profile name + spec. Returns the FIRST error message, or
 * null when valid. Strategy-type ids are checked against the live
 * registry (candidate `type` values are registry definition ids); the
 * registry's "all" sentinel is also accepted.
 */
export function validateStrategyProfile(name: string, spec: StrategyProfileSpec): string | null {
  if (!name || !name.trim()) {
    return "Profile name is required.";
  }
  if (spec.allowedStrategies !== undefined) {
    const known = new Set<string>(defaultRegistry.list().map((def) => def.id));
    known.add("all");
    for (const entry of spec.allowedStrategies) {
      if (!known.has(entry)) {
        return `Unknown strategy type "${entry}" in allowedStrategies.`;
      }
    }
  }
  if (spec.maxPlannedLoss !== undefined && (!Number.isFinite(spec.maxPlannedLoss) || spec.maxPlannedLoss <= 0)) {
    return "maxPlannedLoss must be greater than 0.";
  }
  if (spec.minRewardRisk !== undefined && (!Number.isFinite(spec.minRewardRisk) || spec.minRewardRisk < 0)) {
    return "minRewardRisk must be 0 or greater.";
  }
  if (spec.minDte !== undefined && (!Number.isFinite(spec.minDte) || spec.minDte < 0)) {
    return "minDte must be 0 or greater.";
  }
  if (spec.maxDte !== undefined && (!Number.isFinite(spec.maxDte) || spec.maxDte < 0)) {
    return "maxDte must be 0 or greater.";
  }
  if (spec.minDte !== undefined && spec.maxDte !== undefined && spec.minDte > spec.maxDte) {
    return "minDte must not exceed maxDte.";
  }
  if (spec.optimizationBias !== undefined && (!Number.isFinite(spec.optimizationBias) || spec.optimizationBias < 0 || spec.optimizationBias > 100)) {
    return "optimizationBias must be between 0 and 100.";
  }
  const gate = spec.fitGate;
  if (gate) {
    if (gate.minCompositeScore !== undefined && (!Number.isFinite(gate.minCompositeScore) || gate.minCompositeScore < 0 || gate.minCompositeScore > 100)) {
      return "fitGate.minCompositeScore must be between 0 and 100.";
    }
    if (gate.minProbabilityOfProfit !== undefined && (!Number.isFinite(gate.minProbabilityOfProfit) || gate.minProbabilityOfProfit < 0 || gate.minProbabilityOfProfit > 1)) {
      return "fitGate.minProbabilityOfProfit must be between 0 and 1.";
    }
    if (gate.minConfidence !== undefined && !(CONFIDENCE_LEVELS as readonly string[]).includes(gate.minConfidence)) {
      return "fitGate.minConfidence must be one of LOW, MEDIUM, HIGH.";
    }
  }
  return null;
}

/**
 * The shared profile-merge core (pure). For each StrategyRequest-level
 * field the profile sets: when the field is NOT in `explicit` (the set of
 * field names the caller declares as request-expressed), the profile's
 * value replaces the base's; explicit fields keep the base value.
 * `appliedFields` lists exactly the fields taken from the profile, in
 * PROFILE_REQUEST_FIELDS order.
 */
export function applyProfileFields<T extends Partial<StrategyRequest>>(
  base: T,
  profile: StrategyProfile,
  explicit: ReadonlySet<string>,
): { merged: T; appliedFields: string[] } {
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const source = profile as StrategyProfileSpec;
  const appliedFields: string[] = [];
  for (const field of PROFILE_REQUEST_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (explicit.has(field)) continue;
    merged[field] = value;
    appliedFields.push(field);
  }
  return { merged: merged as T, appliedFields };
}

function gatePct(fraction: number): string {
  return (fraction * 100).toFixed(1).replace(/\.0$/, "");
}

/**
 * One deterministic disclosure line naming the profile, its version, and
 * the constraints it actually contributed — used in scan assumptions and
 * NLQ summaries so a reader can always tell which "my strategy" produced
 * a verdict. Clauses appear in a fixed order — thesis, loss cap,
 * reward/risk floor, DTE window, event policy, IV view, bias, strategy
 * types — with the fit gate last. When nothing was taken from the
 * profile the line says so.
 */
export function profileDisclosure(profile: StrategyProfile, appliedFields: string[], gateApplied: boolean): string {
  const applied = new Set(appliedFields);
  const clauses: string[] = [];
  if (applied.has("thesis") && profile.thesis !== undefined) {
    clauses.push(`thesis ${profile.thesis}`);
  }
  if (applied.has("maxPlannedLoss") && profile.maxPlannedLoss !== undefined) {
    clauses.push(`max planned loss $${profile.maxPlannedLoss}`);
  }
  if (applied.has("minRewardRisk") && profile.minRewardRisk !== undefined) {
    clauses.push(`min reward/risk ${profile.minRewardRisk}`);
  }
  if ((applied.has("minDte") || applied.has("maxDte")) && (profile.minDte !== undefined || profile.maxDte !== undefined)) {
    if (profile.minDte !== undefined && profile.maxDte !== undefined) {
      clauses.push(`DTE ${profile.minDte}–${profile.maxDte}`);
    } else if (profile.minDte !== undefined) {
      clauses.push(`DTE ≥${profile.minDte}`);
    } else {
      clauses.push(`DTE ≤${profile.maxDte}`);
    }
  }
  if (applied.has("eventPolicy") && profile.eventPolicy !== undefined) {
    clauses.push(`event policy ${profile.eventPolicy}`);
  }
  if (applied.has("expectedIvDirection") && profile.expectedIvDirection !== undefined) {
    clauses.push(`IV direction ${profile.expectedIvDirection}`);
  }
  if (applied.has("optimizationBias") && profile.optimizationBias !== undefined) {
    clauses.push(`optimization bias ${profile.optimizationBias}`);
  }
  if (applied.has("allowedStrategies") && profile.allowedStrategies !== undefined && profile.allowedStrategies.length > 0) {
    clauses.push(`types: ${profile.allowedStrategies.join(", ")}`);
  }
  if (gateApplied && profile.fitGate) {
    const gateClauses: string[] = [];
    if (profile.fitGate.minCompositeScore !== undefined) gateClauses.push(`min score ${profile.fitGate.minCompositeScore}`);
    if (profile.fitGate.minProbabilityOfProfit !== undefined) gateClauses.push(`min POP ${gatePct(profile.fitGate.minProbabilityOfProfit)}%`);
    if (profile.fitGate.requireFresh !== undefined) gateClauses.push(profile.fitGate.requireFresh ? "fresh quotes required" : "fresh quotes not required");
    if (profile.fitGate.minConfidence !== undefined) gateClauses.push(`min confidence ${profile.fitGate.minConfidence}`);
    if (gateClauses.length > 0) clauses.push(`fit gate: ${gateClauses.join(", ")}`);
  }
  const head = `Strategy profile "${profile.name}" (v${profile.version}) applied`;
  return clauses.length > 0 ? `${head} — ${clauses.join(", ")}.` : `${head} (no constraints set).`;
}
