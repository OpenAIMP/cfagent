# 0021. Chat page deferred from the PageShell standard

- Status: accepted
- Date: 2026-10-27
- Deciders: owner, CPO-dhmp
- Issue: #1991 (nav-shell S4; the deferral was recorded in the issue body when S4-B corrected the page inventory)

## Context

The nav-shell standard (#1804) says every left-nav page renders inside
`PageShell`: title (h1) + scope note + sections. After S4, 25 of the 26
route ids comply; the conformance list
(`tests/shell_conformance_1804.json`) holds all of them.

`chat` is the exception. It renders `AgentChatTabContent`, the
conversational home: a composer, not a page of sections. It has no page
header to promote into a shell title, and putting an h1 + scope note
above the composer would change the product's home surface, not just
its chrome.

## Decision

`chat` is deferred from the PageShell standard as a product decision,
not a migration gap. No shell is added to the chat page unless the
owner decides the conversational home should carry page chrome.

- This deferral covers `chat` only. It does not exempt any other page,
  and it does not reopen the token-architecture exemption question
  (ADR-0004 stands: no exemptions there).
- The epic #1804 closes with `chat` deferred, not with every nav entry
  listed. The conformance list stays at 25 of 26, with this ADR as the
  record for the missing entry.
