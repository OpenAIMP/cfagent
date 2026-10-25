# FEAT-101: Research run configuration & lifecycle (ARR)

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)
Security reviewer: TBD

## Outcome
User problem: Research runs must be reproducible, bounded, and reviewable —
a run's configuration, inputs, and decisions must be inspectable after the fact.
Target users: Ceos (strategy reviewer), downstream consumers (AI Search, Reports tab).
Expected benefit: every research output traces to a versioned configuration and
a run record; no silent re-runs or duplicate rows.
Success metric: 100% of persisted runs carry config version + run ID; zero
duplicate canonical rows per generation.

## Scope
Included: run configuration loading/validation (`researchConfig.ts`), ARR
autonomy boundaries (research-only, no order actions), recurrence (weekday
after-close schedule, once-per-day guard), manual vs scheduled trigger parity,
canonical persistence via the #308 generate→store seam.
Excluded: report delivery channels (#336), per-run PDF rendering (#335).
Dependencies: `mas_reports` store (`src/services/scheduledReports.ts`), #308.

## User journeys
Primary: scheduler fires after close → guard allows one run/day → pipeline runs
→ canonical report row persisted → AI Search can surface it.
Failure: required input unverifiable → candidate marked unverified/watchlist or
rejected with reason; run still persists honestly.
Recovery: interrupted run re-triggers manually with identical config; the
once-per-day guard keys on date, not on success.

## Requirements
Functional:
- REQ-RES-001: configuration (universe, thresholds, strategy families, budgets)
  is loaded, validated, and versioned per run.
- REQ-RES-002: scheduled runs fire weekdays after close with a once-per-day
  guard (verified: `RESEARCH_SCHEDULED_FIRE_HOUR_UTC = 21`,
  `shouldFireResearchTick`).
- REQ-RES-003: manual runs use the identical pipeline as scheduled runs.
- REQ-RES-004: autonomy is research-only: no order preview/submit/amend/cancel
  anywhere in the pipeline.
Agent behavior:
- Allowed tools: market-data providers, chain retrieval, economics calculators.
- Budgets: candidate, chain, iteration, runtime, and tool budgets bound every run.
- Approval boundaries: none — research requires no approval; delivery does (#336).
Contracts:
- Run record: run ID, config version, timestamps, candidate decisions.
- `mas_reports`: one canonical row per generation (`generationId`), idempotent.

## Acceptance
Deterministic tests: TEST-RES-001 guard allows exactly one run per day;
TEST-RES-002 duplicate generation does not create a second canonical row.
See `acceptance.md`.

## Rollout
Migration: none (greenfield tables already exist).
Feature flag: n/a — schedule guard is the control.
Rollback: disable the scheduled trigger; manual runs unaffected.

## Open decisions
- Catalyst feed: accepted as absent per docx §8; revisit if a feed is procured.
