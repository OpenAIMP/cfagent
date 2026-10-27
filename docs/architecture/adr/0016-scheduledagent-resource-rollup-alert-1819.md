# ADR 0016: Resource rollup + 70% cap alert live on ScheduledAgent (#1819)

- Status: Accepted
- Date: 2026-10-27
- Deciders: owner, #CISO-bhdm
- Issue: #1819 (consolidation: #1884)
- Implementing PR: #1890 (main commit, when merged)
- Related: docs/architecture/security/sessionstore-resource-rollup-alert-1819.md,
  docs/architecture/security/sessionstore-resource-process-1819.md,
  ADR 0015 (instrument first), ADR 0018 (CAIO alignment)

## Context

ADR 0015 decided instrument-first for #1819. The instrumented events
then needed aggregation into daily totals and a cap alert, and the
owner direction on 2026-10-27 fixed where that aggregation lives:
on ScheduledAgent (the orchestrator-catalog goals on the existing
`*/30` tick), with per-op emission staying in-path. The constraints
were explicit: no new cron triggers, no second scheduler, no
WorkflowPort generalization in this slice. The free-tier budgets are
5M rows read, 100k rows written, and 100k Durable Object requests
per day; the alert threshold is 70% of each.

## Decision

Aggregation rides ScheduledAgent; emission does not:

- **Per-op emission stays in-path.** Buffered Analytics Engine
  writes (and the D1 fan-out for the queryable projection) happen
  where the op happens. Queueing a high-frequency in-path signal
  through the job system would add latency, ordering, and loss for
  no benefit.
- **Three orchestrator-catalog goals, evaluated on the existing
  `*/30` tick, executed directly through their handlers (the
  `social.publish` precedent), never through `createJob`:**
  - `resource.rollup_daily` — 01:30 UTC (`30 1 * * *`): the
    previous UTC day's projection totals by ns/op/caller/trigger
    into `resource_daily_rollups` (INSERT OR REPLACE, so re-runs
    are idempotent).
  - `resource.cap_alert` — hourly UTC (`0 * * * *`): the current
    day's cumulative totals versus 70% of the free-tier budgets
    (3,500,000 rows read / 70,000 rows written / 70,000 DO
    requests). A breach alerts as plain text through the existing
    Slack webhook-then-bot route — never an approval card. The
    alert branch never stamps `lastRun` by design (`isDue`'s 23h
    guard would suppress hourly evaluation); dedup lives in
    `resource_alert_state` per (budget, day).
  - `resource.dashboard_comparison` — 02:00 UTC (`0 2 * * *`):
    a report for the latest completed rollup day into
    `resource_comparison_reports`, with `dashboard: null` until
    dashboard numbers are supplied. Dashboard numbers are never
    invented, estimated, or backfilled.
- **Day boundary is the UTC calendar day** (Cloudflare D1 free
  limits reset daily at 00:00 UTC; DO metering matches D1). The
  01:30 rollup leaves a 90-minute buffer after midnight for
  in-flight writes. Forced/manual evaluation reproduces the
  scheduled run exactly.
- **The D1 projection (`resource_sql_ops`) exists because there
  is no in-Worker Analytics Engine read path**, so the goals query
  D1 while Analytics Engine remains the transport. Whether a
  future Analytics Engine read path would retire the projection
  is a follow-up decision, not something this ADR settles.

## Consequences

- Operator activation is owed, not assumed: the three goals must be
  added to the running deployment via the schedule dashboard API
  (defaults seed fresh deployments only); a Slack destination must
  be configured (`SLACK_WEBHOOK_URL`, or `SLACK_BOT_TOKEN` +
  channel); and the first daily rollup must show ops > 0, proving
  the fan-out is live — a dead projection means the alert cannot
  fire.
- Projection totals are a SessionStore-only lower bound on
  account-wide usage (see ADR 0015). A breach implies the account
  is at or above 70%; no breach does not prove account safety.
- No new scheduler, no new cron triggers, and no WorkflowPort
  generalization were introduced by this slice. Any of those, if
  ever wanted, is its own decision with its own ADR.
- No fix, no production switch change, and no paid-plan decision
  rode this slice. The rollup slice's report comment was explicitly
  not a §15 PASS, and #1819 stays open until its acceptance is met.

## Alternatives considered

- **New `wrangler.jsonc` cron triggers for the rollup/alert.**
  Rejected: a second scheduler beside ScheduledAgent duplicates
  the scheduling system the repo already runs, against the owner's
  explicit direction and the reuse rule.
- **Route per-op emission through the job system.** Rejected:
  high-frequency in-path signals queued as jobs pay latency,
  ordering, and loss costs for no benefit; emission is buffered
  and never awaits a network round-trip, and a sink failure never
  fails the producer.
- **Analytics Engine events only, no D1 projection.** Rejected
  for the queryable path: there is no in-Worker Analytics Engine
  read path, so the goals would have nothing to query.
- **Generalize WorkflowPort to carry the rollup.** Rejected:
  out of slice scope, and WorkflowPort is not a DAG (ADR 0017) —
  generalizing it to host scheduled aggregation would have
  conflated two separate decisions.
- **Alert via approval card.** Rejected: an alert is a
  notification, not a decision request; routing it through
  approval cards would delay it behind human action and misstate
  its nature.
