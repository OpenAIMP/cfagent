### Changed

- **CI/CD Hardening & Velocity (#2499):** Updated `Policy Gate` on `merge_group` to evaluate each queued PR individually (plus aggregate tree), hardened `ci.yml` tree-dedup anchors to require full `Fast gates` + 4/4 shard execution within 24h with `$GITHUB_STEP_SUMMARY` audit trails and a docs-only fast path, pinned the `gitleaks` v8.24.2 SHA-256 digest with a nightly full-history backstop, made lane-label creation best-effort in `auto-merge-trusted.yml`, and retired `auto-update-prs-app.yml` in place (`if: false`). #COO-spr9
