# SessionStore resource process — #1819 end to end

**Issue:** [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) (open).
**Consolidation issue:** [#1884](https://github.com/OpenAIMP/cfagent/issues/1884).
**Status:** index document. This doc synthesizes and points; it does not fork rules.
Where a rule already lives in a canonical doc, this doc links to it. On any
conflict between this doc and a canonical doc, the canonical doc governs and
this doc must be corrected.

## 1. End-to-end flow

| Step | What happened | Canonical record |
| --- | --- | --- |
| Incident | 2026-10-26 sign-in bounce: SessionStore Durable Object free-tier rows-read quota exhausted (5M rows read/day), Worker script `ai-search-agent`, `POST /kv`. Login start itself worked; the failure was downstream at callback/session landing. | [Measurement doc §1](sessionstore-resource-measurement-1819.md) |
| Measurement | Code-side caller inventory with numbers, CEO-lane claim verification, and the dashboard-comparison procedure. Top SessionStore source named: wired `requireAuth` (about 1 read per authenticated `/api/*` request). Polling alone does not explain 5M; the 5M-level burner (SessionStore-local vs account-summed) remains explicitly unmeasured pending instrumented totals vs dashboard curves. | [Measurement doc](sessionstore-resource-measurement-1819.md) |
| Instrumentation | Resource events emitted in the aligned shape (see §2). No fix, no production switch change, no paid-plan decision in the instrumentation slices. | [Measurement doc](sessionstore-resource-measurement-1819.md); §2 below |
| Rollup + cap alert | Three ScheduledAgent goals (see §3). Landed as PR [#1870](https://github.com/OpenAIMP/cfagent/pull/1870), merged `a0dcfbbf`. | [Rollup doc](sessionstore-resource-rollup-alert-1819.md) |
| Operator activation | Still owed (summary only — full payloads live in the rollup doc, linked above, not duplicated here): add the three goals to the running deployment via the schedule dashboard API (defaults seed fresh deployments only); configure a Slack destination (`SLACK_WEBHOOK_URL`, or `SLACK_BOT_TOKEN` + channel); confirm the first daily rollup has ops > 0 (proves the fan-out is live; a dead projection means the alert cannot fire); owner supplies dashboard per-namespace hourly curves. | [Rollup doc](sessionstore-resource-rollup-alert-1819.md) |
| Comparison | After one full day of instrumented totals, force the comparison goal (same path as the scheduled run) and line its report against the dashboard SessionStore-namespace hourly series, same buckets, same units. | [Rollup doc](sessionstore-resource-rollup-alert-1819.md); procedure below |
| Fix | Scoped to the named burner only, once the comparison names it. Never guessed in advance. | This doc §1; #1819 acceptance |

### Comparison procedure and reading the result

- Force `resource.dashboard_comparison` (forced/manual evaluation reproduces the
  scheduled run exactly) and compare against the dashboard SessionStore hourly
  series in the same time buckets and the same rows-read/written units.
- Agreement = same order of magnitude + same top caller + same hourly shape.
- Dashboard ≫ instrumented = the burner is outside SessionStore, or callers are
  unattributed. That is a scoping result, not a contradiction.
- Instrumented ≫ dashboard = an emitter bug, not a caller fix.
- `dashboard: null` in a comparison report means the dashboard numbers have not
  been supplied yet. They are never invented, estimated, or backfilled.

### Scope honesty carried by every step

- Projection totals are a **SessionStore-only lower bound** on account-wide
  usage. A cap-alert breach implies the account is at or above 70%; no breach
  does not prove account safety.
- A quota reset alone is not verification. #1819's acceptance requires sign-in
  verified working after the fix or decision, not just a fresh day's budget.
- #1819 stays open until that acceptance is met. The rollup slice's report
  comment was explicitly not a §15 PASS.

## 2. CAIO observability/telemetry alignment

The alignment rule for this work is the standing reciprocal rule: when either
lane defines a port, the other checks first and consumes or links — never
duplicates. Resource usage became one more event type in the CAIO track's
stream, not a second pipeline.

### Reuse

- **#1742's port pattern** (merged; `src/telemetry/`): `TelemetryPort` with D1
  and in-memory adapters and a composition root. The resource side follows that
  shape — `src/telemetry/resourceUsagePorts.ts` (`ResourceUsagePort`),
  `src/telemetry/createResourceUsagePorts.ts` (composition root),
  `src/telemetry/d1ResourceUsageAdapter.ts`,
  `src/telemetry/inMemoryResourceUsageAdapter.ts`,
  `src/telemetry/fanOutResourceUsageAdapter.ts`. #1742's subject is thesis
  realization / prompt calibration, not resource usage: the pattern is reused,
  not the data.
- **#1743's landed schema and transport** (closed; PR
  [#1842](https://github.com/OpenAIMP/cfagent/pull/1842) merged `e989e33`;
  `src/observability/`): one event schema with tenant/run/session scope on
  every event, W3C traceparent, key-based redaction (session as truncated-hash
  `sessionRef`, never the session id), Analytics Engine adapter plus in-memory
  adapter behind a conformance suite, and local-logging degradation when
  Analytics Engine is down. Resource events convert via `toObservabilityEvent`
  to type `resource.sql_op` inside this schema. Analytics Engine accepts
  exactly one index — tenant-as-index1, type/level as blobs — and resource
  events fit that envelope; they do not invent new indexes.
- **#1741's gateway stats** (closed; PR
  [#1838](https://github.com/OpenAIMP/cfagent/pull/1838) merged `3820f77`;
  `src/gateway/`): the gateway module fronts every LLM text-inference call,
  and its stats surface as an optional field on the existing telemetry summary
  route. LLM tokens/spend join the resource picture as a consumed resource
  class; this work does not absorb gateway routing.

### Enhance

What the CAIO track did not carry, and this work adds:

- The **resource dimension**: rows read/written per statement, caller
  (route/job name), and trigger (`user` | `scheduled` | `tick` | `manual`),
  with statement fingerprints only — never bindings, tokens, or user data.
- **Scan-shape detection and sampling**: full logging for scan-shaped ops
  (rows read far above rows returned), sampled logging for small ops, so the
  instrumentation does not become its own cost center.
- **Rollup and alert as consumer queries** over the event stream (§3), not as a
  second aggregation system.

### Optimize

- **Existing seams, not new ones**: the `cfAgentsAdapter.ts` SQL seam (one
  place measuring every agent-DO SQL call), the SessionStore `/kv` reply path
  (cursor-measured rows summed across the op's statements), and D1 per-query
  `meta.rows_read` / `meta.rows_written`.
- **Zero new round-trips for emission**: DO cursor counters are already
  computed for billing and were previously thrown away; the Analytics Engine
  write is synchronous and buffered by the runtime, so the sink never awaits a
  network round-trip and a sink failure never fails the producer.
- **One-index discipline** (§2, Reuse): resource events respect #1743's
  tenant-as-index1 mapping with sampling-aware sums.

### Consolidate

One telemetry home (`src/telemetry/` + `src/observability/`), one schema, one
degradation path, one rollup story. No second pipeline, no second store, no
second alerting path. Deliberately **not** consolidated away: the IAAA audit
trail is untouched, #1742's thesis telemetry keeps its own subject, and #1741's
gateway keeps owning inference routing.

### Open decision, stated honestly

At instrument-first time the open question was whether the resource port needs
its own D1 projection table (following #1742) or lives purely as Analytics
Engine events. As built, the rollup slice answered it for the queryable path:
the D1 projection (`resource_sql_ops`) exists because there is no in-Worker
Analytics Engine read path, so the goals query D1 while Analytics Engine
remains the transport. The residual question — whether a future Analytics
Engine read path would retire the projection — is a follow-up decision, not
something this doc settles.

## 3. Scheduling reuse rule

- **Per-op emission stays in-path.** Buffered Analytics Engine writes (and the
  D1 fan-out for the queryable projection) happen where the op happens. They
  are NOT routed through the job system: queueing a high-frequency in-path
  signal would add latency, ordering, and loss for no benefit.
- **Aggregation runs on ScheduledAgent.** The rollup, the cap alert, and the
  comparison are orchestrator-catalog goals evaluated on the existing `*/30`
  cron tick — no new `wrangler.jsonc` cron triggers, no second scheduler, no
  WorkflowPort generalization in this slice.

| Goal | Schedule (UTC) | Behavior |
| --- | --- | --- |
| `resource.rollup_daily` | 01:30 (`30 1 * * *`) | Previous UTC day's projection totals by ns/op/caller/trigger into `resource_daily_rollups` (INSERT OR REPLACE, idempotent re-runs). |
| `resource.cap_alert` | Hourly (`0 * * * *`) | Current-day cumulative vs 70% of the free-tier budgets: 3,500,000 rows read / 70,000 rows written / 70,000 DO requests. Breach alert as plain text through the existing Slack webhook-then-bot route — never an approval card. The alert branch never stamps `lastRun` by design (`isDue`'s 23h guard would suppress hourly evaluation); dedup lives in `resource_alert_state` per (budget, day). |
| `resource.dashboard_comparison` | 02:00 (`0 2 * * *`) | Report for the latest completed rollup day into `resource_comparison_reports`, `dashboard: null` until dashboard numbers are supplied. |

- **Forced/manual evaluation reproduces the scheduled run.** ScheduledAgent
  supports forced evaluation regardless of cron/enabled state, and the
  resource goals execute directly through their handlers (the `social.publish`
  precedent), never through `createJob`. The owner's comparison run and the
  scheduled run therefore execute the same path.
- **Day boundary:** UTC calendar day, verified from Cloudflare pricing (D1
  free limits reset daily at 00:00 UTC; DO metering matches D1). The 01:30
  rollup leaves a 90-minute buffer after midnight for in-flight writes.

## 4. DAG status — stated plainly

**WorkflowPort is NOT a DAG today.**

- Its execution model is a **fixed linear stage pipeline**:
  feed → gather → analysis → store → serve → deliver
  (`src/workflows/workflowPorts.ts`). Each stage persists its own results;
  analysis runs only on post-gather data. No step declares dependencies, no
  conditional edges, no topological scheduling.
- Its parallelism is **parent → parallel shards → collation**: a parent job
  fans out to shards (default at most 4 in parallel) that run in parallel and
  collate under the parent id. That is map-reduce, not a dependency graph —
  the shards are identical legs, not nodes with different upstream
  dependencies.
- Job lifecycle is a **state machine** (Idle → Running → [BudgetConstrained]
  → Completed | Failed → ReportGenerated), with at most 3 retries per step
  and idempotent step callbacks.
- ScheduledAgent goals are likewise **independent**: no goal depends on
  another.

A DAG would require named nodes with declared dependencies, topological
execution, and branches/joins. None of that exists in the port today. DAG
execution is a future WorkflowPort generalization slice — declare a step
graph, schedule topologically, keep the existing stage vocabulary, claim-check
commands, and idempotency — not an existing capability, and not something this
doc claims.

## 5. Delivery process (pointer, not restatement)

This work followed the standing delivery process, which lives canonically in
[`docs/agents/gitops.md`](../../agents/gitops.md): issue-first, branch-as-lock,
§9 PR bodies, §15 completion reports, rebase-and-merge, red-CI diagnosis
rules, and the CHANGELOG gate. That document is the canonical source; this
section deliberately does not restate it, so the two cannot drift apart.

The TDD exception for this doc slice itself is recorded in its PR body:
doc-only, no behavior change — verification is link and file verification on
main, not test Red/Green.

> Note: gitops §23 (process decisions are recorded in the repository,
> not in chat) landed with the §23 slice (issue #1886); it is the rule
> under which this index-style doc and the ADRs it links to are the
> record. See [gitops §23](../../agents/gitops.md#23-process-decisions-are-recorded-in-the-repository-not-in-chat).
> This note is a pointer only — it does not restate §23, and §23 was
> not part of this doc as originally written.

## 6. Decision log

| Date | Owner direction | Issue |
| --- | --- | --- |
| 2026-10-27 | This lane owns #1819 ("you own this"). | [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) |
| 2026-10-27 | Instrument first; owner supplies Cloudflare dashboard data afterwards for comparison against instrumented numbers (same units, caller + trigger attribution, time-bucketed totals). | [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) |
| 2026-10-27 | Rollup + 70%-of-cap alert live on ScheduledAgent (existing `*/30` tick; no new cron triggers, no second scheduler, no WorkflowPort generalization in this slice); per-op emission stays in-path, aggregation on a schedule. | [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) |
| 2026-10-27 | Compile one consolidated process doc in the repo (this doc). | [#1884](https://github.com/OpenAIMP/cfagent/issues/1884) |

#CISO-bhdm
