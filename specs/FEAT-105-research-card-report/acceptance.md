# FEAT-105 acceptance

```gherkin
Given a completed research run
When the report is persisted
Then mas_reports holds exactly one canonical row for the generation
And the row contains the typed report, not an LLM paraphrase

Given a ranked idea card
When a reviewer reads it
Then the card shows supporting and competing evidence side by side
And invalidation conditions are stated explicitly
And maximum contractual loss is stated separately from any stop-based estimate
And the card is marked research-only, human review required

Given a published report
When its inputs are re-examined
Then the configuration version, source timestamps, and rules version reproduce the run
```
