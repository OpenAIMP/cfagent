# Collaboration Protocol

How the agents (and humans) working on this repo avoid duplicating each
other's work. Adopted 2026-10-18 as a shared rule between the repo owner,
the human collaborator, and the AI agents.

## Who works here

- **Repo owner** (Ceos) — directs work, owns workflow files, secrets, and
  schedule toggles; merges or closes at his discretion.
- **Human collaborator** (Mubasher Ahmed) — ships fixes via branches and PRs.
- **Muse (main chat)** — the owner's personal agent; works issues at the
  owner's direct request.
- **Muse scheduler pollers** — two background workers:
  - `ci-failure-fast-poll` (every 10 min): new `[QA self-heal]` issues with
    the `ci-failure` label.
  - `self-heal-fixer-poll` (every 30 min): any unclaimed `[QA self-heal]`
    issue (backstop).
- **GitHub Copilot** — auto-assigned to new `[QA self-heal]` issues by the
  `self-heal-fixer` workflow.

## The shared rule: branch-as-lock

**A branch ref is a fact; a comment is a signal.** Comment-based claiming
races (two "Fix claimed by" comments landed 27 seconds apart on #234, and
a poller opened PR #236 duplicating the main chat's PR #235). Branch refs
are visible the instant they're created and checkable in one call.

### Claiming work

1. **Create the fix branch FIRST** — before any comment, before any code.
   The branch is the lock.
2. **Then** post a "Fix claimed by" comment on the issue (the signal).
3. Branch name carries the **specific issue number**:
   `fix/<issue>-<short-desc>` (e.g. `fix/246-nasdaq-timeout`). Never just
   the epic's number — a checker looking for `fix/240-*` will walk straight
   past `fix/143-*` even when the epic's branch covers that issue
   (this happened with #240/#241 under epic #143).

### Pre-flight check (before claiming)

Skip the issue if ANY of these hold:

- Assigned to Copilot.
- Fresh "Fix claimed by" comment (< 2h) or a "Fix PR:" comment.
- An open PR referencing the issue.
- A live branch matching `fix/<issue>-*` or `fix/<issue>_*`.
- **Epic check:** if the issue body references an epic, also check
  `fix/<epic>-*` branches and open PRs mentioning the epic — work claimed
  under the epic number may already cover this issue. When in doubt, skip
  and comment.

### Stale-lock release

A branch-as-lock can deadlock if someone claims and abandons. Two release
paths:

- **Voluntary:** comment the release ("Releasing claim on #N") and delete
  the branch.
- **Automatic:** a claim branch with no open PR and no commits ahead of
  `main` for 24 hours counts as released — treat as unclaimed (note it in
  the run log).

### Exceptions

- **Copilot** is the known exception on all sides: the workflow assigns it,
  everyone else skips what it's assigned, and its own claiming is GitHub's
  business.
- **Main chat precedence:** when the owner asks the main chat directly, the
  main chat creates the branch immediately, which stands the pollers down.

## Workflow

Issue first (every change tracks an issue), then branch → PR → merge.
Never push directly to `main`. Commit messages reference the issue number.

## Merge method: rebase-and-merge (all lanes, owner directive 2026-10-18)

Every PR in this repo (and in OpenAIMP/cfpay) merges with GitHub's
**rebase** method — linear history, the branch's individual commits
preserved, no squash commits, no merge commits. This applies to every
lane: the main chat, the scheduler pollers, and the self-heal fixer.

Cadence: **rebase-and-merge after every fix** — as soon as a PR's checks
are green, rebase it onto current `main` if it has fallen behind (and let
checks re-run), merge it immediately, and delete the claim branch.
Finished work never sits unmerged. PRs merged before this directive stay
as they are; history is not rewritten.
