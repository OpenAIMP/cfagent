### Fixed

- CodeQL 4 high alerts on PR #2109 (#2110): the quote-source test's mocked-fetch router matched upstream hosts with `url.includes(...)`; replaced with anchored origin-prefix checks (`startsWith("https://query1.finance.yahoo.com/")`, `startsWith("https://data.alpaca.markets/")`). Test-only change, no behavior change.
