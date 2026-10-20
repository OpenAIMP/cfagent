# RSI Product Plan — Recursive Self-Improvement of Product Capabilities

_Issue: [#688](https://github.com/OpenAIMP/cfagent/issues/688). Status: COMPLETE 2026-10-20._

## Vision

Every product capability should make the product better at getting better. This plan orders the product backlog so each tier compounds the one before it.

## Tier 1 — Trust (nothing compounds without it)

| # | Issue | Status |
|---|-------|--------|
| #424 | Failed screener runs don't notify Slack | Fixed (PR #689) |
| #115 | Integrity audit: fabricated success, silent fallbacks | Verified clean, closed |
| #277 | Confirmation step on report dispatch (HITL) | Already implemented, closed |
| #79 | RiskPolicyEngine | PR #674 (pending CI) |

## Tier 2 — The daily loop (see → understand → act)

| # | Issue | Status |
|---|-------|--------|
| #341 | Watchlist & rejected-ideas browser | Mubasher (in progress) |
| #339 | Reports-tab research views | Closed |
| #340 | Track-record surface | Closed |
| #649 | Semantic search UI for research reports | PR #690 |
| #218 | LLM-generated digests in publishers | PR #692 |

## Tier 3 — The product getting smarter

| # | Issue | Status |
|---|-------|--------|
| #654 | Calibration dashboard | PR #679 (pending CI) |
| #653 | Strategy candidate review | PR #695 |
| #232 | Recursive Self-Improvement toward ASI | This plan is the mandate |

## Tier 4 — Breadth (more ways to use it)

| # | Issue | Status |
|---|-------|--------|
| #650 | Setup catalog browser | PR #696 |
| #223 | Scheduled options analysis in UI | Verified complete, closed |
| #273 | Schedules management UI | Closed |
| #655 | Universe picker | Verified complete, closed |
| #275 | Strategy/Symbol Scanner UX | Verified complete, closed |
| #264 | One agent, one UI (ScreenerAgent) | Verified complete, closed |

## Tier 5 — Platform enablers

| # | Issue | Status |
|---|-------|--------|
| #338 | R2/DO storage split | Design awaiting acceptance |
| #651 | Autopilot status and controls | Blocked on #79 merge |
| #652 | Agent task queue view | Superseded by #78, closed |
| #656 | Surface newly implemented routes | PR #699 |

## The flywheel

**#340 (track record) → #654 (calibration) → #653 (strategy review) → #232 (self-improvement).**

Every run becomes training data for the next one. The track-record surface records what was published before outcomes; calibration measures predicted vs realized; strategy review feeds human judgment back into ranking; the self-improvement loop closes when the agent adjusts from the accumulated evidence.

## Stale (recommended close)

- #1–#8 — old architecture notes
- #13, #14, #16, #18 — Q3 discovery epic, superseded
- #571 — agentic transformation tracking

## Rules

- One issue at a time per gitops; merge + verify before the next.
- Tier order is the build order; do not skip tiers.
- Every backend change names its UX counterpart.
