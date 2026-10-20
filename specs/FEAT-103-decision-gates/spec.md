# FEAT-103: Seven decision gates

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)

## Outcome
User problem: trade ideas must pass explicit, falsifiable checks before they
can be presented as qualified — attractive premiums alone are not evidence.
Expected benefit: every idea carries a gate-by-gate decision record; failures
carry actions and reasons into the report.

## Scope
Included: the seven gates (verified in `src/services/researchGates.ts`):
1. Data integrity (`gateDataIntegrity`) — required fields exist, freshness checks.
2. Contract integrity (`gateContractIntegrity`) — expiration/strike/type/
   deliverable/leg relationships valid.
3. Quote quality (`gateQuoteQuality`) — quote age, spread, volume, open
   interest thresholds; source type explicit.
4. Thesis coherence (`gateThesisCoherence`) — outlook/move/timing/regime/
   catalyst/structure directionally consistent.
5. Strategy integrity (`gateStrategyIntegrity`) — leg quantities/ordering valid;
   independent payoff check passes.
6. Risk review (`gateRiskReview`) — loss, breakeven, assignment/event exposure
   stated; unassessed portfolio limits disclosed.
7. Publication (`gatePublication`) — evidence, assumptions, status, and
   human-review language complete.
Gate outcomes map to idea status: qualified / watchlist-only / unverified /
rejected, each with reasons.
Excluded: economics calculations (FEAT-104), report rendering (FEAT-105).

## Requirements
Functional:
- REQ-RES-020: gates run in order; a failed gate records its action + reasons.
- REQ-RES-021: the LLM layer cannot override gate outcomes or fabricate
  missing evidence (enforced: gates are deterministic functions).
- REQ-RES-022: zero qualified ideas is a valid run result; the pipeline never
  manufactures an idea to fill a quota.

## Acceptance
See `acceptance.md`. Deterministic tests per gate: pass/fail fixtures,
including malformed contracts, wide spreads, and thesis contradictions.
