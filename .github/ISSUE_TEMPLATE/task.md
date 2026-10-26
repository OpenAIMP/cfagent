---
name: Task (gitops §5)
about: One unit of work — issue first, per docs/agents/gitops.md
title: ""
labels: []
assignees: []
---

## Agent
#<your-agent-hashtag>

## Problem

## Outcome

## Scope
Included:
Excluded:

## Acceptance criteria
- [ ]

## Test plan

## Dependencies

## Change management
Expected impact:
Migration and data impact:
Rollout plan:
Rollback plan:
Communication:

## Engineering standards
All development on this issue must follow:
- SOLID principles
- GoF design patterns
- GRASP patterns
- 15-factor app methodology
- Design thinking — start from the user journey and UX: name the journey this change serves and how its value surfaces in UX

## Standing guardrails
- TDD (gitops §7): every behavior change updates its pin tests in the same PR
- No silent nulls, no lazy fallbacks — fix root causes
- User-facing messages carry business errors, not technical errors; technical detail stays in logs
- Everything user-scoped, session-scoped, run-scoped — no shared mutable client state
- Incremental changes only — never silently remove a capability
- Verify against live production before calling it done — merged is not working
- Pre-merge: rebase onto fresh main, run scripts/verify-before-merge.sh, green gate expires when main advances; post-merge CI is mandatory
- Branch-as-lock when collaborating: check live fix/<issue>-* branches and open PRs before claiming
- Never place or cancel a trade/order without explicit confirmation

## Completion report (gitops §15 — fill on close)
- Value created:
- Capabilities enabled:
- Competencies improved:
- Value proposition (how this takes us closer to it):
- Delivery channels:
- Workflows operationalized:
- How to harness this value from UX:
