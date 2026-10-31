### Fixed

- `auto-merge-trusted.yml`: remove `--rebase` flag from `gh pr merge --auto` so
  PRs are correctly enqueued into the merge queue instead of silently not being
  submitted when a merge queue is active (#2519)
- `scripts/ci/policy_gate.py`: compute per-PR `git merge-base` on `merge_group`
  to eliminate false (f)/(i) failures when `main` advances between PR open and
  queue gate run (#2519)

