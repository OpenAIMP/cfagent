# 0002. Data foundation layer: port-first, Drizzle ORM, D1 as one adapter

- Status: accepted
- Date: 2026-10-25
- Deciders: owner, CAIO-quns
- Issue: #1548 (slice 0; design #1546)
- Implementing PR: (this PR; number filled before merge)

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
