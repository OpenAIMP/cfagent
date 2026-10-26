# 0003. Queue-backed messaging: port-first, provider adapter + in-memory adapter

- Status: accepted
- Date: 2026-10-26
- Deciders: owner, CAIO-quns
- Issue: #1739 (sub-issue of tracker #1736, first in the owner's priority order)
- Implementing PR: (to be filled on merge)

## Context

The in-memory `ScreenerEventBus` (`src/events/screenerEvents.ts`)
cannot guarantee delivery across Worker instances or restarts: it
lives inside one Durable Object, in one isolate. The ABoK Target
State Blueprint (§19, Top-10 item 3) therefore directs replacing
it with Cloudflare Queues, and its §11.3 event & messaging
standards require envelopes with eventId, eventType, timestamp,
correlationId, producer, payload, with idempotency keys mandatory
for all Queue consumption steps. The blueprint's principle #1
("Cloudflare Native First") is SUPERSEDED by owner direction for
this program: we use Cloudflare Queues, but with the option of
swapping in another provider in future — complete decoupling from
the underlying stack. The blueprint contains no portability
language; this ADR supplies it, following the same discipline as
ADR 0002 (D1 as one adapter behind a storage port).

The screener capability doc (`docs/architecture/application/
screener.md` §8.1) states that `screenerEvents.ts` +
`screenerPublishers.ts` already implement an async event bus
where delivery modules subscribe to `screener.completed` and
`screener.failed`. That statement was verified against code, not
assumed: `registerScreenerPublishers` subscribes to exactly those
two types, and they are the primary pub/sub surface this slice
makes durable. The doc is accurate, not stale — with one
precision: the bus is decoupled but in-process and synchronous
within the DO; the queue adds true async durability across
instances and restarts.

## Decision

### M1 — Port-first messaging (non-negotiable)

Domain code depends only on interfaces in `src/messaging/
messagingPorts.ts` (`MessageProducer`, `MessageConsumer`,
`MessagePublisher`, `MessageSubscriber`). The envelope is
CloudEvents v1.0 (owner decision 2026-10-26): required
attributes specversion "1.0", id, source, type, time, data,
plus lowercase extensions subject, correlationid, jobid,
parentjobid, shardid, stage — no Queue binding types, no
provider-specific options, no provider error shapes. Mapping
from the blueprint §11.3 names, semantics unchanged: eventId →
id, eventType → type, timestamp → time, producer → source,
payload → data. This closes assessment-01.md Recommendation 4
(P2 gap: CloudEvents v1.0 standardization), which repo
standards §7.1 already mandate. The ONLY
modules that touch a provider binding are the provider adapter
(`src/messaging/cfQueueMessagingAdapter.ts`) and the composition
root (`src/messaging/createMessagingPorts.ts`), which reads the
bindings out of the environment. A structural test pins that the
port, translators, consumer handler, composition root, and
in-memory adapter contain no provider concepts, and that domain
call sites never name the binding. A Cloudflare-coupled
implementation would be a scope failure even if it matched the
blueprint's letter.

### M2 — Two adapters, one conformance suite

The Cloudflare Queue adapter and the in-memory adapter implement
all four port interfaces, and the same conformance suite runs
unchanged against both. The in-memory adapter is the standing
proof that a second implementation plugs in cleanly; it is NOT a
silent production fallback (an in-memory queue in a worker
isolate cannot survive a restart, so substituting it for a
durable queue would lie about delivery guarantees). Production
hosts use the provider adapter when bound and the legacy bus
when unbound (composition root returns null).

### M3 — Both primitives, at different layers (owner design decision)

- Point-to-point (`send` / `consume`): job/command messages go
  to one work queue with competing consumers; each message is
  processed once, with exactly-once effect via the mandatory
  idempotency keys. This is the shape for work items such as
  run-screen jobs.
- Pub/sub (`publish` / `subscribe` / `dispatch`): domain events
  (screen completed, leg failed, report ready) are broadcast to
  MULTIPLE subscribers (projection writer, delivery, telemetry,
  reconcile), routed by type. Because provider queues are
  point-to-point, the provider adapter implements publish as
  fan-out to one queue per subscriber. It must NOT collapse
  broadcast into a single consumer that secretly calls
  everything — that breaks the decoupling and the future
  provider swap. One handler per (subscriber, type); a
  second registration replaces the first.

### M4 — Idempotency: the id IS the key

A consumer delivers a given id to its handler at most once
per consumer instance; a second delivery reports "duplicate" and
never re-invokes the handler. A "retry" disposition deliberately
leaves the id unmarked, so redelivery may retry. Broadcast
dedup is per (subscriber, id). Dispositions are
provider-neutral words (`processed` | `retry` | `drop`); the
adapter alone maps them to ack/retry mechanics. Invalid
(undecodable) messages are acknowledged with a warning — bytes
that can never decode would poison-loop on redelivery.

Dedup scope, stated honestly: the seen set lives in the
consumer instance (in the worker, module-level state shared
across batches in one isolate). Cross-isolate redelivery is
possible under at-least-once delivery; a durable cross-instance
dedup store is a follow-up, not this slice. Downstream scheduled
deliveries already dedup on their own stable delivery id.

### M5 — Event-driven shape, with both boundaries explicit

Choreography at the edges (producers emit envelope events,
consumers react independently) with workflow orchestration in
the middle (multi-step sagas are coordinated by workflow runs —
pure choreography alone would make runs unresumable and
unreasoned-about). Two boundaries stay explicit: (1) Durable
Object state remains authoritative and the D1 projection is
read-only — the audit log is append-only event history, not an
event-sourced system of record, so there are no
replay-from-projection semantics; (2) synchronous paths stay
synchronous where they must (HTTP responses, human approvals,
deterministic trade preflight/guardrails) — event-driven
architecture governs async work, not everything.

### M6 — Producer migration with a bus fallback; bus NOT deleted

`ScheduledTasksService.publishScreenerEvent` tries the durable
queue FIRST for the two bus-subscribed types
(`screener.completed` / `screener.failed`); the bus fallback
runs only when no subscriber stream received the event (no
bindings, or publish failed), so an event is never delivered
twice and never lost in-process. The `followupScheduler`
tracked-pipeline path is untouched (it stays the preferred sink
where wired). `options.*` events keep the legacy bus path: they
have no bus subscribers today, and their delivery stays on the
#223 direct path. The bus remains the consumer-side fan-out
inside the queue consumer (the queue is the durability
boundary, the bus is the local fan-out, the publishers are
untouched). Full bus retirement is a follow-up after the queue
path proves out in production, per the incremental-refactor
direction — not smuggled into this slice.

### M7 — Identity rule (#1185, unchanged)

The queue consumer dispatches under the data owner when
present, else the configured service identity; with neither it
returns "retry" — never under a fabricated identity, never a
silent drop of work that might succeed on redelivery. The
existing `options_analysis` consumer is untouched: same
point-to-point work-queue behavior, same rule.

### M8 — Screener-doc patterns applied, composed not duplicated

- Command pattern (§8.2): the envelope IS the command object
  for queue purposes — type names the command, id is
  the command id, correlationid ties it to its run, source
  names the issuer, data is the command body. No separate
  `IScreenerCommand` class is introduced in this slice: the
  only messages in flight are screener delivery events, and a
  commands/ directory with one inhabitant would be speculative
  structure. When the first job command (run-screen) lands, it
  gets a typed command module under the port. Audit trail:
  NO new audit store is created. Each published event's
  correlationid ties it to its existing run record (tracked
  pipeline job + canonical report, slice 3); when job commands
  land, their lifecycle audit goes through the existing
  `agent_chain_audit` table, not a new store.
- Claim Check (§8.2): envelopes carry IDs and references, never
  bulk data. Screener events reference runs by delivery id and
  artifacts by R2/DO keys (pdf/xlsx/csv keys, stage chain); the
  option chains and report bodies stay behind those references.
  The discipline is enforced: an envelope whose serialized form
  exceeds 128 KiB is invalid at every boundary (send, publish,
  consume), so bulk data can never cross the bus — it must
  be stored first and referenced instead. (The doc's "KV Store"
  target is stale — this codebase uses DO storage, not KV —
  so references are R2/DO pointers.)
- Dead Letter Queue (§8.2): NO separate DLQ table is created.
  The doc's D1/SQLite DLQ-table proposal is superseded by
  composition: queue-native dead-lettering is the mechanism,
  and the inspection/replay record belongs on the existing
  AgentDB audit/projection surfaces (`agent_chain_audit` +
  run records), not a duplicate store. In this slice no DLQ
  queue is wired either: the delivery subscriber retries via
  the consumer's max_retries and then drops (logged), and the
  run record persists so delivery can be re-triggered. DLQ
  wiring (max_retries + DLQ queue + inspection tooling) lands
  with the first job consumer, where retry exhaustion actually
  needs parking.
- Stage-layered DAG (§7.4, #1236): the queue edges are
  stage-compatible but no workflow is built here (that is
  #1737's shape). `screener.completed` / `screener.failed` are
  deliver-stage events; the delivery subscriber queue name
  encodes the stage; the existing stage-chain config rides
  inside the data untouched; type stays an open,
  stage-compatible string at the port, so feed/generate/store/
  serve/deliver command types plug in without a port change.

### M10 — Stage/job message shape (owner stage-architecture spec)

Stage execution belongs to #1737; what belongs here is the
message shape that execution will use, so #1737 does not have
to reopen the envelope. The envelope carries optional `jobid`,
`parentjobid`, `shardid`, and `stage` extensions (validated when
present: non-empty strings; `stage` must be a known stage).
They make job/sub-job fan-out, collation, and per-stage resume
expressible in messages: a parent job (one request — one ticker
or all tickers) fans out to sub-jobs (shards, e.g. one ticker
each) that run in parallel and collate under the parent id;
each stage resumes and retries from its own last
checkpoint/input, identified by job + shard + stage. The stage
order is feed → gather → analysis → store → serve → deliver:
feed (collect from multiple providers) and gather (combine +
enrich) are TWO separate stages, and analysis runs only on
post-gather data, persisting its own results like each prior
stage persists its own independently (§7.4's "generate" is the
analysis stage in this split). Stage-typed events are first-class
type values (`stageEventType(stage, outcome)` builds
"feed.completed" and siblings); screener completion/failure
events carry `stage: "deliver"`. Triggers are trigger-agnostic:
UX events and scheduled events produce the same envelope and
the same execution path; the `source` field records the
trigger source for audit (`scheduled-tasks` vs an
interactive/manual producer) and the consumer never branches on
it. The job model aligns with slice-2 `agent_shard_jobs` (one
row per chain/job/version, terminal rails) as job id / parent
chain id / shard leg id — no second job model is invented. Two
mismatches are noted for #1737's design, not duplicated here:
(1) qualified partial results (a per-shard timeout yields
partial results with audit status, never total failure) have no
home in the terminal rails (completed/submitted/failed) —
partial is not terminal, so collation state needs either a new
outcome value or a separate collation record; (2) the
projection's version column is deliberately not carried in the
envelope (replay/versioning is projection state, not message
state). Per-stage resume/checkpointing, configurable parallelism
bounded by platform limits (#1204), per-shard timeouts, and
collation itself are #1737 execution concerns.

### M9 — Wiring in this slice

- `wrangler.jsonc` gains a `queues` section: producers for
  `screener-events` (work queue) and `screener-events-delivery`
  (delivery subscriber queue); a consumer ONLY for
  `screener-events-delivery`. The work queue stays producer-only
  until the first job handler arrives — its consumer arrives
  with that later work, not as a retry-all stub here.
- `Env` gains optional `SCREENER_EVENTS` /
  `SCREENER_EVENTS_DELIVERY` bindings (optional so code is safe
  before the bindings propagate).
- `src/server.ts` `queue()` routes `screener-events-delivery`
  batches through the subscriber batch bridge and returns; all
  other batches fall through to the existing path untouched.
- No new HTTP routes are added, so no endpoint-catalog change.

### Out of scope, recorded not absorbed

Discovery convergence (#29/#1096), report unification (#1209 —
partly advanced by slice-3 canonical reports), subrequest
budgeting (#1204 → #1745), filter-chain / builder / composite /
indicator-plugin refactors (incremental screener-dimension
backlog), Workflows (#1737), Agents SDK (#1738), RAG (#1740).
Out-of-dimension blocking refactors, if any surface, are noted
as follow-ups rather than expanding this slice.

### Follow-ups (not this slice)

Durable cross-instance dedup store; bus retirement after the
queue path proves out in production; work-queue consumer with
the first job command (typed command module + DLQ wiring +
inspection tooling); an options.* subscriber if options
delivery moves onto the bus; stage-typed job commands consumed
by #1737 workflows.
