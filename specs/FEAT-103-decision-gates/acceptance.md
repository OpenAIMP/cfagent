# FEAT-103 acceptance

```gherkin
Given an idea with a malformed contract (mismatched legs)
When gate 2 runs
Then the idea is rejected with the contract reason recorded

Given an idea priced only from a model-calibrated chain
When gate 3 runs
Then the idea is watchlist-only or rejected, never qualified on modeled quotes alone

Given an idea whose thesis contradicts the evidence
When gate 4 runs
Then the idea is rejected or watchlist-only with the contradiction recorded

Given a run where no idea passes all gates
When the report is produced
Then the report shows zero qualified ideas with per-idea rejection reasons
And no idea is manufactured to fill a quota

Given a gate failure
When the report renders the idea
Then the failed gate, its action, and its reasons appear on the idea's decision record
```
