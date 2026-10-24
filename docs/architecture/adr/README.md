# Architecture Decision Records

Decisions that are hard to reverse or cross-cutting live here, one file
per decision, so the reasoning survives the issue thread that made it.
See `gitops.md` §5 ("Architecture decision records") for when an ADR
is required: a PR MUST create or update one when it makes such a
decision or overturns a recorded one. Routine slices, bug fixes,
docs-only conforming edits, and configuration changes do not need one.

Rules: ADRs are never deleted or rewritten. A changed decision gets a
new ADR that supersedes the old one, and the old ADR's Status is
updated to superseded with a pointer. The issue that makes the decision
references the ADR; the ADR references the issue and the implementing
PR.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-derived-stable-identity.md) | Derived stable identity from (issuer, subject) | Accepted |

## Template

```markdown
# NNNN. Short title

- Status: proposed | accepted | superseded by NNNN | deprecated
- Date: YYYY-MM-DD
- Deciders: (owner, agent, reviewers)
- Issue: #NNNN
- Implementing PR: #NNNN (main commit, when merged)

## Context

What problem forced a decision, and what constraints applied.

## Decision

What was decided, precisely enough to implement and to test against.

## Consequences

What follows from the decision, including known costs and warts.

## Alternatives considered

Each alternative and why it was rejected.
```
