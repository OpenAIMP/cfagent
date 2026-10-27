# ADR 0017: WorkflowPort is NOT a DAG

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner, #CISO-bhdm
- Issue: #1884 (stated for #1819's consolidated process doc)
- Implementing PR: #1890 (main commit, when merged)
- Related: docs/architecture/security/sessionstore-resource-process-1819.md §4,
  `src/workflows/workflowPorts.ts`

## Context

The #1819 consolidated process doc needed a plain statement of what
WorkflowPort's execution model actually is, because "DAG" was being
used loosely for two different things in the repo: the stage pipeline
and the shard fan-out. A mislabeled execution model misleads every
future slice that builds on it — a DAG slice designed against a
pipeline, or a pipeline change justified as "DAG support" that
exists in neither. This ADR pins the model as it stands on current
main, so future work argues from the code, not from the label.

## Decision

WorkflowPort is NOT a DAG today. Its execution model is three
things, none of which is a dependency graph:

1. **A fixed linear stage pipeline**: feed → gather → analysis →
   store → serve → deliver (`src/workflows/workflowPorts.ts`).
   Each stage persists its own results; analysis runs only on
   post-gather data. No step declares dependencies, no conditional
   edges, no topological scheduling.
2. **Parent → parallel shards → collation**: a parent job fans out
   to shards (default at most 4 in parallel,
   `DEFAULT_MAX_PARALLEL_SHARDS = 4`) that run in parallel and
   collate under the parent id. That is map-reduce, not a
   dependency graph — the shards are identical legs, not nodes
   with different upstream dependencies.
3. **A job state machine**: Idle → Running → [BudgetConstrained]
   → Completed | Failed → ReportGenerated, with at most 3 retries
   per step (`WORKFLOW_STEP_MAX_RETRIES = 3`) and idempotent step
   callbacks.

ScheduledAgent goals are likewise independent: no goal depends on
another.

A DAG slice, if one is ever built, would require: named nodes with
declared dependencies, topological execution, and branches/joins —
while keeping the existing stage vocabulary, claim-check commands,
and idempotency. That is a future WorkflowPort generalization
slice, not an existing capability, and no doc or PR may claim it
as one.

## Consequences

- Docs, PR bodies, and §15 reports must not describe WorkflowPort
  as a DAG, DAG-capable, or DAG-backed. The correct description is
  the three-part model above.
- A future DAG proposal is scoped by this ADR's requirement list:
  it must introduce declared dependencies and topological
  scheduling, not merely rename the shard fan-out.
- This ADR does not block the pipeline or the shard model from
  evolving; it blocks only the mislabeling. A change that keeps
  the model but renames stages, for example, is not a DAG slice
  and needs no DAG justification.
- The #1819 rollup work (ADR 0016) deliberately did not generalize
  WorkflowPort: scheduled aggregation rides ScheduledAgent, and
  this ADR is part of why that boundary held.

## Alternatives considered

- **Call the shard fan-out a DAG.** Rejected: the shards are
  identical parallel legs under one parent, not nodes with
  different upstream dependencies. Calling map-reduce a DAG would
  let a future slice assume dependency semantics (ordering,
  partial failure propagation per edge) that the code does not
  implement.
- **Call the stage pipeline a DAG.** Rejected: a fixed linear
  order with no declared dependencies and no branching is a
  pipeline. A DAG label adds nothing except the false implication
  that stages can be reordered or conditionally skipped by graph
  rules.
- **Add DAG execution incrementally without a graph model
  (e.g. ad-hoc conditional skips).** Rejected: conditional skips
  without declared dependencies are pipeline hacks, not DAG
  semantics, and would leave the model less honest than the
  current plain statement.
- **Leave the model unstated.** Rejected: the loose "DAG" usage
  was already spreading into process docs; an unstated model is
  decided by whoever writes the next doc, which is how drift
  starts (see gitops §23).
