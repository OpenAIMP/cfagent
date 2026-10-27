### Added

- **COBIT balanced scorecard output (#1875):** the governance-scorecard collector now outputs the four adopted perspectives (Financial, Customer, Internal process, Learning & growth) with CI minutes, post-merge red rate, ADR count, template adoption, journey coverage, and median time-to-merge, and — with `--html-dir` — versioned HTML history (`scorecard-<date>.html`, `scorecard.html`, `index.html`) for GitHub Pages alongside the #1872 comment. Uncollected metrics render as gaps, never zeros.
