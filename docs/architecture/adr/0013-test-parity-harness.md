# ADR 0013: Test-parity harness — baseline snapshots, behavior comparison, per-PR checklist

- Status: Accepted
- Issue: #1746 (sub-issue of #1736, item 10)
- Supersedes: nothing (consumes the #1546 slices' §15 evidence pattern, gitops §7/§10/§11/§17/§18, `scripts/verify-before-merge.sh`, and `npm run check`; the per-slice conformance suites are run by the harness, never rewritten by it)
- Related: docs/agents/gitops.md; program tracker #1736

## Context

Program #1736 items 1–9 are architectural refactors: without a
program-wide parity discipline, a refactor can pass its own tests while
silently changing behavior, and the drift is discovered in production
instead of in the PR. Items 1–9 enforced the discipline manually —
`scripts/verify-before-merge.sh` on the rebased head, pin updates in the
same PR, §15 evidence, never merging over a red gate — and every one of
those §15s cites the same evidence pattern. What did not exist was a
runnable artifact: a harness a refactor PR can run to compare old vs new
behavior, with a baseline snapshot per refactor and a checklist that
fails loudly when incomplete. Issue #1746 is that artifact. It lands
last in the owner priority order, so it also carries a retrospective
parity table for items 1–9 in its §15: their evidence already exists,
this harness makes the same checks runnable instead of manual.

Coordination checked before building: no test-parity or harness work
exists under #1717 (its Adapter slices S1–S7 cover bypass fixes, stores,
blobs, email/browser ports, actor-gateway, durable workflows, and a
wiring-centralisation decision — none is a parity harness), and the
#1717 scan document contains no parity/harness entry. This slice
therefore builds, it does not duplicate.

## Decision

- One script, `scripts/parity.mjs`, with five subcommands: `capture`
  (run typecheck + vitest JSON + build, write a snapshot),
  `compare` (baseline vs current, exit 0/1/2), `checklist` (print the
  canonical per-PR checklist), `check` (validate a filled checklist),
  `report` (render the migration parity report markdown for a §15).
  Wired as `npm run parity`. The checklist template also ships as
  `scripts/parity-checklist.md`.
- Parity surface is typecheck + suite + build. The design-token check
  stays in `npm run check` (it guards token drift, not behavior) and
  the policy gate stays in `scripts/verify-before-merge.sh` (it guards
  PR policy, not behavior). The harness composes with both and
  replaces neither, and it never changes `npm run check` semantics or
  the verify script's guarantees (issue #1746 scope exclusion).
- Comparison rules, deterministic, no model judgment in gate decisions:
  a red baseline refuses comparison (parity is undefined against red);
  typecheck or build regressions fail; a previously passing file
  gaining failures fails, naming the failed tests; a removed test
  file fails unless listed in `--removals` with a reason, in which
  case it passes as an *accepted* removal and is reported as such —
  never silent. Added files and growth are informational only.
- Capture exits 0 when the snapshot is written even when the suite is
  red; enforcement lives in `compare`. A harness failure (unreadable
  input, missing/unparseable vitest output) exits 2 and is reported,
  never skipped or masked as a pass.
- Snapshots are per-file aggregates plus failed test names — not a
  full per-test dump — so they stay small while still naming what
  broke. Vitest is run with `--reporter=json --outputFile` so console
  output from tests cannot corrupt the parsed report.
- The harness is purely a local/CI runner: no provider surface, so no
  port/adapter shape is forced onto it (stated explicitly per the
  slice brief). Its only production-adjacent touch is the `parity`
  npm script entry. The per-slice conformance suites are run by the
  harness, never rewritten by it.
- The harness itself is covered by tests (`tests/parity_harness.test.ts`,
  16 tests: snapshot parsing, comparison pass/fail/removed/accepted/
  red-baseline, checklist validation, report rendering) and follows
  the same rules it enforces: `npm run check` green +
  `scripts/verify-before-merge.sh` on the rebased head, and a trial
  refactor run through the harness end-to-end before merge (trial
  branch discarded, never merged).

## Consequences

- Future refactors get a runnable `capture → refactor → compare →
  checklist → report` loop instead of a manual discipline; a parity
  failure blocks exactly like a red gate.
- Full-suite capture runs are slow (the suite is 650+ files): the
  harness is a pre-merge gate tool, not a watch-mode tool. Scoped runs
  are out of scope — a scoped comparison would prove nothing about
  the files it skipped.
- Snapshot files are local artifacts (gitignored scratch by default
  placement in /tmp or the caller's chosen path); they are not
  committed, so a baseline snapshot reference in a §15 is a commit
  plus the compare output, not a checked-in file.
- Retrospective limitation, stated honestly: items 1–9 landed before
  this harness existed, so their parity evidence is the manual
  verify-before-merge + gate + post-merge CI record, not harness
  runs. The §15 retrospective table says so; it does not claim
  harness coverage retroactively.

## Alternatives considered

- Extending `scripts/verify-before-merge.sh` to do the comparison:
  rejected. The verify script's job is "this head is rebased and
  green"; the harness's job is "this head behaves like that baseline".
  Merging them would tangle two guarantees and change the verify
  script's contract, which issue #1746 explicitly excludes.
- Per-test-name snapshot comparison: rejected as the primary rule.
  Per-test names churn on renames and refactors; per-file aggregates
  plus failed-test names catch every real regression (a newly failing
  test always fails its file) without failing on renames.
- Blocking all test removals outright: rejected. Legitimate refactors
  fold and rename suites; the accepted-with-reason path keeps
  removals visible without blocking legitimate work.
