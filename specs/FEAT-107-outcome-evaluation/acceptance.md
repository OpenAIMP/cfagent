# FEAT-107 acceptance

```gherkin
Given a prior research run with a persisted report
When outcome evaluation runs after follow-up data is available
Then the evaluation links to the original run ID and rules version
And observed outcomes are compared against the saved thesis and scenarios

Given an evaluation
When it scores the research decision
Then missing-data caveats from the original run are preserved
And historical inputs are not modified

Given two reports produced under different rules versions
When both are evaluated
Then each evaluation references its own version
And the versions remain distinguishable in the results
```
