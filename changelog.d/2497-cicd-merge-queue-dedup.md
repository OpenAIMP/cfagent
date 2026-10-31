### Changed

- **CI/CD Merge Queue + Policy Gate + Tree-Hash Deduplication (#2497):** Enabled `Policy Gate` on `merge_group` via `--diff-only` git-tree evaluation, added git-tree-SHA (`HEAD^{tree}`) deduplication in `ci.yml` so `fast-gates` and the 4 Vitest shards run only once per unique code tree, switched `gitleaks.yml` to the open-source `gitleaks` release binary, and added GitHub App fallback/gating in `auto-merge-trusted.yml` and `auto-update-prs-app.yml`. #COO-spr9
