### Added

- **Auto-merge labeler scoping (#1894):** the labeler withholds auto-merge from bot PRs, PRs that delete files, PRs touching workflow files, and PRs created automatically by Jules, with a comment stating why; withheld PRs wait for a human merge decision.
