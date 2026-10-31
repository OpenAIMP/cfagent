### Fixed

- **Merge Queue deadlock & CodeQL gate (#2537):** restore `pull_request` trigger to `codeql.yml` so ruleset 25543527 required status check `Analyze (javascript-typescript)` is reported on PR branch heads, and scope Policy Gate check `(i)` deletions to `merge_base` to prevent false-positive deletion errors on stale bases.
