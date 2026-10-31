### Fixed

- **Merge Queue automation & Policy Gate merge resolution (#2546):** re-enable auto-sync in `auto-update-prs-app.yml` scoped to unqueued auto-merge PRs that fall behind `main`, update `scripts/ci/policy_gate.py` (`resolve_effective_head`) to dynamically select the authored PR branch parent when `main` has been merged into a PR branch, and document strict Merge Queue delivery, flagless auto-merge enrollment, and branch freshness requirements in `AGENTS.md`.
