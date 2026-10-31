### Fixed

- **Policy Gate pure docs check (f) bypass in merge_group (#2555):** ensure pure documentation PRs bypass check (f) (stale base reversion) so that queued documentation PRs do not false-fail on newly added code or changelog files on `main` when entering the Merge Queue.
