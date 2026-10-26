# 0004. UX token architecture compliance is mandatory — no exemptions

- Status: accepted
- Date: 2026-10-26
- Deciders: owner, CPO-dhmp
- Issue: #1705 (A3-c of #1579; the decision was forced by its CI failure)
- Implementing PR: #1791 (to be filled on merge)

## Context

The UX token architecture requires surfaces to be built only from
`src/client/components/ui/` primitives with token-only styling. The
token-governance ratchet (`tests/ux_token_coverage_ratchet.test.ts`)
enforces it for new surfaces: a `.tsx` file under `src/client` that
renders JSX and imports nothing from `components/ui/` fails unless it
is listed in the exemptions of `tests/ui_primitives_1337.json` with a
reason.

PR #1791's new `ApprovalsPanel` tripped that ratchet: the panel renders
JSX (header, intro, sections) but imports only the two queues it
composes, no primitive. The first fix recorded the panel as an
exemption with a reason — the registry's first-ever entry — and CI went
green on it. The owner rejected that fix as a category: exemptions make
the architecture partial, and partial is not the goal.

## Decision

Compliance with the UX token architecture is mandatory, with no
exemptions. It is all or none.

- Every surface, including composition-only surfaces, must satisfy the
  ratchet by genuinely composing from `ui/` primitives. A surface that
  renders no controls itself still needs its own chrome to be
  primitive-built (for example, the ApprovalsPanel header block is a
  `Card`); the controls it contains must come from primitive-built
  components.
- No entry may be added to the exemptions of
  `tests/ui_primitives_1337.json`. The registry stays empty. A surface
  that cannot comply must be reworked until it complies; its PR stays
  red until then.
- This ADR does not delete the exemption mechanism from the ratchet
  test. The mechanism remains in code but its use is prohibited by this
  decision. Removing the mechanism is follow-up work, not part of this
  decision.

## Consequences

- The ApprovalsPanel exemption added by #1791's fix commit is reverted
  in the same PR, and the panel is reworked to use the `Card`
  primitive for its header block. The ratchet passes on the rework,
  with no exemption.
- Future surfaces must be designed primitive-first. A designer who
  cannot find a genuine primitive use has a design problem, not an
  exemption case: either the surface's chrome can be primitive-built,
  or a new primitive is needed (which is itself a UX-architecture
  decision).
- Cost: occasionally more design work up front, and no escape hatch
  when a deadline presses. Benefit: the architecture converges to
  zero raw controls instead of stabilizing at "mostly compliant with
  documented exceptions."

## Alternatives considered

- Exemption with a reason (the ratchet's designed path). Rejected:
  exemptions accumulate, each one is individually reasonable, and the
  result is a partially-compliant platform. The owner decided all or
  none.
- Decorative primitive import (import a primitive without using it
  meaningfully, e.g. a type-only import). Rejected: it games the gate
  and is worse than an honest exemption, because it hides
  non-compliance behind a passing check.
- Wrapping the whole panel in a `Card`. Rejected for this panel: the
  queues already render their own Cards, so a full wrapper nests
  cards for no user benefit. The adopted shape — `Card` for the
  panel's own header chrome only, queues unwrapped — is the genuine
  primitive use.
