# FEAT-101 acceptance

```gherkin
Given the scheduler fires twice on the same trading day
When the second tick is evaluated
Then the once-per-day guard blocks it
And the run log records the skip with the date key

Given a manual research trigger
When the pipeline executes
Then it uses the same stages, gates, and persistence as a scheduled run

Given a scheduled run and a manual run for the same generation
When both complete
Then mas_reports holds exactly one canonical row for that generationId

Given the pipeline cannot verify a required input
When the run completes
Then the affected candidate is marked unverified or watchlist-only with a reason
And no model-calibrated chain is presented as a live broker quote

Given any pipeline stage
When it considers placing, previewing, amending, or canceling an order
Then the action is refused (no such code path exists in the research pipeline)
```
