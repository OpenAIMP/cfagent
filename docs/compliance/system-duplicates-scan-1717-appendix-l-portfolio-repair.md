# Scan appendix (l) — Portfolio repair remainders — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. **Ratified design: the two repair models
coexist by #1642 design — switch, don't delete, and do not re-merge without a
new owner decision.**

## PR-1 — Position-level ratio repair vs structural composition repair — DIVERGENT (coexistence confirmed, by design)

- Implementations:
  - **Position level:** `src/services/repairProposals.ts`
    (`buildRepairProposals` pure builder + `generateRepairProposals` pipeline;
    #355): underwater long stock only (≥100 shares, cost basis present, spot <
    pricePaid; option positions and <100-share positions are named-unavailable,
    never silently dropped). Proposes a 1×2 call ratio: BUY 1 call at K1 (nearest
    listed strike to spot), SELL 2 calls at K2 (lowest listed strike ≥ the
    half-gap floor `spot + (pricePaid − spot)/2`), expiry nearest ~35 DTE
    within 21–90 DTE (`REPAIR_POLICY`: cost tolerance 0.5% of spot, min DTE 21).
    Money: `round2` (2dp) throughout; cost = `max(0, netDebitPerUnit) × 100 ×
    units`; capped upside above K2; explicitly no downside protection; DRAFTS
    ONLY (HITL preview flow, no order path reachable).
  - **Structural level:** `src/services/strategyComposition.ts`
    (`repairVerticalToButterfly`, `roll`, `transformToDefinedRisk`, `combine`,
    `transformStraddleToStrangle`, `gateComposedCandidate`; leg-graph algebra over
    `StrategyGraph`): repairs a LOSING two-leg option vertical into a butterfly
    (short strike becomes the body, wing beyond it at mirrored distance; refuses
    non-losing positions, non-verticals, and stock legs), gated by the same quant
    gates as catalog candidates (`DEFAULT_COMPOSITION_CONFIG`: max 8 legs,
    undefined-risk rejected by default).
- Unifying contract (not a merged model): `src/services/repairPolicies.ts`
  (`RepairOption`: `kind` `ratio_repair` | `composition`, `costDollars`,
  `riskRemovedDollars`, `rankScore`, `rankBasis`, `detail`;
  `RatioRepairPolicy` + `CompositionRepairPolicy` + `buildRepairOptions`,
  consumed by `buildRecommendationBundle`). Contract deltas, all documented in
  the module:
  - Ratio: `riskRemovedDollars` is ALWAYS null (breakeven / max-recovery are
    stated, risk removed is not directly measurable); `rankScore = −cost`
    (cost-first among unknowns).
  - Composition: `riskRemovedDollars` is the composition gate's measured
    max-loss reduction when known; `rankScore = riskRemoved − cost` when known,
    else `−cost` (or 0 when cost is 0); costs clamp at zero (#1642 hardening,
    matching the ratio policy's `max(0, …)`).
  - Combined ranking in `buildRepairOptions` is `rankScore desc, label asc`;
    `status` is `proposals` if either input was supplied (a supplied-but-empty
    analysis still counts as supplied).
- Boundary honored on main: `repairPolicies.ts` never imports
  `strategyComposition.ts` — composition inputs are caller-supplied priced
  values only, and composition operators are construction uses (recommendation
  kernel `repairVerticalToButterfly` case, `researchDiscovery.ts`), never
  proposal inputs.
- `src/services/repairPolicies.ts` (header, verbatim in substance) states the
  #1642 decision (parent #1638, doc §6): an explicit two-level contract over one
  proposal contract — NOT a single merged repair model, because the levels
  measure different things. The program should treat this as decided, not as an
  open duplication to merge without a new decision.

## PR-2 — Composition policy is dormant in production — DIVERGENT (present but unpopulated)

- `DEFAULT_REPAIR_POLICIES` always includes `CompositionRepairPolicy`, but NO
  production caller supplies `compositionRepairs` to the bundle (module header:
  "tests only"; verified by grep: the only `compositionRepairs` producers are
  the policy itself and its tests; the bundle route passes only `repairAnalysis`).
- The composition leg of the unified contract therefore always contributes zero
  options in production, while the ratio leg contributes live proposals. This is
  dormant-by-design per #1642 ("until its first producer lands"), not dead code —
  but it is a live asymmetry: a bundle consumer reading `RepairOption[]` cannot
  tell from the output alone that one policy level is structurally empty.
- Slice guidance: the slice's work is the first producer (or an explicit recorded
  decision to keep the leg dormant with a visible marker), NOT deleting the
  composition policy. A switch here covers producer on/off, defaulting to current
  behavior (dormant) until the producer lands and is proven.

## PR-3 — Shared producer, divergent caller error semantics — DIVERGENT (narrow)

- Implementations: `src/agents/routes/etradeBroker.ts` —
  `POST /etrade/portfolio-repair/analyze` and
  `POST /etrade/portfolio-risk/bundle` both call the same
  `generateRepairProposals(etrade)` (`src/services/repairProposals.ts`).
- Delta: the analyze endpoint lets a producer failure surface as HTTP 500
  (`"Failed to generate repair proposals"`); the bundle route swallows it
  (`.catch(() => null)` → `repairAnalysis: null` → bundle built without repair
  options, still returned). Same producer, different failure visibility for the
  same underlying error.
- Slice guidance: default = route behavior per endpoint, recorded per endpoint —
  the slice must not silently make the bundle fail loud (or the analyze endpoint
  swallow) without naming which endpoint's contract changed and why.

## PR-4 — Builder vs pipeline inside repairProposals.ts — IDENTICAL

- `buildRepairProposals` (pure: positions + chains + optional risk report →
  `RepairAnalysis`) and `generateRepairProposals` (live E*TRADE fetch → chains →
  same builder) are one implementation with a fetch wrapper, not two models.
  Deterministic given inputs; skipped symbols named with reasons in both paths.

## Repair producers (complete list found)

- `generateRepairProposals` → `POST /etrade/portfolio-repair/analyze`
  (standalone, drafts only) and `POST /etrade/portfolio-risk/bundle`
  (as `repairAnalysis` input to `buildRecommendationBundle`).
- `repairVerticalToButterfly` → recommendation kernel composed-structure builder
  and `researchDiscovery.ts` (construction, not proposals). No other producer of
  `compositionRepairs` was found.
