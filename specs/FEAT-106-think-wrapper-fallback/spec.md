# FEAT-106: Think wrapper + deterministic fallback

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)

## Outcome
User problem: the research pipeline needs LLM-driven orchestration and
faithful explanation without giving the LLM authority over gates, evidence,
or trading actions.
Expected benefit: Think handles tool dispatch and summarization; deterministic
code owns decisions; a fallback preserves the research path if the Think
workflow fails.

## Scope
Included: `ResearchAgent extends Think<Env>` (verified) — receives the
research request, dispatches the research tool exactly once per research
request, summarizes the persisted result under a research-only system
instruction. Deterministic fallback: if the Think workflow fails to produce
the expected persisted run, the orchestrator invokes the research pipeline
directly. The fallback preserves the research result path only.
Excluded: trading workflows (out of scope by design).

## Requirements
Functional:
- REQ-RES-050: the Think agent calls the research tool exactly once per
  research request.
- REQ-RES-051: the agent operates under a research-only system instruction:
  no order preview/submit/amend/cancel authority exists in its toolset.
- REQ-RES-052: the LLM may explain a persisted result; it cannot override
  deterministic gates or fabricate missing evidence.
- REQ-RES-053: fallback invocation is deterministic and logged; it does not
  create trading authority.

## Acceptance
See `acceptance.md`.
