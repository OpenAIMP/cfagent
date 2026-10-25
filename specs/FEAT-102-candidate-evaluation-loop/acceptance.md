# FEAT-102 acceptance

```gherkin
Given a candidate under evaluation
When an iteration completes
Then the recorded action is one of investigate, build, reject, watch, refresh, stop

Given the iteration budget is exhausted for a candidate
When the loop would continue
Then the loop stops
And the stop reason names the exhausted budget

Given a chain fetch returns stale quotes
When orientation runs
Then the candidate is flagged with the staleness
And a model-calibrated chain is never labeled as live broker quotes

Given a candidate with no clear next research purpose
When the loop evaluates
Then it selects stop rather than manufacturing further work
```
