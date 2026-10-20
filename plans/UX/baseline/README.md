# Phase 0 baseline (#468, epic #137)

The no-regression reference for every later token-migration slice. Generated
2026-10-20 from main @ 30253d0 plus this PR's contrast fixes (see
contrast-audit.md — the fixes are the only intentional appearance changes).

- `token-coverage.json` — output of `node scripts/token-coverage.mjs --json`:
  raw color literals outside the token sources (tokens.css, designTokens.ts).
  Baseline totals: 3,105 raw literals (1,298 hex + 1,807 functional), 178
  distinct hex values, 32 TSX files with inline style blocks. styles.css is
  the largest offender (1,984 literals incl. functional notations).
- `token-snapshot.json` — every `--color-*` value in the dark and light maps.
  Parity check for a migration slice: after the slice, re-run
  `node scripts/token-contrast.mjs --json` and diff the tokenSnapshot —
  values must match except for changes the slice explicitly lists.
- `contrast-audit.md` — WCAG AA audit of 50 semantic pairs, defects found and
  the tokens.css fixes applied in this PR (0 pairs below AA after fixes).

Parity method note: this is a token-level (mechanical) baseline. Rendered
screenshots require an authenticated app session (GitHub OAuth) and are
captured per-slice in PRs where a running session is available; the token
snapshot + coverage diffs are the always-runnable floor.
