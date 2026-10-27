# SessionStore resource rollup + 70% cap alert on ScheduledAgent (#1819)

Status: measurement slice 2. Companion to
`sessionstore-resource-measurement-1819.md` (slice 1: the inventory and the
per-op instrumentation). This slice adds NO new measurement transport and
NO fix: it reads the D1 projection slice 1 already writes and turns it
into a daily rollup, an hourly cap alert, and a dashboard-comparison
report — all as ScheduledAgent goals, on the existing */30 cron tick.

## Why ScheduledAgent, and why not a new scheduler

Owner direction 2026-10-27 (explicit approval): the rollup and alert go
ON SCHEDULEDAGENT. Concretely:

- No new `wrangler.jsonc` cron triggers. The tick stays `0 3 * * *` +
  `*/30 * * * *`; the goals are evaluated inside `onCron` via `isDue`
  with their own cron expressions and timezones.
- No second scheduler, no WorkflowPort generalization (the port stays
  screener-shaped; generalizing it to resource jobs is a separate future
  slice if ever wanted).
- Per-op emission stays in-path (buffered Analytics Engine write from the
  store funnel), NOT routed through the job system. These goals only
  READ the projection. Routing measurement through jobs would add a
  second, lossy path between the op and its record.
- Alert delivery uses the EXISTING Slack route the schedules already use
  (`fetchSlackPost` + `resolveSocialSlackChannel` in
  `src/agents/social/delivery.ts`): webhook first, else bot token +
  channel via `chat.postMessage`, judged by Slack's `{ok}` field. No new
  channel, webhook, or alerting service is invented in this slice. The
  alert payload is plain text, NOT a Block Kit approval card: an alert
  asks for nothing, so it must not carry Approve/Reject buttons.

## The three goals

Catalog entry `resource` (binding `SCHEDULED_AGENT`) in
`src/orchestrate.ts` — the entry exists so `addGoal` accepts the
operations and the dashboard can list them. The onCron branches execute
them directly (the `social.publish` precedent); `createJob` is never
called for them, because it mints a pending descriptor and executes
nothing (the #1655 `qa.run_sweep` precedent).

| Goal | Cron (UTC) | Operation | What it does |
| --- | --- | --- | --- |
| `resource-daily-rollup` | `30 1 * * *` | `resource.rollup_daily` | Previous UTC day's projection totals, by ns/op/caller/trigger, into `resource_daily_rollups` |
| `resource-cap-alert` | `0 * * * *` | `resource.cap_alert` | Current UTC day-to-date cumulative vs 70% thresholds; Slack alert on breach |
| `resource-dashboard-comparison` | `0 2 * * *` | `resource.dashboard_comparison` | Comparison report for the latest completed rollup day into `resource_comparison_reports` |

All three carry `timeZone: "UTC"` explicitly (a valid IANA zone for
`Intl.DateTimeFormat`), never omitted. `budgetCents: 1` is the floor
`addGoal` requires, not a charge — these goals spend nothing (same as
the social goal).

## Cadences and their assumptions

- **Rollup at 01:30 UTC for the previous UTC day.** The 90-minute buffer
  after midnight exists so in-flight writes from the last minutes of the
  day land in the projection before the rollup reads it. A rollup read
  at 00:00 sharp would systematically undercount the day's tail.
- **Alert hourly (`0 * * * *` UTC) on the current UTC day-to-date.**
  Hourly is the finest cadence the */30 tick can express for a goal
  whose evaluation must repeat within a day (see the lastRun note
  below); a 70% threshold crossed at 14:07 is caught by the 15:00
  evaluation at the latest, with hours of headroom before the cap.
- **Comparison at 02:00 UTC, after the 01:30 rollup.** It reads the
  LATEST COMPLETED rollup day (max day in the rollup table), not the
  wall-clock day — which is what makes a forced evaluation reproduce
  the scheduled run exactly (same rows, same report JSON, whenever it
  runs). Forced evaluation (`triggerGoal` → `onCron` with `forceGoalId`)
  bypasses cron/enabled gates and runs the same branch, so the owner's
  comparison run and the scheduled run execute the same path.
- **Day boundary: the UTC calendar day [00:00 UTC, next 00:00 UTC).**
  VERIFIED, not assumed: Cloudflare's Workers pricing page states D1
  "Free limits reset daily at 00:00 UTC", and the Durable Objects
  storage table footnotes that DO rows read/written limits and rates
  "match D1 pricing". The doc cites this chain rather than asserting
  the DO reset hour from the DO table alone (which states "/ day"
  without spelling the hour). If the dashboard ever shows otherwise,
  only `utcDayOf`/`utcDayBounds` in `src/telemetry/resourceRollup.ts`
  change — every goal reads the day through them.

## The lastRun deviation (read this before touching the alert goal)

`isDue` has a 23-hour guard: after a goal stamps `lastRun`, it is NOT
due again for 23 hours, regardless of cron. No sub-daily goal can work
via lastRun stamping in this codebase today (the shipped
`opportunity-hunt` "0 */6 * * *" maps its hour through `Number()` to
NaN and is therefore never due — a deliberately preserved quirk).

The alert branch therefore NEVER stamps `lastRun`, deliberately. With
lastRun unstamped, both the :00 and :30 ticks match the hourly cron
under the minute-tolerance rule (any tick inside the matching hour at
or after a scheduled minute counts as due), so the check runs up to
twice per hour. The second evaluation is a deduped no-op: delivery
dedup lives in `resource_alert_state` per (budget, day), not in goal
state. Consequences, all pinned by tests:

- Evaluation completed → `jobsCreated++` (the goal did its work).
  `lastRun` stays undefined forever for this goal — cosmetic; tick
  history shows the evaluations.
- Delivery attempted and failed → tick error + `jobsSkipped`, state
  unmarked, so the next matching tick retries. lastRun untouched.
- No Slack destination configured, first breach of the day → the
  breach is MARKED (delivered=0 + note, so it does not spam hourly)
  plus ONE tick error for visibility. The state row is the audit
  trail; this mirrors social's "a configured destination that fails
  DOES record errors" while avoiding hourly spam for a missing config.
- Already alerted → no re-post, no state change, `jobsCreated++`.

Rollup and comparison stamp normally: their crons are 24h apart, which
is past the 23h guard. A failure there (handler throws, or no completed
rollup for comparison) leaves lastRun untouched + `jobsSkipped`, so the
goal stays due and retries.

A future change to `isDue` (per-window lastRun instead of the 23h
guard) would let the alert goal stamp normally. That change is OUT OF
SCOPE for this slice and must not be smuggled in with it.

## Data source: the D1 projection, and why

The rollup/alert/comparison goals query D1, not Analytics Engine,
because there is NO in-Worker Analytics Engine read path: AE is
write-only from Workers, and querying it needs an account API token
that is not in Worker env and must not be added in this slice.

To populate D1 in production (where OBSERVABILITY is bound and slice
1's composition picks AE only), slice 1's composition root gains a
fan-out option: `createResourceUsagePort(env, { withProjection: true })`
returns a `FanOutResourceUsageAdapter` (AE + D1) when both bindings
exist, else the existing precedence (AE → D1 → null). `requireAuth`
— the top SessionStore source — switches to `{ withProjection: true }`.

**D1 write cost, stated prominently:** fan-out adds one D1 INSERT per
store op. At slice 1's plausible single-tab volume (~30k ops/day) that
fits the 100k D1 writes/day free cap with headroom shared with all
other app D1 writes; aggressive/multi-tab volumes can exceed it. In
that case the D1 adapter degrades best-effort (warns, op unaffected),
so measurement degrades but the app does not. No sampling: totals must
be exact, and a sampled projection would silently undercount the
rollup. **If the projection is dead, the alert cannot fire** — this is
a documented limitation, not a hidden one. Activation must therefore
confirm the first rollup has ops > 0 (see below); rollup op counts
make a dead projection visible (ops ≈ 0 while store_op v2 log volume
is high), rather than silently certifying zero usage.

## Tables (created idempotently by `resourceRollupStore.ts`)

Same deliberate choice as slice 1's D1 adapter: NOT via the shared
migration-runner list.

- `resource_daily_rollups` (day, ns, op, caller, trigger, ops,
  rows_read, rows_written; PK (day, ns, op, caller, trigger)).
  Rollup writes use INSERT OR REPLACE, so re-runs are idempotent.
- `resource_alert_state` (budget, day, alerted_at, delivered, note;
  PK (budget, day)).
- `resource_comparison_reports` (day PK, generated_at, report_json).

Goal-path DB errors THROW (fail-visible, goals stay due and retry) —
the opposite of the per-op record path (never throw). The distinction
is intentional and documented here so a future reader does not
"unify" them.

## Thresholds and scope honesty

Alert thresholds are 70% of the Workers Free budgets: rowsRead
3,500,000; rowsWritten 70,000; DO requests 70,000. Breach is
AT-threshold (>= 70%), not past-threshold.

The projection sees SessionStore ops only, so alert totals are a
LOWER BOUND on account-wide usage. A SessionStore-only breach at 70%
implies the account is at >=70%, but no breach does NOT prove account
safety (other DO namespaces could push it over). The DO-requests
figure counts store ops (one stub.fetch per op) as the request proxy,
under the same lower-bound caveat. Every alert text and every
comparison report carries this scope note.

## The comparison report (how the dashboard comparison runs)

The comparison goal writes one stored report per rollup day. Its shape
(`buildComparisonReport`):

- `day`, `grandTotals` (ops/rowsRead/rowsWritten), `byCaller` and
  `byTrigger` breakdowns (sorted by rowsRead desc), `budgets`,
  `pctOfBudget`.
- `scopeNote` (the lower-bound caveat above).
- `dashboard: null` — dashboard numbers are NEVER invented. The owner
  lines the instrumented totals up against the dashboard series below;
  the report names the series and the agreement criteria, it does not
  fill in dashboard values.
- `dashboardSeriesToCompare`: Cloudflare Dashboard → Durable Objects
  → Metrics, rows read / rows written / requests per DO namespace,
  hourly.
- `agreementCriteria`:
  - same order of magnitude between instrumented SessionStore rows and
    the dashboard SessionStore-namespace rows;
  - same top caller (by rows) on both sides;
  - same hourly shape: steady burn vs spike at a specific job;
  - dashboard >> instrumented means the burner is outside SessionStore
    or in unattributed callers — do not fix a caller on that evidence;
  - instrumented >> dashboard means an emitter bug — do not fix a
    caller on that evidence.

**How to run it:** after one full day of instrumented totals, force
the comparison goal (dashboard API `triggerGoal`, or the scheduled
02:00 UTC run), then read the report row:

```sql
SELECT report_json FROM resource_comparison_reports ORDER BY day DESC LIMIT 1;
```

Line the report's 1-hour-bucketed totals (or the rollup rows grouped
by caller/trigger) up against the dashboard's hourly rows-read series
for the SessionStore namespace, same buckets, same units. Until
attribution wiring extends beyond auth, the background-vs-user split
is partial by construction — report it as partial, not as a percentage
of the 5M.

## Activation checklist (operator actions after merge)

DEFAULT_SCHEDULES seeds fresh deployments only. The running deployment
needs the three goals added via the schedule dashboard API (POST
/api/schedule/goals), because its goal store is already non-empty:

```json
{"id":"resource-daily-rollup","name":"SessionStore daily resource rollup","cron":"30 1 * * *","operation":"resource.rollup_daily","budgetCents":1,"enabled":true,"timeZone":"UTC"}
{"id":"resource-cap-alert","name":"SessionStore 70% cap alert","cron":"0 * * * *","operation":"resource.cap_alert","budgetCents":1,"enabled":true,"timeZone":"UTC"}
{"id":"resource-dashboard-comparison","name":"SessionStore dashboard comparison","cron":"0 2 * * *","operation":"resource.dashboard_comparison","budgetCents":1,"enabled":true,"timeZone":"UTC"}
```

Also required:

1. Slack destination for alert delivery: `SLACK_WEBHOOK_URL`, or
   `SLACK_BOT_TOKEN` + a channel (`SOCIAL_SLACK_CHANNEL` →
   `SLACK_CHANNEL_ID` → `SLACK_CHANNEL`). Without one, breaches record
   state-only with one tick error on the first breach-day — the alert
   never reaches a human.
2. Confirm the first daily rollup has ops > 0. This proves fan-out is
   live; a zero rollup with live traffic means the projection is dead
   and the alert cannot fire.
3. Owner-supplied dashboard data for the comparison (hourly DO
   rows-read/request curves for the comparison day, per-namespace if
   available). The comparison report is the instrumented side; the
   dashboard side remains owner-supplied.

## What this slice deliberately does NOT do

- No fix to any caller (no polling/cache/schedule behavior change).
- No production switch change, no paid-plan decision.
- No new wrangler cron triggers, no second scheduler, no WorkflowPort
  generalization, no new notification channel.
- No second aggregation system: the rollup tables derive from the same
  projection/stream slice 1 writes; they are the owner-ordered
  aggregation for this slice, not a parallel observability pipeline.
- No sign-in-verified claim: #1819 acceptance (4) — sign-in verified
  working after the fix/decision — is still unmet, and a quota reset
  alone is not verification.

## Files

- `src/telemetry/resourceRollup.ts` — pure: budgets, thresholds, UTC
  day helpers, `evaluateCapAlert`, `rollupRowsFromTotals`,
  `buildComparisonReport`.
- `src/telemetry/resourceRollupStore.ts` — D1 rollup/alert/report store.
- `src/telemetry/fanOutResourceUsageAdapter.ts` — AE + D1 fan-out.
- `src/telemetry/createResourceUsagePorts.ts` — `{ withProjection }`
  option (existing precedence otherwise unchanged).
- `src/agents/resourceGoals.ts` — the three handlers + `postSlackText`.
- `src/agents/scheduled-agent.ts` — the three onCron branches +
  `resourceSlackPost` test opt.
- `src/orchestrate.ts` — `resource` catalog entry.
- `src/schedule.ts` — the three DEFAULT_SCHEDULES entries.
- `src/server.ts` — `requireAuth` switches to `{ withProjection: true }`.
- Tests: `tests/resource_rollup_alert_1819.test.ts`,
  `tests/resource_goals_scheduled_1819.test.ts`,
  `tests/resource_catalog_defaults_1819.test.ts` (TDD Red: 7 failed
  before the implementation, incl. the fall-through-to-createJob
  signature; Green: all pass with the affected suites).
