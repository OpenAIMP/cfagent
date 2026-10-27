# ADR 0018: CAIO alignment for #1819 resource instrumentation

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner, #CISO-bhdm
- Issue: #1819 (consolidation: #1884)
- Implementing PR: (this slice's PR; main commit, when merged)
- Related: ADR 0015 (instrument first), ADR 0016 (ScheduledAgent
  rollup), docs/architecture/security/sessionstore-resource-process-1819.md §2,
  CAIO track #1736 (program), #1742 (port pattern), #1743 (schema/transport),
  #1741 (gateway stats)

## Context

The standing reciprocal rule between lanes is: when either lane
defines a port, the other checks first and consumes or links —
never duplicates. Resource usage became one more event type in the
CAIO track's stream, not a second pipeline. The CAIO track already
carried three relevant pieces on current main, and #1819's
instrumentation had to decide, for each, whether to reuse, consume,
or leave alone — with the owner direction (2026-10-27) that the
instrumentation be built now in the aligned shape, and dashboard
data supplied afterwards for comparison.

## Decision

One telemetry home (`src/telemetry/` + `src/observability/`), one
schema, one degradation path, one rollup story. Concretely:

- **Reuse #1742's port pattern, not its data.** #1742 (merged;
  `src/telemetry/`) defined `TelemetryPort` with D1 and in-memory
  adapters and a composition root. The resource side follows that
  shape: `ResourceUsagePort` (`src/telemetry/resourceUsagePorts.ts`),
  composition root `src/telemetry/createResourceUsagePorts.ts`,
  D1 adapter (`src/telemetry/d1ResourceUsageAdapter.ts`),
  in-memory adapter, and fan-out adapter. #1742's subject is
  thesis realization / prompt calibration, not resource usage: the
  pattern is reused, the data is not.
- **Consume #1743's landed schema and transport.** #1743 (closed;
  PR #1842 merged `e989e33`; `src/observability/`) provides one
  event schema with tenant/run/session scope on every event, W3C
  traceparent, key-based redaction (session as truncated-hash
  `sessionRef`, never the session id), an Analytics Engine adapter
  plus an in-memory adapter behind a conformance suite, and
  local-logging degradation when Analytics Engine is down.
  Resource events convert via `toObservabilityEvent` to type
  `resource.sql_op` inside this schema. Analytics Engine accepts
  exactly one index — tenant-as-index1, type/level as blobs — and
  resource events fit that envelope; they do not invent new
  indexes.
- **Consume #1741's gateway stats as a resource class.** #1741
  (closed; PR #1838 merged `3820f77`; `src/gateway/`) fronts every
  LLM text-inference call, and its stats surface as an optional
  field on the existing telemetry summary route. LLM tokens/spend
  join the resource picture as a consumed resource class; this
  work does not absorb gateway routing.
- **Add only what the CAIO track did not carry:** the resource
  dimension (rows read/written per statement, caller, trigger, with
  statement fingerprints only — never bindings, tokens, or user
  data); scan-shape detection and sampling (full logging for
  scan-shaped ops, sampled logging for small ops, so the
  instrumentation does not become its own cost center); and the
  rollup/alert as consumer queries over the event stream (ADR
  0016), not a second aggregation system.
- **Deliberately NOT consolidated away:** the IAAA audit trail is
  untouched, #1742's thesis telemetry keeps its own subject, and
  #1741's gateway keeps owning inference routing.
- **Open question, answered for the queryable path:** at
  instrument-first time it was open whether the resource port
  needed its own D1 projection table (following #1742) or lived
  purely as Analytics Engine events. As built, the rollup slice
  answered it: the D1 projection (`resource_sql_ops`) exists
  because there is no in-Worker Analytics Engine read path, so the
  goals query D1 while Analytics Engine remains the transport.
  Whether a future Analytics Engine read path would retire the
  projection is a follow-up decision, not something this ADR
  settles.

## Consequences

- No second pipeline, no second store, no second alerting path for
  resource usage. A future resource consumer reads the same schema
  and the same stream, or files its own ADR explaining why not.
- The one-index discipline constrains event design: any new
  resource event type must fit tenant-as-index1 with type/level as
  blobs, or the constraint itself must be renegotiated with the
  CAIO track — not silently bypassed with a new index.
- The IAAA audit trail's separation is a boundary, not an
  oversight: resource events must never be merged into audit
  records, and audit records must never be used as a resource
  telemetry shortcut.
- Seams stay existing seams, not new ones: the `cfAgentsAdapter.ts`
  SQL seam, the SessionStore `/kv` reply path (cursor-measured
  rows summed across the op's statements), and D1 per-query
  `meta.rows_read` / `meta.rows_written`. Zero new round-trips
  for emission: DO cursor counters were already computed for
  billing and previously thrown away, and the Analytics Engine
  write is synchronous and buffered by the runtime, so the sink
  never awaits a network round-trip and a sink failure never
  fails the producer.

## Alternatives considered

- **A second, resource-only pipeline (own schema, own store, own
  alerting).** Rejected: it duplicates the CAIO track's stream
  against the reciprocal rule, and every future consumer would
  have to choose between two homes for the same fact.
- **A resource-only event schema inside the CAIO transport.**
  Rejected: two schemas on one transport is the same duplication
  one layer down; `resource.sql_op` inside the landed schema
  carries the same information with one envelope.
- **Absorbing #1741 gateway routing into the resource module.**
  Rejected: ownership. Gateway stats are a consumed resource
  class; routing stays with the gateway, or a future slice
  re-decides ownership explicitly.
- **Merging resource events into the IAAA audit trail.**
  Rejected: audit is an attributable security record, not a
  telemetry stream; mixing volumes of per-op rows into it would
  degrade both purposes.
- **No D1 projection (Analytics Engine events only).** Rejected
  for the queryable path: with no in-Worker Analytics Engine read
  path, the ScheduledAgent goals (ADR 0016) would have nothing to
  query. Kept open as a follow-up if a read path ever lands.
