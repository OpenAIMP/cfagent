# FEAT-107: Outcome evaluation

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)

## Outcome
User problem: research quality must be judged against observed outcomes over
time — not just whether a hypothetical trade would have made money, but
whether the research decision was good (direction, horizon, calibration,
gate behavior).
Expected benefit: versioned evaluation linked to original runs, so strategy
logic and configuration improve on evidence.

## Scope
Included: `runResearchEvaluation` (verified in `researchPipeline.ts`, called
from `research-agent.ts`): retrieves subsequent market observations for a
prior report and compares them with the saved thesis and scenarios. Review
dimensions: forecast direction/horizon, scenario calibration, quote quality,
gate outcomes, rejected-candidate reasons, fee/slippage effects.
Excluded: evaluation datasets and governance cadence (#583).
Dependencies: FEAT-105 (persisted reports with rules versions).

## Requirements
Functional:
- REQ-RES-060: evaluation links to the original run ID and rules version.
- REQ-RES-061: evaluation assesses research-decision quality, preserving
  missing-data caveats; it does not rewrite historical inputs.
- REQ-RES-062: rule changes are versioned so reports from different versions
  remain interpretable.

## Acceptance
See `acceptance.md`.
