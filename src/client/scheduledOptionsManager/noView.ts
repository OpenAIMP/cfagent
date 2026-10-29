import type { NoViewConstraintsDraft } from "./types";
import { DISCOVERY_REQUEST_LIMIT } from "./discoveryRequests";
import { DERIVED_SYMBOL_RE, parseDerivedSymbols } from "./profileDerived";

/** The mode's default POP floor (NO_VIEW_DEFAULT_MIN_PROBABILITY_OF_PROFIT,
 *  src/trading/options/strategyEngine.ts — the scanner fit-gate precedent). */
export const NO_VIEW_DEFAULT_MIN_POP = 0.35;

export function blankNoViewConstraintsDraft(): NoViewConstraintsDraft {
  return {
    symbolsText: "",
    maxPlannedLoss: "",
    minRewardRisk: "",
    minProbabilityOfProfit: String(NO_VIEW_DEFAULT_MIN_POP),
    minDte: "",
    maxDte: "",
    riskProfile: "balanced",
  };
}

/**
 * Build the no-view schedule payload (issue #534) from the form
 * state: one constraint set per symbol, every set sharing the edited
 * constraints — the exact shape the create route validates at arm
 * time (payload.constraintSets, each entry a NoViewStrategyRequest).
 * The route's rules are mirrored client-side (symbol cap + ticker
 * shape from the derived model; the numeric rules from
 * validateNoViewRequest) so a bad value fails in the form; the
 * route remains the backstop and its 400 surfaces verbatim. A
 * constraint set carries NO thesis/target fields, ever — the
 * builder has no way to emit one.
 */
export function buildNoViewPayload(
  draft: NoViewConstraintsDraft
): { payload: Record<string, any> } | { error: string } {
  const symbols = parseDerivedSymbols(draft.symbolsText);
  if (symbols.length === 0) {
    return { error: "Enter at least one symbol for the no-view constraint sets." };
  }
  if (symbols.length > DISCOVERY_REQUEST_LIMIT) {
    return {
      error: `No-view discovery schedules are capped at ${DISCOVERY_REQUEST_LIMIT} symbols per schedule.`,
    };
  }
  const bad = symbols.find((s) => !DERIVED_SYMBOL_RE.test(s));
  if (bad) return { error: `"${bad}" is not a valid ticker symbol.` };
  const maxPlannedLoss = Number(draft.maxPlannedLoss);
  if (!Number.isFinite(maxPlannedLoss) || maxPlannedLoss <= 0) {
    return { error: "Max planned loss must be a positive number." };
  }
  const minRewardRisk = Number(draft.minRewardRisk);
  if (!Number.isFinite(minRewardRisk) || minRewardRisk < 0) {
    return { error: "Minimum reward/risk must be zero or more." };
  }
  const minProbabilityOfProfit =
    draft.minProbabilityOfProfit.trim() === ""
      ? NO_VIEW_DEFAULT_MIN_POP
      : Number(draft.minProbabilityOfProfit);
  if (
    !Number.isFinite(minProbabilityOfProfit) ||
    minProbabilityOfProfit <= 0 ||
    minProbabilityOfProfit > 1
  ) {
    return { error: "Minimum probability of profit must be more than 0 and at most 1 (e.g. 0.35)." };
  }
  let minDte: number | undefined;
  if (draft.minDte.trim() !== "") {
    minDte = Number(draft.minDte);
    if (!Number.isInteger(minDte) || minDte < 1) {
      return { error: "Min DTE must be a whole number of at least 1." };
    }
  }
  let maxDte: number | undefined;
  if (draft.maxDte.trim() !== "") {
    maxDte = Number(draft.maxDte);
    if (!Number.isInteger(maxDte) || maxDte < 1) {
      return { error: "Max DTE must be a whole number of at least 1." };
    }
  }
  if (minDte !== undefined && maxDte !== undefined && maxDte < minDte) {
    return { error: "Max DTE must be at least the min DTE." };
  }
  const constraintSets = symbols.map((symbol) => ({
    symbol,
    maxPlannedLoss,
    minRewardRisk,
    minProbabilityOfProfit,
    riskProfile: draft.riskProfile,
    ...(minDte !== undefined ? { minDte } : {}),
    ...(maxDte !== undefined ? { maxDte } : {}),
  }));
  return { payload: { inputModel: "no-view", constraintSets } };
}

/** The constraint fields the no-view editor edits once for all
 *  symbols — the fields hydration compares across a stored
 *  schedule's sets to decide whether they still share one editor
 *  state. Absent optionals normalize to the mode's defaults (POP
 *  floor 0.35, risk profile "balanced", no DTE bound). */
function noViewSharedFields(set: any): Record<string, unknown> {
  return {
    maxPlannedLoss: typeof set?.maxPlannedLoss === "number" ? set.maxPlannedLoss : null,
    minRewardRisk: typeof set?.minRewardRisk === "number" ? set.minRewardRisk : null,
    minProbabilityOfProfit:
      typeof set?.minProbabilityOfProfit === "number"
        ? set.minProbabilityOfProfit
        : NO_VIEW_DEFAULT_MIN_POP,
    minDte: typeof set?.minDte === "number" ? set.minDte : null,
    maxDte: typeof set?.maxDte === "number" ? set.maxDte : null,
    riskProfile:
      set?.riskProfile === "conservative" || set?.riskProfile === "aggressive"
        ? set.riskProfile
        : "balanced",
  };
}

/**
 * Hydrate the no-view editor from a stored schedule's constraint
 * sets (issue #534). The form edits ONE shared constraint set, so
 * the draft takes the first set's constraints and the symbol list;
 * `shared` reports whether every set carries those same constraints.
 * When it doesn't, the form says so (the schedule was armed with
 * per-symbol constraints) and saving re-arms every symbol with the
 * values shown — the divergence is surfaced, never silently
 * flattened.
 */
export function noViewDraftFromConstraintSets(
  sets: any[]
): { draft: NoViewConstraintsDraft; shared: boolean } {
  const list = Array.isArray(sets) ? sets.filter((s) => s && typeof s === "object") : [];
  const draft = blankNoViewConstraintsDraft();
  draft.symbolsText = list
    .map((s) => (typeof s.symbol === "string" ? s.symbol : ""))
    .filter(Boolean)
    .join(", ");
  if (list.length === 0) return { draft, shared: true };
  const first = noViewSharedFields(list[0]);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  draft.maxPlannedLoss = num(first.maxPlannedLoss);
  draft.minRewardRisk = num(first.minRewardRisk);
  draft.minProbabilityOfProfit = num(first.minProbabilityOfProfit);
  draft.minDte = num(first.minDte);
  draft.maxDte = num(first.maxDte);
  draft.riskProfile = first.riskProfile as NoViewConstraintsDraft["riskProfile"];
  const shared = list.every((s) => {
    const f = noViewSharedFields(s);
    return (Object.keys(first) as Array<keyof typeof first>).every((k) => f[k] === first[k]);
  });
  return { draft, shared };
}

/** One-line summary of a stored constraint set for schedule rows and
 *  the Details dialog (#2329): caps, floors, DTE window, risk profile —
 *  constraints only, there is no view to summarize. */
export function formatNoViewConstraints(set: any): string {
  if (!set || typeof set !== "object") return "—";
  const parts: string[] = [];
  if (typeof set.maxPlannedLoss === "number") parts.push(`max loss $${set.maxPlannedLoss}`);
  if (typeof set.minRewardRisk === "number") parts.push(`min R/R ${set.minRewardRisk}×`);
  const pop =
    typeof set.minProbabilityOfProfit === "number"
      ? set.minProbabilityOfProfit
      : NO_VIEW_DEFAULT_MIN_POP;
  parts.push(`POP ≥ ${Math.round(pop * 100)}%`);
  if (typeof set.minDte === "number" && typeof set.maxDte === "number") {
    parts.push(`DTE ${set.minDte}–${set.maxDte}`);
  } else if (typeof set.maxDte === "number") {
    parts.push(`DTE ≤${set.maxDte}`);
  } else if (typeof set.minDte === "number") {
    parts.push(`DTE ≥${set.minDte}`);
  }
  if (typeof set.riskProfile === "string") parts.push(set.riskProfile);
  return parts.length > 0 ? parts.join(" · ") : "—";
}
