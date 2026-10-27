/**
 * #1732 (parent #1717, slice (l)): portfolio repair remainders
 * (scan appendix (l) findings PR-1, PR-2, PR-3; PR-4 IDENTICAL,
 * pin only) — the PAYMENTS_FLOW_MODE (#1711) / FOSS_* (#1727) /
 * report-generator (#1731) pattern applied to this domain, with
 * one deliberate difference, following the #1729 / #1730 / #1731
 * precedent: this slice adds NO runtime switch. Pure module: no
 * Cloudflare imports, no I/O, no network — the registry is data,
 * and the tests in
 * tests/portfolio_repair_remainders_modes_1732.test.ts pin the
 * behavior distinctions it records (port-first, cfagent blueprint
 * #1795/#1798 restated wording: cloud-native but cloud-agnostic).
 *
 * WHY NO SWITCH (read before adding one): every divergent pair
 * in appendix (l) is divergent-by-design, and the #1642 decision
 * ratifies the two repair models coexisting — switch, don't
 * delete, and do not re-merge without a new owner decision. A
 * switch over PR-1 would be a merged-model switch: it would have
 * to invent a risk-removed number for the ratio level or discard
 * the composition level's measured max-loss reduction. A switch
 * over PR-2's producer on/off would be a phantom switch: no
 * producer exists yet, so no call site could honor both values
 * and its tests would pass trivially by construction — the
 * switch belongs to the slice that lands the first producer,
 * with that producer's own Red evidence. A switch over PR-3
 * would silently change a named endpoint's failure contract
 * (analyze fail-loud vs bundle swallow) without an owner
 * decision naming which endpoint changed and why. Each pin
 * below names the flip that must NOT happen and why. A future
 * slice that finds a genuine single call site with both paths
 * present must add its switch here (and grow
 * PORTFOLIO_REPAIR_1732_SWITCHES) with its own Red evidence —
 * it must not silently flip a pin.
 *
 * Consequences of having no switch in this slice:
 * - There is NO env var to declare (src/types.ts untouched),
 *   NO production value for the owner to set, and NO
 *   config_error event: there is no switch value that could
 *   fail closed. The scoped resolution order (run > session >
 *   user > global env > built-in) has nothing to resolve here;
 *   each pin's `defaultBehavior` IS the current public-route
 *   behavior, recorded explicitly so the owner can overturn
 *   any pin later by a deliberate decision, not by a flag.
 * - No endpoint is removed, no code path is deleted, no store
 *   is merged, no new store/engine is introduced. NEVER
 *   EITHER/OR is honored by keeping both paths in every pair.
 * - The security guard holds trivially and absolutely: no
 *   caller can configure away any enforcement through this
 *   module, because this module configures nothing. IAAA gate
 *   switches, if any are ever touched here, stay
 *   admin/platform-controlled, default fail-closed, never
 *   user/session-configurable by the gated subject.
 *
 * The ONE executable change in this slice (not a switch): the
 * PR-2 visible marker. `buildRepairOptions` in
 * src/services/repairPolicies.ts now returns a per-level marker
 * (`levels`) alongside the unchanged `status` and `options`:
 * for each policy level, whether that level's input was supplied
 * at all, and how many options it contributed. In production
 * the bundle route passes only `repairAnalysis`, so the marker
 * reads ratio supplied / composition NOT supplied — the
 * structurally-empty composition leg is now visible in the
 * bundle output itself, instead of being indistinguishable
 * from a supplied-but-empty composition input. The marker is
 * additive only: `status` and `options` are byte-identical for
 * every input, the bundle's `none_supplied` limitation is
 * untouched, and no UI rendering of the marker is claimed —
 * rendering it is a separate slice.
 *
 * Switch-vs-pin table ("pinned" = divergent-by-design, both
 * paths kept; "identical" = already a single path, collapsed,
 * no switch):
 * | pair | resolution | the flip that must NOT happen            |
 * | PR-1 | pinned     | one merged repair model for both levels  |
 * | PR-2 | pinned     | deleting the composition policy as dead  |
 * |      |            | code, or a phantom producer switch       |
 * | PR-3 | pinned     | one error semantic for both endpoints    |
 * | PR-4 | identical  | a second repair builder (the pipeline IS |
 * |      |            | a fetch wrapper over the pure builder)   |
 *
 * Scan-vs-code verification (current main governs; the scan
 * head was 23de3ce, this slice verified against main 826bd42e):
 * - PR-1 ratio deltas hold: underwater long stock only (option
 *   positions and <100-share positions named-unavailable, never
 *   silently dropped), 1x2 call ratio, K1 nearest listed strike
 *   to spot, K2 lowest listed strike > K1 and >= the half-gap
 *   floor spot + (pricePaid - spot)/2, expiry nearest ~35 DTE
 *   within 21-90 (REPAIR_POLICY: cost tolerance 0.5% of spot,
 *   min DTE 21), `round2` money, cost = max(0, netDebit) x 100
 *   x units, capped upside above K2, NO downside protection,
 *   DRAFTS ONLY (HITL preview flow, no order path reachable).
 * - PR-1 composition deltas hold: losing two-leg option
 *   vertical -> butterfly (short strike becomes the body, wing
 *   beyond it at mirrored distance; refuses non-losing
 *   positions, non-verticals, and stock legs), gated by the
 *   same quant gates as catalog candidates
 *   (DEFAULT_COMPOSITION_CONFIG: max 8 legs, undefined-risk
 *   rejected by default).
 * - PR-1 contract deltas hold: ratio `riskRemovedDollars`
 *   ALWAYS null, `rankScore = -cost`; composition
 *   `riskRemovedDollars` = the composition gate's measured
 *   max-loss reduction when known, `rankScore =
 *   riskRemoved - cost` when known else `-cost` (or 0 when
 *   cost is 0); costs clamp at zero (#1642 hardening);
 *   combined rank `rankScore desc, label asc`; `status` is
 *   `proposals` if either input was supplied (a supplied-
 *   but-empty analysis still counts as supplied).
 * - PR-1 boundary holds: repairPolicies.ts never imports
 *   strategyComposition.ts — composition inputs are
 *   caller-supplied priced values only, and composition
 *   operators are construction uses (recommendation kernel
 *   `repairVerticalToButterfly` case, researchDiscovery.ts),
 *   never proposal inputs.
 * - PR-2 dormancy holds: DEFAULT_REPAIR_POLICIES always
 *   includes CompositionRepairPolicy, but NO production
 *   caller supplies `compositionRepairs` (tests only; the
 *   bundle route passes only `repairAnalysis`). The
 *   composition leg contributes zero options in production
 *   while the ratio leg contributes live proposals.
 * - PR-3 deltas hold: both endpoints call the same
 *   `generateRepairProposals`; analyze lets a producer
 *   failure surface as HTTP 500 ("Failed to generate repair
 *   proposals"), while the bundle route swallows it
 *   (`.catch(() => null)` -> `repairAnalysis: null` -> the
 *   bundle is built without repair options and still
 *   returned).
 * - PR-4 identity holds: `buildRepairProposals` is the pure
 *   builder (positions + chains + optional risk report ->
 *   RepairAnalysis, deterministic, skipped symbols named
 *   with reasons) and `generateRepairProposals` is its live
 *   E*TRADE fetch wrapper (positions + per-symbol chains +
 *   risk report, then the same builder) — one
 *   implementation, not two models.
 * - Producers (complete list, re-verified): the position
 *   producer feeds analyze (standalone, drafts only) and the
 *   bundle (as `repairAnalysis`); `repairVerticalToButterfly`
 *   feeds the recommendation kernel and researchDiscovery.ts
 *   as construction, not proposals. No other producer of
 *   `compositionRepairs` was found.
 */

export type PortfolioRepairPinId = "PR-1" | "PR-2" | "PR-3" | "PR-4";

export type PortfolioRepairResolution = "pinned" | "identical";

export interface PortfolioRepairPin {
  id: PortfolioRepairPinId;
  finding: string;
  resolution: PortfolioRepairResolution;
  /** Why this pair is pinned (or why it is already identical). */
  reason: string;
  /** The current public-route behavior, kept by this slice. */
  defaultBehavior: string;
}

/**
 * The runtime switches this slice adds: none, deliberately.
 * A future switch over any pair below must be appended here
 * with its own Red evidence and PR-body justification.
 */
export const PORTFOLIO_REPAIR_1732_SWITCHES: readonly string[] = [];

export const PORTFOLIO_REPAIR_1732_PINS: readonly PortfolioRepairPin[] = [
  {
    id: "PR-1",
    finding:
      "Position-level ratio repair (repairProposals.ts: underwater long stock only, >=100 shares, 1x2 call ratio, K1 nearest strike, K2 lowest >= half-gap floor, ~35 DTE within 21-90, cost tolerance 0.5% spot, round2, capped upside, NO downside protection, DRAFTS ONLY) vs structural composition repair (strategyComposition.ts: losing two-leg vertical -> butterfly, quant gates, max 8 legs, undefined-risk rejected). Unifying contract repairPolicies.ts (RepairOption: ratio_repair | composition).",
    resolution: "pinned",
    reason:
      "The two levels measure different things (ratio: breakeven/max-recovery with no directly measurable risk removed; composition: measured max-loss reduction when the composition gate measured it), so merging them would invent a number for one level or discard the other's measurement. The flip that must NOT happen: one merged repair model — it would either fabricate riskRemovedDollars for ratio repairs or drop the composition gate's measurement. The #1642 decision (explicit two-level contract over one proposal contract) is DECIDED, not an open duplication to merge without a new owner decision.",
    defaultBehavior:
      "Both levels survive as RatioRepairPolicy and CompositionRepairPolicy over the one RepairOption contract. Ratio: riskRemovedDollars ALWAYS null, rankScore = -cost. Composition: riskRemovedDollars = measured max-loss reduction when known, rankScore = riskRemoved - cost when known else -cost (or 0 when cost is 0); costs clamp at zero. Combined rank rankScore desc, label asc. repairPolicies.ts never imports strategyComposition.ts — composition inputs are caller-supplied priced values only.",
  },
  {
    id: "PR-2",
    finding:
      "Composition policy dormant in production: DEFAULT_REPAIR_POLICIES always includes CompositionRepairPolicy, but NO production caller supplies compositionRepairs (tests only; the bundle route passes only repairAnalysis). The composition leg always contributes zero options in production while the ratio leg contributes live proposals; a bundle consumer could not tell from output alone that one policy level is structurally empty.",
    resolution: "pinned",
    reason:
      "Dormant-by-design per #1642 (\"until its first producer lands\"), not dead code — so the flip that must NOT happen is deleting the composition policy as dead code. The other flip that must NOT happen is a phantom producer on/off switch: with no producer to gate, no call site could honor both values. The slice's recorded decision is therefore: keep the leg dormant, and make the dormancy visible instead of inventing the producer. The producer switch belongs to the slice that lands the first producer, with that producer's own Red evidence.",
    defaultBehavior:
      "Dormant by default, visibly: no production caller supplies compositionRepairs, and buildRepairOptions now returns the per-level marker (levels) so the bundle output itself shows composition supplied=false with 0 options in production, distinct from a supplied-but-empty composition input. No producer is invented, no production value is set, and the composition policy stays live code awaiting its first producer.",
  },
  {
    id: "PR-3",
    finding:
      "Shared producer, divergent caller error semantics: POST /etrade/portfolio-repair/analyze and POST /etrade/portfolio-risk/bundle both call generateRepairProposals. Analyze surfaces a producer failure as HTTP 500; the bundle route swallows it (.catch(() => null) -> repairAnalysis: null -> bundle built without repair options, still returned).",
    resolution: "pinned",
    reason:
      "The two endpoints have different caller contracts: analyze is a standalone diagnostic whose only job is the repair analysis (a failure IS the answer, so failing loud is honest), while the bundle is a composite whose repair plan is one section among many (a failed repair section must not sink the whole bundle, and the bundle already says so via repairs none_supplied plus its limitation). The flip that must NOT happen: one error semantic for both endpoints — making the bundle fail loud would sink composite bundles on a repair-producer outage, and making analyze swallow would return an empty analysis indistinguishable from a genuinely repair-free book.",
    defaultBehavior:
      "Per-endpoint behavior, recorded per endpoint: analyze fails loud (HTTP 500, \"Failed to generate repair proposals\"); bundle swallows (repairAnalysis: null, bundle still returned, repairs none_supplied when no composition input either, with the no-repair limitation). Neither contract changes in this slice.",
  },
  {
    id: "PR-4",
    finding:
      "Builder vs pipeline inside repairProposals.ts: buildRepairProposals (pure: positions + chains + optional risk report -> RepairAnalysis) and generateRepairProposals (live E*TRADE fetch -> chains -> same builder) are one implementation with a fetch wrapper, not two models. Deterministic given inputs; skipped symbols named with reasons in both paths.",
    resolution: "identical",
    reason:
      "One builder, one wrapper — there is nothing to switch and nothing to merge. Splitting them into two builders would duplicate the ratio rules; collapsing the wrapper into the builder would couple the pure builder to live E*TRADE fetching and break its deterministic testability.",
    defaultBehavior:
      "The pure builder stays pure and deterministic; the pipeline stays a fetch wrapper over it. Both name skipped symbols with reasons; neither fabricates strikes.",
  },
];

export function portfolioRepairPin(
  id: PortfolioRepairPinId,
): PortfolioRepairPin | undefined {
  return PORTFOLIO_REPAIR_1732_PINS.find((pin) => pin.id === id);
}
