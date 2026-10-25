# FEAT-106 acceptance

```gherkin
Given a research request
When the Think agent handles it
Then the research tool is dispatched exactly once

Given a persisted research result
When the agent summarizes it
Then the summary matches the persisted typed report
And no gate outcome is altered or softened in the summary

Given the Think workflow fails to produce a persisted run
When the orchestrator fallback triggers
Then the deterministic pipeline runs directly
And the research result is persisted through the same canonical seam
And no trading authority is created by the fallback
```
