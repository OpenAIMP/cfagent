# ADR 0009: RSI Telemetry & Calibration Engine in D1

- **Status:** Accepted
- **Issue:** #1742 (sub-issue of #1736, item 6)
- **Design basis:** `docs/architecture/code/component-taxonomy-01.md` §5
  (RSI roadmap: Level 3 → Level 4 closed-loop tuning) and §11
  Phase 3 (RSI transformation); screener-doc §13.1 Phase 4
  governed RSI as the later horizon.
- **Related ADRs:** 0002 (data foundation layer, R1–R9),
  0003 (messaging port, CloudEvents envelope), 0005 (actor
  port), 0007 (hybrid RAG), 0008 (circuit breakers).

## Context

Thesis outcomes were tracked manually and sporadically: no
automated record of whether agent theses realized, so prompts
were never calibrated against measured outcomes and prompt
changes could not be evaluated. A calibration dashboard
(`buildCalibrationFromTrackRecord`, #654) and a
calibration-driven weight-adjustment job (#754) exist, but
both read the DO track record; neither writes D1, and
neither closes the loop to prompts.

## Decision

### 1. Port-first telemetry store (R1, R2, R7)

New `src/telemetry/` port: `TelemetryStore` (realization
writes/queries/metrics + calibration decision lifecycle)
with a Drizzle D1 adapter and an in-memory adapter, one
conformance suite run unchanged against both. Domain code
never imports a store client. Migration 0006 adds
`agent_thesis_realizations` (one row per tenant+outcome;
the primary key is the idempotency guarantee) and
`agent_calibration_decisions` (one row per decision,
updated in place through the governed lifecycle — the row
IS the audit trail). Tenancy is enforced at the repository
boundary (tenant id resolved server-side, never caller
input). Retention decided up front per R8: both tables
KEEP (evaluation-paced accrual, not per-request; the
decision row is the approval trail). No session/credential
material is ever projected (R9).

Realization rows LINK to the slice 1–3 projections by
reference (runId always; reportId/chainId when the source
knows them) — they do not re-implement them. This is the
recorded boundary with #1717 (i) goal chain/AgentDB: that
slice owns the projection tables; this slice only references
them. No changes to their writers were made.

### 2. Falsification is the calibration signal

A proposal triggers only when a (agent, thesis) slice is
both sufficiently sampled (>= 20 evaluated ideas — the
same floor the dashboard uses for low-sample flagging) and
majority-falsified (falsificationRate > 0.5, strictly; a
tie is noise, not a signal). Raw accuracy alone never
proposes: a 60%-accurate thesis is not a calibration
candidate, a 33%-accurate one is.

Proposals attach to THESIS slices only. Agent/structure/
regime/month aggregations are diagnostic metrics, not
proposal triggers: a prompt note attaches to a thesis
prompt slot, not to a month. A systematically wrong
structure surfaces as one proposal per falsified thesis in
it, each independently sampled.

### 3. Governed application (champion/challenger idiom, not its gate)

The gate reuses #1140's idiom without rebuilding its gate:

- **Frozen snapshot:** the metric snapshot is frozen at
  proposal time; there is no update path for it. A new
  measurement needs a new proposal.
- **Dedupe:** an open (proposed/approved) proposal for the
  same (tenant, actor, prompt slot) blocks a duplicate.
- **Authorized approval:** the approver must be a human,
  non-system actor who is not the proposer. System and
  nightly actors may create proposals, never approve them.
- **Audited, reversible application:** application records
  the applier, the timestamp, and the prior note; supersede
  or expire stops resolution immediately. The halt story is
  supersede/expire via the admin route — no new kill-switch
  flag was invented.
- **Deliberate difference from #1140:** the applier need not
  equal the approver (operations may apply an approved
  decision), but both are recorded and both must be human,
  non-proposer actors.

The engine never rewrites prompts by itself and no model
call decides a proposal, an approval, or a note. The
applied artifact is a deterministic, evidence-grounded
calibration NOTE generated from the frozen snapshot.

### 4. The actor-turn plug (no runner change)

Calibration plugs into the actor turn through the hook
boundary, not by replacing the actor port:
`applyCalibratedPromptToInstructions` appends the active
note to a beforeTurn's instructions. The runner is
untouched. A missing note is a byte-identical no-op; a
resolver failure degrades to base instructions (warned,
never thrown) — calibration never blocks a turn.

### 5. Consumed hooks, not redefined ones

- **#1745 breaker hooks:** the telemetry summary reads
  live breaker health from `defaultBreakerRegistry()`
  .snapshots() (state, trip counts, fallback counts per
  provider). No breaker state is duplicated into D1.
- **#1740 retrieval.completed hook:** the memory_search
  route builds the envelope with #1740's own
  `toRetrievalCompletedEnvelope` builder and folds it into
  a per-isolate accumulator (counts only, same ephemeral
  loss semantics as breaker state). Retrieval counts are
  NOT persisted: the durable home for retrieval streams is
  #1743's Analytics Engine pipeline (named follow-up).
- **#1739 CloudEvents envelope:** all telemetry stream
  envelopes (`telemetry.realization_recorded`,
  `telemetry.calibration_proposed`,
  `telemetry.calibration_applied`) use it, with
  deterministic ids as idempotency keys, counts/ids only —
  never prompt text, never thesis text. Emission is
  best-effort, swallowed + logged.

### 6. The #754 relationship (extended vs replaced: neither replaced)

The #754 weight-adjustment job is UNTOUCHED: its weekly
cadence, ISO-week guard, kill switch, and #755 audit seam
all stand. This slice reuses its vocabulary (per-thesis/
per-structure/per-regime slices, the 20-sample floor) and
its governance idiom, and adds the prompt-note path #754
never had. Weights stay with #754; prompts move through
this engine. The dashboard is likewise untouched (its
outputs for fixed inputs are pinned by regression test).

### 7. Automatic recording + reconciliation

- **Automatic:** `ResearchAgent.evaluateRun` projects
  scored ideas to D1 best-effort after the evaluation row
  write (own try/catch, unbound skips silently). Both
  callers (manual `/research/evaluate` and the due-runs
  pass) flow through `evaluateRun`, so both project. The
  projection join is (symbol, structure) — the same join
  the track record uses — and the regime string is derived
  with the dashboard's own `reportRegime` (newly exported
  for reuse, behavior unchanged).
- **Reconcile:** `POST /api/telemetry/reconcile`
  (platform-admin) imports scored track-record ideas for
  one `research:<login>` instance, bounded 500/call;
  repeat calls converge (already-recorded outcomes are
  skipped, the report names the deferred remainder).

## Consequences

- Thesis realization is queryable per thesis, per agent,
  per structure, per regime, and over time from D1.
- Prompt calibration is visible and auditable instead of
  anecdotal: every applied note traces to a frozen
  measurement snapshot and a recorded approval.
- Metrics aggregate in the adapter over plain SELECT rows
  (O(rows) reads). Realizations accrue at evaluation pace
  (capped due-runs), so this is bounded today; pushing
  aggregation to SQL is a named follow-up if volume grows.

## Follow-ups (not this slice)

- #1743 Analytics Engine stream (the durable home for
  telemetry.* envelopes and retrieval counts).
- SQL-side metric aggregation if realization volume grows.
- Champion/challenger gate integration (§13.1 Phase 4:
  mas_outcomes falsification feedback, regime-conditioned
  weights) — this slice is its telemetry core, not the gate.
- Live-production verification of the evaluateRun hook on
  the next real evaluation (wiring-only; covered by
  typecheck + projector tests, not by a DO harness).
- Main Audit re-dispatch follow-up carried from #1739
  (unrelated to this slice; still open).
