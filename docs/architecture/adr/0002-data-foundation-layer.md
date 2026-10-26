# 0002. Data foundation layer: port-first, Drizzle ORM, D1 as one adapter

- Status: accepted
- Date: 2026-10-25
- Deciders: owner, CAIO-quns
- Issue: #1548 (slice 0; design #1546)
- Implementing PR: #1553

## Context

The agentic program has no shared query surface. Each Durable
Object owns its own SQLite database; synthesized schedules and
goals live in ScheduledAgent `ctx.storage`, not SQL; and the bare
ScheduledAgent `*/30` tick carries no Orchestrator `mas_settings`
SQL, so a global halt thrown in the Orchestrator does not stop a
bare tick (the disclosed lane-1 gap from #1517). The D1 AgentDB
design (#1546, approved) and its binding (PR #1547, merged: the
owner-created `agentdb` database bound as `AGENT_DB`) supply the
shared store. What was missing was the layer that makes that store
safe to build on: one topology, one migration story, one tenancy
enforcement point, one transaction model — built cloud-native
(Workers runtime as deployed) and cloud-agnostic (no domain logic
knows which cloud it runs on).

## Decision

### R1 — Port-first architecture (non-negotiable)

Domain code depends only on interfaces in `src/data/*` port
modules (`HaltReader`, `GovernanceProjectionWriter`, and later
chain/schedule/job/audit/report ports). No domain file imports a
store client, references `env.AGENT_DB`, or writes SQL. The
composition root (`src/data/createGovernancePorts.ts`) wires
`env.AGENT_DB` → adapter → ports. The port test suite passes
unchanged against the D1 adapter and an in-memory adapter; a
structural test pins that port modules import no store client
and domain modules import no ORM.

### R2 — Dialect isolation in exactly one place

All query-builder code lives in adapter modules. The portable
subset is fixed: `?` positional parameters (rewritten per
adapter by the ORM), integer millisecond epoch timestamps (never
datetime strings, never dialect date functions), `ON CONFLICT`
upserts with `onConflictDoNothing` for idempotent replays, no
`RETURNING` in the portable path (read-back after write
instead). A dialect-conformance suite (one test file, run
against every adapter) pins this; a query passing on D1 but
failing on Postgres is a layer defect.

### R3 — Portable versioned migrations

Ordered migration files applied by a small runner
(`src/data/migrationRunner.ts`) that records applied versions in
a `_migrations` table owned by the runner. First-definition-wins
is abolished: a table's DDL lives in exactly one migration file,
and the Drizzle schema mapping is pinned to agree with it by
test (the migration file wins on drift). Rollback is a forward
compensating migration, never an edit to an applied file.
Migration SQL must not contain a semicolon inside a string
literal (the runner splits on `;`). Schema changes update the
registry/pin test in the same PR (the F1 pattern).

### R4 — Tables, with two corrections to #1546

Slice 0 ships `agent_governance` only (halt rows: `tenant_id`,
`scope`, `state`, `set_by`, `set_at_ms`, `reason`, plus
`version`/`provenance`). The remaining #1546 tables
(`agent_chains`, `agent_synthesized_schedules`,
`agent_shard_jobs`, `agent_chain_audit`, `agent_reports`) land in
later slices. Two corrections to #1546 are adopted now:
(i) `agent_chain_audit` will be row-per-event append-only —
never the single-key JSON-array log that made IAAA audit racy;
(ii) `agent_shard_jobs` will capture lane-2 executor outputs,
not just `mas_async_jobs` rows, because inline execution never
writes that table.

### R5 — Projection write path (the consistency contract)

Durable-object storage stays authoritative for execution;
AgentDB is written on state transitions only, never as a second
writer, and on conflict the durable-object state wins. Writes
are idempotent (deterministic event ids, `ON CONFLICT DO
NOTHING`), so at-least-once delivery is safe. Because no
transaction spans a durable object and D1, the contract is:
write durable-object state first, then project (never the
reverse), except for the halt ordering in R6. A projection
failure never fails the execution transition — it is recorded
and reconciled by a periodic job that re-projects any
durable-object state newer than its projection row. Reads may
lag one transition; any consumer that cannot tolerate lag must
read the durable object directly and say so.

### R6 — Cross-DO halt read as a first-class query

`HaltRead` is the single synchronous exception: the halt mirror
is written synchronously on halt-set, and a failed halt read
fails closed (treated as halted). "Synchronous" here means
same-call-path write and fresh read on the firing path — not
JavaScript-synchronous, since the D1 API is async. The safety
ordering (verified reasoning): the ordering protects the
tick-facing read path, because the tick is the safety-critical
firing path and the mirror is its source of truth. For SET,
mirror first then the durable-object setting: if the setting
write then fails, the error surfaces and the mirror already
reads halted, so the tick refuses to fire while the operator
reconciles. For CLEAR, setting first then the mirror: if the
mirror write then fails, the error surfaces and the mirror
still reads halted, so the tick stays halted. In both
directions a partial failure leaves the tick-facing read halted
or the system unchanged — never silently clear. Full
convergence after any partial failure is the R5 reconciliation
step, which is why a mirror failure must surface as an error,
never a log line.

### R7 — Tenancy enforced at the boundary

The adapter injects `tenant_id` into every query. There is no
unscoped read method on any store. Cross-tenant negative tests
ship with the layer. The tick's tenant defaults to `"primary"`
(the documented single-tenant default, same as IAAA) until a
tenant context is threaded through the tick; a multi-tenant
deployment must set it explicitly.

### R8 — Retention decided up front

Each projection table gets a retention rule in the PR that
creates it, reusing `src/security/storageRetention.ts` as the
single contract. Slice 0's line: `agent_governance` rows are
append-only audit history and are long-lived (no pruning in
this slice). The R2 lifecycle/orphan-sweep decision (#338) is
still open and is recorded as such, not assumed.

### R9 — What the layer is not

Not a replacement for durable-object SQLite (execution state
stays there), not a replacement for Vectorize (semantic recall
stays there; AgentDB answers exact queries), not a new
execution path (no chain runs *from* AgentDB), and never a
session/credential store — a projection writer that accepts a
session or credential row is a defect, pinned by test.

### ORM choice: Drizzle ORM (evaluated, not assumed)

Transactions in the foundation are managed through an ORM, not
hand-rolled SQL strings in domain code. Drizzle ORM 0.45.4 is
the foundation ORM, evaluated first against the slice-0
requirements:

- First-class D1 driver (`drizzle-orm/d1`), SQLite and Postgres
  drivers, one schema/query-builder across dialects.
- `db.transaction()` maps to each store's native transaction
  mechanism — with the D1 caveat below.
- Workers-friendly (no Node-only dependencies, small bundle).
- `drizzle-kit` SQL migrations exist, but slice 0 uses
  hand-written portable migration files + a small runner
  instead, because the runner must also serve the future
  Postgres adapter with identical files; drizzle-kit generation
  is a future option, not a slice-0 dependency.
- Proven in this slice by test: the real `drizzle-orm/d1`
  driver runs in CI against a mock `D1Database` interface
  backed by node:sqlite — no Cloudflare credentials, no live
  D1 calls from tests. The mock matches real D1's async
  `prepare`/`bind`/`run`/`all`/`first`/`raw`/`batch` surface
  (verified against `drizzle-orm/d1/session.js`).

Considered alternatives, with reasons recorded:

- Kysely: capable query builder, but D1 support is via a
  community dialect only, and its migrations story is weaker
  for the portable-files requirement.
- Prisma with driver adapters (`@prisma/adapter-d1`,
  `@prisma/adapter-pg`): heavier, with Workers cold-start and
  bundle risk, and weaker multi-dialect schema portability for
  the single-schema requirement.
- TypeORM / Sequelize / MikroORM: ruled out — Node-centric,
  not edge/Workers-friendly.
- Incumbent hand-rolled `src/orm` DatabaseORM/Repository: stays
  as the durable-object SQLite implementation detail. It is NOT
  the foundation ORM and is not replaced wholesale in this
  slice: it has no transaction management (no BEGIN/COMMIT in
  the codebase) and its schema evolution is the scattered
  `CREATE TABLE IF NOT EXISTS` pattern this layer abolishes.

### Transaction model (platform honesty)

No ORM can give one ACID transaction spanning a durable
object's SQLite and D1 — that is a platform fact, not a library
gap, and this ADR does not claim otherwise. The model is:

- Per-store ORM transactions for operations inside one store:
  D1 single statements (atomic by themselves), D1 `batch()`
  for multi-statement atomicity on D1, durable-object SQLite
  transactions and Postgres transactions via the ORM where
  the adapter supports them.
- Cross-store consistency via idempotent projection writes +
  reconciliation (R5), with the safety-directed halt ordering
  (R6) as the exception.
- Two D1-specific findings, verified against the driver source
  (`drizzle-orm/d1/session.js` in 0.45.4):
  - `db.transaction()` on D1 is implemented as sequential
    BEGIN/COMMIT statements, not as a single batch. On D1's
    request-per-statement API this is not Postgres-equivalent
    atomicity. Slice 0 therefore never relies on
    `db.transaction()` for atomicity on D1: migration safety
    comes from idempotent statements plus the `_migrations`
    row written last as the commit marker.
  - Test-fidelity caveat: the node:sqlite-backed mock DOES
    hold a real interactive transaction across BEGIN/COMMIT,
    so mock transactions are stronger than real D1's. Tests
    must not assert atomicity through `db.transaction()` on
    the mock as if it proved D1 atomicity.

### Seed procedure (one-time, at cutover)

The halt seed ships in slice 0 (`seedGovernanceHalt`): it reads
the current `mas_settings` `adaptation.killSwitch` value and
writes one mirror row (state halted or clear, provenance
`seed:cutover`). It never writes the durable-object setting,
and a second run is a no-op. It is a deliberate operator step,
never boot logic: the operator runs it once at cutover through
the same maintenance path used to manage the kill switch today
(no in-repo writer for that setting existed before this slice;
`setGovernedHalt` is now the canonical setter, and its first
route-level caller lands in a later slice). Without the seed, a
pre-existing halt is invisible to the new read path.

The canonical `mas_reports` seed is approved but ships with the
later reports slice; that table does not exist yet and is not
built here.

## Slice 1 addendum (issue #1651, chains + schedules projection)

- Status: accepted with slice 1; the R1–R9 contract above is
  unchanged and governs this slice.
- Tables (migration 0002, DDL in exactly one file): `agent_chains`
  and `agent_synthesized_schedules`. Every row carries
  `tenant_id`, `workspace_id`, `chain_id`, `version`,
  `created_at_ms`, `updated_at_ms`, and provenance
  (`provenance_writer`, `provenance_source_do`,
  `provenance_source_version`, the last being the row-shape
  version of the DO record mapping, 1 in slice 1). The `id`
  primary key is the deterministic replay key
  `<tenant_id>:<id>:<version>`; replaying the same version
  conflicts and is a no-op under `onConflictDoNothing` writes.
  Tenant/chain/version indexes serve the latest-row reads.
  Chain rows carry `goal` + `steps_json` (capability ids and
  stages only); schedule rows carry `kind` + `cron`. Neither
  row type carries auth material of any kind.
- Writer wiring points (the real transitions, no parallel
  paths): `ScheduledAgent.synthesizeSchedule`,
  `approveSynthesizedSchedule`, and `killSynthesizedSchedule`
  in `src/agents/scheduled-agent.ts`. Each saves DO state
  first, then best-effort projects via the composition root
  (`src/data/createChainSchedulePorts.ts`); a projection
  failure is logged and reported, never thrown to the
  transition. Honesty note: the pure compilers
  (`compileGoal`/`compileChain` in `src/orchestrate.ts`) and
  the registry produce no persisted identity, so no chain row
  is written at compile time — the chain row is created at
  synthesize (the first persisted transition) with `chainId`
  equal to the synthesized record id, and approve/kill advance
  it. Wiring a projection into the compiler would have
  fabricated an id and invented a parallel path; it was
  deliberately not done. `scheduleId` equals `chainId` in
  slice 1 because one synthesized record is one chain instance.
- Reconciliation design: `reconcileChainSchedules`
  (`src/data/chainScheduleProjection.ts`) compares each DO
  record's status against the latest projected chain and
  schedule rows; a missing or stale projection is re-projected
  as a new version row, a current one is left untouched, and
  per-record failures are collected in the report, never
  thrown. Invocation is a deliberate operator/maintenance
  step only: `ScheduledAgent.reconcileChainScheduleProjection`
  plus the admin-gated POST `/api/chains/reconcile` route
  (requireAuth → wired session → live platform-admin
  membership, the slice-0 seed pattern). It is never boot
  logic, never auto-run on deploy or tick — R5 justification:
  reconciliation is a repair pass over already-persisted
  state, not a firing path, so running it on a schedule would
  silently rewrite query state outside any operator decision.
  The operator invokes it after a recorded projection failure,
  and its report states exactly what changed.
- Query API: GET `/api/chains/status?chainId=` (requireAuth;
  tenant from IAAA resolution) reads the projection only via
  `readChainStatus` — never the durable object — and returns
  the latest chain + schedule rows for that tenant, or
  `projected:false` when nothing is projected. Unbound
  AgentDB answers 503. The route returns projection fields
  only (id, status, version, kind, cron, timestamps).
- Tenancy: the adapters inject `tenant_id` into every query;
  there is no unscoped list-all method. Tenant and workspace
  default to `"primary"` (the documented single-tenant
  default, same as the slice-0 tick) until a tenant context is
  threaded through ScheduledAgent; a multi-tenant deployment
  must set it explicitly.
- Retention: `agent_chains` and `agent_synthesized_schedules`
  are KEEP (versioned projection history; see
  `src/security/storageRetention.ts`, the single contract).
- Ports: `src/data/chainSchedulePorts.ts` (interfaces),
  `src/data/d1ChainScheduleAdapter.ts` +
  `src/data/inMemoryChainScheduleAdapter.ts` (adapters), with
  the port/dialect suite passing unchanged against both.

## Slice 2 addendum (issue #1676, shard jobs projection)

- Status: accepted with slice 2; the R1–R9 contract above is
  unchanged and governs this slice.
- Table (migration 0003, DDL in exactly one file):
  `agent_shard_jobs`. Every row carries `tenant_id`,
  `workspace_id`, `chain_id`, `version`, `created_at_ms`,
  `updated_at_ms`, and provenance (`provenance_writer`,
  `provenance_source_do`, `provenance_source_version`, the
  last being the row-shape version of the mapping, 1 in
  slice 2). Grain: one row per (chain, job, version); the
  composite primary key on
  `(tenant_id, chain_id, job_key, version)` is the
  idempotency guarantee, and replaying the same version is
  a no-op under `onConflictDoNothing` writes. `job_key` is
  an inline shard id (`chain-exec:*`) for completed legs, a
  rails job id for submitted legs, or `leg:<stepId>` for a
  failed leg with no job id. Rows carry `status`, `stage`,
  `capability_id`, `detail`, and a capped `result_json`
  (8000 chars + truncation marker). No row type carries auth
  material of any kind, and no submitted row carries a
  submission spec: a spec may carry operator identity or
  query text, so submitted rows store only the job id and
  detail.
- The key correction from the program spec: lane-2 inline
  execution never writes `mas_async_jobs`, so a projection
  fed only from that table would miss every inline outcome.
  The executor's completion callback is therefore a
  projection writer input: `runChain`
  (`src/mcp/goalChainCommands.ts`) accepts an optional
  `onLegOutcome` callback, invoked once per leg that
  actually ran (completed, submitted, failed) and never for
  skipped, blocked, or unimplemented legs, awaited inside a
  try/catch so a callback failure can never fail the run.
  The ScheduledAgent firing paths (`onCron` and
  `fireSynthesizedSchedule` in `src/agents/scheduled-agent.ts`)
  supply a projector bound to env/tenant via
  `executeChainForRecord` (writers
  `scheduled-agent:onCron` /
  `scheduled-agent:fireSynthesizedSchedule`; chain id is the
  synthesized record id, matching slice 1's chain rows).
  The MCP command context supplies no callback, so MCP legs
  stay `unimplemented` and project nothing — no execution
  is invented. Replaying an already-projected status is a
  no-op; a status change writes version+1 and preserves the
  first-seen timestamp.
- Reconciliation design: `reconcileShardJobs`
  (`src/data/shardJobProjection.ts`) converges rails state
  into the projection: a submitted row whose rails job
  reached a terminal state advances to that state
  (version+1, first-seen time preserved); a rails job the
  projector never saw creates a version-1 row; an
  already-current row is untouched; per-record failures are
  collected in the report, never thrown. Invocation is a
  deliberate operator/maintenance step only:
  `OrchestratorAgent.reconcileShardJobProjection` (execution
  in `src/agents/orchestrator/shardJobReconcile.ts`, the #992
  pattern) plus the admin-gated POST `/api/jobs/reconcile`
  route (requireAuth → wired session → live platform-admin
  membership, the slice-0 seed pattern; unbound AgentDB
  answers 503). It is never boot logic, never auto-run on
  deploy or tick. Honest limitation, recorded not hidden:
  reconciliation can only converge what it can see. Rails
  rows carry `chainId` (C3 consolidation), so terminal
  rails jobs join their chain's history; inline outcomes
  have no durable source beyond the run itself, so an inline
  outcome that was never projected at completion cannot be
  recovered by reconcile — which is why the run path
  projects synchronously at completion and why a projector
  failure is surfaced in the result, not swallowed.
  Bounded window: the rails list is session-filtered and
  clamped to 100 rows, so a reconcile pass covers the most
  recent rails jobs only.
- Query API: GET `/api/jobs/history?chainId=` (requireAuth;
  tenant from IAAA resolution) reads the projection only via
  `readJobHistory` — never the durable object — and returns
  the latest row per job for that chain, newest first.
  Unbound AgentDB answers 503. The route returns projection
  fields only (jobKey, status, stage, capabilityId, detail,
  version, timestamps).
- Tenancy: the adapters inject `tenant_id` into every query;
  there is no unscoped list-all method. Tenant and workspace
  default to `"primary"` (the documented single-tenant
  default, same as slices 0/1) until a tenant context is
  threaded through ScheduledAgent; a multi-tenant deployment
  must set it explicitly.
- Retention: `agent_shard_jobs` is BOUNDED, mirroring the
  `mas_async_jobs` discipline it projects (terminal rows 30d
  + 500-row cap; see `src/security/storageRetention.ts`,
  the single contract). Job rows are operational run
  history, not lifecycle audit: unlike `agent_chains`, whose
  versions are the audit trail the status read reasons
  about, a pruned job version destroys no lifecycle fact
  (the chain row keeps it), and the rails source already
  discards the same rows at 30d. Enforcement lands with the
  retention slice; until then rows accrue unbounded and the
  contract line is what that enforcement implements.
- Ports: `src/data/shardJobPorts.ts` (interfaces),
  `src/data/d1ShardJobAdapter.ts` +
  `src/data/inMemoryShardJobAdapter.ts` (adapters), with
  the port/dialect suite passing unchanged against both.

## Consequences

- A new dependency: `drizzle-orm` (runtime). No `drizzle-kit`
  in this slice.
- The ScheduledAgent tick consults the mirrored halt when
  `AGENT_DB` is bound (via the durable object's own env — no
  env crosses the RPC boundary, per #1391) or when a caller
  injects a halt reader. The governed predicate
  (`shouldFireGoverned`) remains the decision-maker; the layer
  supplies a fact, not a new predicate. The direct one-shot
  firing path gets the same resolution for consistency.
- Migration 0001 applies via the adapter schema-ensure path
  (idempotent, `_migrations`-gated) on first use.
- Later slices, in order: chains + schedules projection,
  shard jobs with executor-output capture, audit + reports
  with the authority matrix, MCP read tools + dashboard
  routes, then the Postgres adapter (proving
  cloud-agnosticism with the dialect-conformance suite).
