# FEAT-102: Candidate evaluation loop (OODA)

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)

## Outcome
User problem: candidate evaluation must be purposeful and bounded — each
retrieval or calculation must serve a decision, and the loop must stop when
evidence or budget runs out.
Expected benefit: no unbounded fan-out; every candidate carries an explicit
decision trail (investigate / build / reject / watch / refresh / stop).

## Scope
Included: the OODA loop over candidates — Observe (quotes, chains,
technicals, catalysts when available), Orient (quality/freshness/regime/
thesis/contradictions), Decide (explicit next action), Act (research-state
update only). Loop budgets: per-candidate, per-chain, iteration, runtime,
tool-call caps.
Excluded: gate internals (FEAT-103), economics (FEAT-104).
Dependencies: provider layer (`researchProviders.ts`), FEAT-101 budgets.

## Requirements
Functional:
- REQ-RES-010: each loop iteration selects one explicit action from the
  closed set {investigate, build, reject, watch, refresh, stop}.
- REQ-RES-011: "Act" updates research state only; it never places broker orders.
- REQ-RES-012: the loop stops when no step has a clear research purpose or any
  budget is exhausted; the stop reason is recorded.
- REQ-RES-013: stale or absent evidence is surfaced on the candidate, never
  silently substituted.
Agent behavior:
- Delegation: the deterministic pipeline owns the loop; the Think wrapper
  (FEAT-106) dispatches it and explains the persisted result.

## Acceptance
See `acceptance.md`. Deterministic tests: loop termination under exhausted
budgets; explicit action recorded per iteration.

## Open decisions
- None.
