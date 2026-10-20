# Research evaluation baseline (#583)

Recorded 2026-10-20. This is the behavior baseline for research outcome
evaluation — the reference point any future tuning must be compared against
(docx §9, blueprint §15). No tuning has been applied.

## Evaluation path

- Entry: `ResearchAgent.evaluateDueRuns()` (scheduled tick, runs older than
  24h with no evaluation row, oldest first, cap 5) or `evaluateRun(runId)`
  (manual route). Both best-effort; failures recorded as nulls, never thrown.
- Core: `runResearchEvaluation(deps, ideas, runId, config)` in
  `src/services/researchPipeline.ts`.
- Persistence: one row per evaluation in `research_evaluations`; the original
  `research_runs` row is never mutated.

## Current scoring behavior (heuristics, documented as such)

| Dimension | Current behavior |
|---|---|
| Direction | `scoreDirection`: bullish → evalSpot > entrySpot; bearish → evalSpot < entrySpot; else null. Magnitude ignored. |
| Invalidation | Eval spot outside breakeven band ±2% → invalidated. |
| P&L estimate | Intrinsic value of legs at eval spot minus opening mid cost; null when legs are empty or estimation fails. Flagged "not a fill record". |
| Data quality | Unavailable follow-up quote → `dataQualityFailures`++, idea notes record it, other fields null. |
| Gate outcomes | Not yet scored — recorded on the idea card's decision record (FEAT-103). |
| Rejected-candidate reasons | Not yet scored — visible in report only. |
| Fee/slippage effects | Stated as assumptions in economics; not yet varied in evaluation. |

## Dataset

`evaluations/datasets/v1/`: 5 synthetic held-out cases (zero-qualified,
stale-quote, bullish-hit, bearish-miss, adversarial-empty-legs). Manifest
carries provenance; cases carry expectations. Loader:
`src/services/researchEvaluationDatasets.ts`.

## Rules versioning

Evaluations link to the original run ID and its rules version; rule changes
are versioned so reports from different versions remain interpretable.
