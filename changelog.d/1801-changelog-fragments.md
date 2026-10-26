### Added

- **Changelog fragments (#1801):** PRs add one file under `changelog.d/` instead of touching CHANGELOG.md, so rebase merges no longer collide on the shared file. Policy Gate (d) accepts a fragment; release notes include fragments by default; `scripts/ci/assemble-changelog.mjs` folds fragments into the versioned section at release time.
