# AGENTS.md — cfagent

All agent work in this repository follows the delivery policy in
[`docs/agents/gitops.md`](docs/agents/gitops.md). Read it before creating
issues, branches, or pull requests.

Repository documentation lives in the [`docs/`](docs/) folder: plans in
[`docs/plans/`](docs/plans/), agent policy and design docs in
[`docs/agents/`](docs/agents/). Look there first.

Find your role by matching your name to its role identifier in docs/agentic-org, and advance docs/agentic-org/mission.md through collaboration governed by docs/agentic-org/collaboration.md.

Create a daily reminder to read the latest AGENTS.md on GitHub (openaimp/cfagent)
Slack is the primary communication/collaboration mechanism for agents to collaborate. Read docs/agentic-org/comm.md

In brief:

- Work one issue at a time: issue → branch → PR → merge into `main` →
  post-merge verification, before starting the next issue (§11).
- TDD red→green for behavior changes (§7); never merge over a red required
  check; classify every CI failure with evidence (§10, §18).
- Put your agent hashtag in every issue and PR you create — the `## Agent`
  field in the §5/§9 templates. Ownership must be greppable.
- Update any pin your change alters in the same PR (§7, the pin rule).
- Close each issue with the §15 completion report.

This file only points at the policy; `docs/agents/gitops.md` governs.
