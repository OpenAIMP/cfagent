# FEAT-105: Research card & report

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)

## Outcome
User problem: a reviewer must understand why an idea exists, what would prove
it wrong, and exactly which contracts and assumptions produce the payoff —
with failures visible, not hidden in logs.
Expected benefit: ranked cards + full report persisted once (canonical copy),
serving the UI, AI Search, and delivery from the same source.

## Scope
Included: ranked idea cards (identity, thesis, contracts, economics, risk
notes, decision record per docx §6); run report persistence via the #308
canonical seam — one `mas_reports` row per generation, the persisted typed
report (not an LLM paraphrase) as the downstream source of truth.
Excluded: per-run PDF rendering (#335, collaborator lane), delivery channels
(#336, collaborator lane).
Dependencies: FEAT-101 (canonical persistence), FEAT-103 (decision records).

## Requirements
Functional:
- REQ-RES-040: each card states run ID, config/rules version, symbol, outlook,
  rank, status; thesis with supporting AND competing evidence; invalidation
  conditions; per-leg contracts with quote source/timestamp and live/modeled
  classification; economics with assumptions; risk notes incl. explicit
  portfolio-limitation disclosure; gate decision record.
- REQ-RES-041: maximum contractual loss stated separately from stop-based
  estimates.
- REQ-RES-042: the card carries "research only; human review required" status.
- REQ-RES-043: the report is reproducible from saved config, source
  timestamps, candidate decisions, and rules version.

## Acceptance
See `acceptance.md`.
