# FEAT-104 acceptance

```gherkin
Given a bullish candidate
When structures are selected
Then only bull call spread, bull put spread, and (if allowed) CSP/PMCC are evaluated

Given PMCC is disabled in configuration
When structures are selected
Then no PMCC candidate is constructed

Given a PMCC candidate
When economics are computed
Then the long call's remaining value at the short leg's expiration is included
And the result differs from a naive spread-width calculation where applicable

Given a constructed structure
When the independent payoff check runs
Then a mismatch fails gate 5 with the calculation reason recorded
```
