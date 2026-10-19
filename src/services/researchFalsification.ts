/**
 * Issue #319 — hypothesis/falsification framework (spec §4) and pre-mortems
 * (spec §7). SDK-free.
 */

export interface FalsificationInput {
  symbol: string;
  outlook: string;
  thesis: string;
  /** Why the setup might work — the long side of the argument. */
  supportingEvidence: string[];
  /** What argues against it. */
  contradictingEvidence: string[];
  /** What would resolve the setup (catalyst/event). */
  resolutionTrigger: string;
  /** Horizon, e.g. "30-45 DTE". */
  horizon: string;
  /** Explicit invalidation condition. */
  invalidation: string;
  /** Why this options structure over shares/another structure/no trade. */
  whyThisStructure: string;
}

export interface Falsification {
  /** 1. What is the thesis? */
  thesis: string;
  /** 2. Why might the market's current expectations be wrong? */
  whyMarketWrong: string;
  /** 3. What could cause the setup to resolve? */
  resolutionTrigger: string;
  /** 4. Over what time horizon? */
  horizon: string;
  /** 5. What evidence contradicts the thesis? */
  contradictingEvidence: string[];
  /** 6. What would invalidate it? */
  invalidation: string;
  /** 7. Why this structure over shares/another structure/no trade? */
  whyThisStructure: string;
}

/**
 * Build the seven falsification answers. Contradicting evidence is REQUIRED:
 * a candidate with none is flagged, never silently passed (spec §4: single
 * signals like high short interest / elevated IV / unusual volume / 52-week
 * proximity are never sufficient evidence by themselves).
 */
export function buildFalsification(input: FalsificationInput): {
  falsification: Falsification;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (input.contradictingEvidence.length === 0) {
    warnings.push(
      "No contradicting evidence supplied — thesis is one-sided; treat with skepticism."
    );
  }
  const thinSignals = [
    "high short interest",
    "elevated iv",
    "unusual options volume",
    "52-week high",
    "52-week low",
  ];
  const supportText = input.supportingEvidence.join(" ").toLowerCase();
  const onlyThin = thinSignals.some((s) => supportText.includes(s)) &&
    input.supportingEvidence.length <= 1;
  if (onlyThin) {
    warnings.push(
      "Supporting evidence rests on a single thin signal (short interest / IV / unusual volume / 52-week proximity) — insufficient per spec §4."
    );
  }
  return {
    falsification: {
      thesis: input.thesis,
      whyMarketWrong: `Market pricing implies a different expected path than the thesis; the edge is the gap between the thesis evidence and what is priced into the options. ${input.thesis}`,
      resolutionTrigger: input.resolutionTrigger,
      horizon: input.horizon,
      contradictingEvidence: input.contradictingEvidence,
      invalidation: input.invalidation,
      whyThisStructure: input.whyThisStructure,
    },
    warnings,
  };
}

export type PremortemCategory =
  | "directional_failure"
  | "incorrect_timing"
  | "volatility_repricing"
  | "poor_execution"
  | "event_gap"
  | "early_assignment"
  | "correlated_exposure";

export interface PremortemCause {
  category: PremortemCategory;
  description: string;
}

export interface Premortem {
  assumedFailure: string;
  causes: PremortemCause[];
}

/**
 * Spec §7 pre-mortem: "Assume this idea loses money. What most plausibly
 * caused it?" Covers every listed category; portfolio-dependent items are
 * marked unassessed when no portfolio data exists.
 */
export function buildPremortem(input: {
  symbol: string;
  structure: string;
  hasShortLeg: boolean;
  eventRisk: string | null;
  maxLoss: number;
}): Premortem {
  const causes: PremortemCause[] = [
    {
      category: "directional_failure",
      description: `Underlying moves against the thesis beyond the structure's profitable range; loss capped at the contractual max of $${input.maxLoss.toFixed(2)} per unit.`,
    },
    {
      category: "incorrect_timing",
      description:
        "Thesis direction right but resolution arrives after expiry — theta decay consumes the premium.",
    },
    {
      category: "volatility_repricing",
      description:
        "IV collapses after entry (e.g. post-event crush), eroding long-premium structures even if direction is right.",
    },
    {
      category: "poor_execution",
      description:
        "Wide spreads or thin volume force fills far from mid; slippage exceeds the modeled assumption.",
    },
    {
      category: "event_gap",
      description: input.eventRisk
        ? `Known event risk: ${input.eventRisk} — an overnight gap can skip stop levels entirely.`
        : "No dated catalyst on file; an unscheduled gap (guidance, macro shock) remains possible.",
    },
    {
      category: "early_assignment",
      description: input.hasShortLeg
        ? "Short American-style legs can be assigned early, especially around ex-dividend dates or deep ITM into expiry."
        : "No short legs — early assignment not applicable.",
    },
    {
      category: "correlated_exposure",
      description:
        "Portfolio information unavailable — correlated exposure across ideas is UNASSESSED; size each idea standalone.",
    },
  ];
  return {
    assumedFailure: `Assume the ${input.symbol} ${input.structure} loses money.`,
    causes,
  };
}
