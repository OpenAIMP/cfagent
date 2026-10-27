# Screener workflow: current state and transformation to the unified workflow

**Status:** published 2026-10-27 for lane feedback. **No implementation starts from this
document alone** — the journey it describes begins only after lane feedback and the queue
decision in §7. Evidence base: code research on `origin/main` at `4852476` (2026-10-27),
issue states re-verified 2026-10-27, and the #1963 fix verified on main at `9b38d3b`.

**Related issues:** #1963 (CLOSED — goal-screen false `Complete`, fix merged `9b38d3b`),
#1972 (OPEN — goal screen on the unified workflow), #1904 (OPEN — IROS target-state
remediation program, owns the target DAG), #1965/#1966 (scheduled-auth fix, merged),
#1968 (audit read path, open), #1969 (AOP codes program, open).

## 1. The target workflow in one paragraph

The standing ruling, and the IROS target DAG, is one staged pipeline every screen family
runs through:

**schedule → queues → feed → gather → store → serve → deliver**

The UX submits a run request through the same submission endpoint as other screeners; the
flow is triggered by creating a schedule (or an ad-hoc run request) → workflow → queues →
feed (acquire) → gather (enrich with indicators) → store (report/blob) → serve
(Reports/Runs) → deliver (email/Slack/webhook). The UI reads the stored result instead of
awaiting a synchronous screen. Stock, goal, options, and strategy screens all run this same
pipeline — providers shared via the registry **and** the workflow shared end to end.

Section 2 maps what exists today against that DAG. Sections 3–5 explain the one place the
DAG is most visibly broken (the goal screen) and correct an overbroad claim made about it.
Section 7 turns the map into a sequenced transformation.

## 2. Current state: the map

### 2.1 Stages (9, in order)

The code's own canonical order names only 5 — `feed, generate, store, serve, deliver`
(`src/services/shardJobs.ts:88-95`, `PIPELINE_STAGE_ORDER`) — because it folds trigger/auth
into the caller and analysis into `generate`. The full execution order, with the places the
2026-10-27 failures actually lived, is:

| # | Stage | What it does | Owner |
|---|---|---|---|
| 0 | Trigger / schedule fire | Agents SDK schedule (cron or interval) fires a stored callback; manual Trigger-Now dispatches the same callback with `trigger:"manual"`. | `src/agents/orchestrator/scheduledCallbacks.ts:98,299,386`; `src/agents/routes/schedules.ts:120-127` |
| 1 | Identity + auth guard | Payload login wins over saved execution context (`resolveScheduledLogin`, post-#1965); E*TRADE preflight: verify → one renew attempt → block. Stock/goal-stock blocked runs fall back to Yahoo; options runs block hard (AUTH_003). | `src/agents/orchestrator/scheduleMaintenance.ts`; `src/services/etradeAuthPreflight.ts` via `src/services/scheduledTasks.ts:475-503` |
| 2 | Feed / acquire | Resolve universe → listings (Nasdaq) → quotes (E*TRADE batch, or Yahoo batch). Sharded stock chains split this into `nasdaq → etrade → yahoo` feed shards, in that dependency order. | `src/trading/screenerPipeline.ts:1010`; `src/services/shardJobs.ts:54,136-172` |
| 3 | Gather / enrich | Attach technicals + factor grades to every quote: RSI/MACD/gap via `attachTechnicals`, grades via `attachFactorGrades`. **This is the pipeline's gather — not `gather.ts`** (§5). | `src/agents/screener-agent.ts:359-364`; `src/trading/screenerPipeline.ts:1810,1840` |
| 4 | Analysis / score / filter | Apply filters, compute screened set, select standouts/opportunities. Options: strategy engine + direction tags over chains. Goal: scenario/thesis gates over legs (on raw listings quotes, not gathered indicators, for the goal path — §3). | `src/trading/screenerPipeline.ts:1716,1858,1895`; `src/trading/options/unifiedOptionsService.ts` via `src/services/scheduledTasks.ts:1760+` |
| 5 | Generate report | PDF via ReportAssetAgent (single owner), XLSX, CSV. Per-format failures are recorded, never fatal, in the monolithic path. | `src/services/unifiedReportPipeline.ts:124+`; `src/agents/screener-agent.ts:1408` |
| 6 | Store | Persist run (latest + history), canonical `mas_reports` row, report blobs (R2 or DO-base64 legacy). Sharded chains: per-format store shards + per-shard projection rows. | `src/agents/screener-agent.ts:1352` (`persistRun`); `src/services/reportBlobStore.ts`; `src/services/shardJobs.ts:237` |
| 7 | Serve | `followup.report` job adopts stored artifacts and verifies them; UI reads `/api/screener/latest`, history, and `report.pdf?key=…`. Serve "performs reads, not fetches, and carries no withRetry" (`shardJobs.ts:88-95`). | `src/agents/orchestrator/asyncJobs.ts:760+`; `src/services/screenerFollowups.ts:221` |
| 8 | Deliver / notify | Per-channel `followup.deliver` jobs (Slack, email, webhook) + `followup.notify` lifecycle messages (started/completed/partial/failed/blocked/held/delivered). Plus in-process event-bus publishers, the CF Queue delivery subscriber, and websocket `broadcast`. | `src/agents/orchestrator/asyncJobs.ts`; `src/events/screenerPublishers.ts:209`; `src/messaging/screenerQueueConsumer.ts` |

The four wrappers converge — but not identically. All four live in
`src/agents/orchestrator/scheduledCallbacks.ts` and delegate to `ScheduledTasksService`
(`src/services/scheduledTasks.ts:303`): `autonomousMarketScreen` (:98) → stock pipeline;
`autonomousGoalScreen` (:299) → `executeGoalScreenRun` → `ScreenerAgent.runGoalDrivenScreen`
(a different engine, §3); `autonomousStrategyDiscovery` (:386) → discovery pipeline
(`SqlDiscoveryRunStore`); `autonomousOptionsAnalysis` (an `OrchestratorAgent` method,
`src/agents/orchestrator.ts:818-850`, not a scheduledCallbacks function) →
`UnifiedOptionsService`. All four share stages 0–1 and stage 8 plumbing, but stages 2–5
differ by family. "Same pipeline" is true at the *scheduling + delivery* layers, false at
the *screen engine* layer.

### 2.2 Agents, workflows, schedules, job systems

| Agent / system | Role |
|---|---|
| OrchestratorAgent (`src/agents/orchestrator.ts`) | Schedule host: callbacks, `submitAsyncJob` port, follow-up bridge, broadcast, schedule store, sweep. Not the screen engine. |
| ScheduledTasksService (`src/services/scheduledTasks.ts:303`) | The actual pipeline orchestrator: guard, sharded dispatch, fallback, audit, event publish, report/delivery chaining. All four wrappers funnel here. |
| ScreenerAgent (`src/agents/screener-agent.ts`, DO `SCREENER_AGENT`) | Stock screen (`runScreen`, `runScreenInner`), per-user lock, duplicate claim, `persistRun`, PDF/XLSX getters, goal-screen surface (`runGoalDrivenScreen`). |
| ScheduledAgent (`src/agents/scheduled-agent.ts`) | **Not** a screener agent. Evaluates goals on the `*/30` tick; its header says screening callbacks do **not** live here. |
| ReportAssetAgent (`src/agents/report-asset-agent.ts`) | Single owner of PDF generation. |
| ResearchAgent / TradingAgent / PaymentsAgent / OptionsScannerMCP | Bound DOs, not in the scheduled screen path. |
| Worker crons (`wrangler.jsonc:108-127`) | `0 3 * * *` token renewal; `*/30 * * * *` ScheduledAgent tick; `0 4 * * *` retention. **No screen cron lives here** — screens are Agents SDK schedules, not Worker crons. |
| Agents SDK schedules (`src/agents/routes/schedules.ts:120-127`) | **The screen scheduler.** Per-schedule cron, interval (options: 3600s), date, or delay. Stored in Orchestrator DO. |
| Cloudflare Workflow `screener-screen-workflow` (`wrangler.jsonc:15-18`, `src/workflows/screenerWorkflow.ts`) | Parent fan-out (max 4 parallel, 10-min shard deadline, 15-s poll, step retries 3) + child shard flows (execute → store → deliver → project). **Only 3 manual routes call it** (`etradeBrokerScreen.ts:114`, `marketDataResearch.ts:328`, `premium.ts:493`). **Zero callers in `scheduledTasks.ts` or `scheduledCallbacks.ts`.** Falls back to sync on any start failure. |
| Sharded async-job chains (`src/services/shardJobs.ts`, `src/services/shardExecutors.ts`) | **The scheduled path's actual "workflow".** Chain: feed → generate (assemble → pdf/xlsx/csv) → store → serve → deliver, advanced hook-by-hook on completion. A failed shard stops its chain. Separate from Cloudflare Workflows — two staged systems, same stage names. |
| `mas_async_jobs` job table (Orchestrator DO SQLite) | `submitAsyncJob` (`asyncJobs.ts:206`); capabilities include `followup.report`, `followup.deliver`, `followup.notify`, `shard.execute`, `feed.snapshot`. Platform alarm re-arms once at most (`maxAttempts:1`); job-level retry is manual (`retryAsyncJob`). Queued rows re-arm after restart (cap 100/batch). |
| Follow-up chain, shard reconcile, sweep, retention, token renewal | Chain bridge (`asyncJobs.ts:444,552`); hook-driven reconcile (`shardJobReconcile.ts:51`); stale-ledger sweep; nightly retention; nightly token renewal with deduplicated Slack alert on failure (no morning refresh exists). |

### 2.3 Queues (7 mechanisms, 2 Cloudflare Queues)

| # | Queue | Producer → Consumer | Loss behavior |
|---|---|---|---|
| Q1 | CF Queue `screener-events` (`wrangler.jsonc:38`) | `publishScreenerEvent` for `screener.*` events → **no consumer wired** ("producer-only in this slice", `wrangler.jsonc:31-35`). | Never consumed; bus fallback runs when no subscriber received it. Silent non-delivery if a future consumer is misconfigured. |
| Q2 | CF Queue `screener-events-delivery` (`wrangler.jsonc:39,42`, `max_batch_size:10`, `max_retries:3`) | `CfQueueMessagingAdapter.publish` → Worker `queue()` (`server.ts:3287-3325`) → `createScreenerQueueHandler`, handling only `screener.completed`/`screener.failed` for subscriber `delivery`. | After 3 retries: **dropped — no DLQ wired**. Undecodable messages are acked + logged (deliberate loss, avoids poison-loop). Dedup seen-set is per-isolate only — cross-isolate duplicates can double-deliver. |
| Q3 | In-process `ScreenerEventBus` (`src/events/screenerEvents.ts`) | Service / queue consumer → publishers (`registerScreenerPublishers`). | **In-memory fan-out, no durability.** If the isolate dies mid-publish, undelivered events are gone. When no queue binding exists, the bus is the *only* path. Publish failures are `console.warn`-only. |
| Q4 | `mas_async_jobs` table | `submitAsyncJob`, follow-up planner, shard planner → Agents SDK `executeAsyncJob` alarms. | Durable; history pruned by design (30 days, latest 500/session) — history loss, not job loss. Oversize payload/result fails the job, does not queue it. |
| Q5 | Agents SDK schedule store (Orchestrator DO) | Schedules API → platform callback dispatch. | Durable; duplicates suppressed by slot claims. Unowned schedules are deleted by `removeUnownedBaselineSchedules` (deliberate, not loss). |
| Q6 | ScheduledAgent goals store (`goals` + `tickHistory` capped at 50) | Goal seeding/admin → `onCron`. | Failed goal run stamps nothing, stays due → retries next tick by design. History truncation is observability loss, not work loss. |
| Q7 | Cloudflare Workflow instances (`SCREENER_WORKFLOW`) | 3 manual routes → Workflow runtime (parent polls children). | Step retries 3; shard past 10-min deadline → `timed_out`, collation proceeds without it (`BudgetConstrained`). If all children time out, the run is `Failed` with summaries only. |

**Total: 7 mechanisms; 2 CF Queues; 5 durable-or-platform-backed in production (Q2, Q4,
Q5, Q6, Q7); Q1 producer-only; Q3 in-memory.** "Nothing is lost" is a design goal, not the
current state.

### 2.4 Persistence + error handling per stage

| Stage | Persistence | On failure |
|---|---|---|
| 0 Trigger | DO schedule store (`schedule.created` audit). | Create throw → API error, nothing created. Callback itself never throws (platform retry deliberately not used; dedup instead). |
| 1 Guard | Audit only: `mas_events` row `etrade.auth_blocked`. Episode-dedup flag in DO blob storage. Guard is read-only — no token row written. | Blocked → typed `AUTH_003` + one alert per episode; rest of day quiet (dedup, by design). Stock/goal-stock → Yahoo fallback; options → hard fail. Audit-insert failure is **swallowed** (`catch {}`) — a blocked run with a failed audit write leaves no record. |
| 2 Feed | **None durable by itself** in the monolithic path — quotes live in invocation memory until stage 6. Sharded path: feed shard rows in `mas_async_jobs` + `SqlFeedSnapshotStore` (discovery only). | Per-fetch `withRetry` (acquisition policy, 3 attempts). A *mid-run* feed failure is not retried as a whole run; it surfaces as partial/failed. |
| 3 Gather (pipeline) | **None** — technicals attached in memory, persisted only as part of the stage-6 run row. | Missing history → honest nulls; gates fail closed on absence. No retry, no separate failure state — a gather miss is invisible except as missing fields. **In-memory-only stage.** |
| 3′ Gather (`gather.ts`) | **Would-be:** one JSON blob per run `gather/<runId>.json` (R2 when bound, else DO base64). | N/A — never runs in production (§5). |
| 4 Analysis | **None** until stage 6. Options: `SqlScanRunStore` rows during scan. | Partial → `SCREEN_002` warn + partial publish (or degraded notice below the #1718 floor); zero evaluated → `SCREEN_003` throw → discard, **no report published**. Goal legs pre-#1963: error-status leg surfaced as `Complete` (§3). |
| 5 Generate | R2 bucket `screener` (`REPORTS_BUCKET`) via `reportBlobStore.putReportPdf`; unbound → base64 in DO. Keys `report:pdf:*`, `report:xlsx:*`, `report:csv:*`. | Each format is its own failure domain: status `failed` + error recorded, run continues without that artifact; **no fabricated URL**. Report policy retry: 2 attempts. |
| 6 Store | ScreenerAgent DO storage (`screener:last_runs` capped 20, `LATEST_KEY` + `HISTORY_KEY`); canonical `mas_reports` row (one per generation); D1 `AGENT_DB` projections for the workflow path only. | Persistence failure in the market wrapper is **swallowed** (`catch {}` — "must not break the screen"). A run can succeed on Slack while leaving no stored run. `persistRun` records PDF/XLSX failures as status fields, not throws. |
| 7 Serve | Reads stage-6 artifacts; `followup.report` job row in `mas_async_jobs`. | Serve failure → job `failed`, manually retryable only; no `withRetry`. A failed serve blocks deliver (chain stop-point). |
| 8 Deliver | Delivery job rows (`followup.deliver`/`followup.notify`); channel calls synchronous inside the job; queue path Q2. | Delivery policy 3 attempts with backoff; terminal failure → job `failed` + `DELIVER_002`. Broadcast (websocket) failures are `catch {}`-swallowed. Email false-delivered defect class is #1941 (open; binding + result-propagation fix). |

**Swallowed-failure inventory:** audit insert (stage 1), market-wrapper persistence (stage 6),
event publish (Q3), websocket broadcast, goal-bridge failure ("canonical row kept"), ledger
heartbeat ("a missed heartbeat never breaks a screen").

### 2.5 Retries, backoff, circuit breaker, observability

One shared executor, `src/services/resilience.ts` (`withRetry`, `base × 2^(retryIndex-1)`,
capped, ±jitter), driven by `src/services/pipelinePolicy.ts:DEFAULT_PIPELINE_POLICY`:
acquisition 3 attempts (250 ms → 4,000 ms, ±25%), delivery 3 (500 ms → 8,000 ms, ±25%),
report 2 (500 ms → 4,000 ms, ±25%); shard mapping: feed→acquisition, generate/store→report,
deliver→delivery, **serve→no `withRetry`**; `RateLimitError`/429 `Retry-After` overrides the
backoff for that attempt; workflow step retries 3.

Circuit breaker: `src/breakers/breakerPorts.ts:62` — failureThreshold 3 consecutive
retryable failures, resetTimeout 30,000 ms, half-open max probes 1; non-retryable
(auth/config) failures do not count. Wired at Yahoo quotes (goal + market paths),
E*TRADE/Nasdaq/public-fetch paths via `defaultBreakerRegistry()`. **Breaker state is
in-memory per isolate** (`src/breakers/inMemoryBreakerAdapter.ts:34`; header: state "resets
on isolate recycle (fail-open on cold start)"). A trip in one isolate does not protect
siblings. A durable cross-isolate breaker store is a stated follow-up in that header — and
is one of the transformation's genuinely-missing pieces (§7). The in-memory *messaging* and
*workflow* adapters exist but are **explicitly never built by the production composition
roots** (`createMessagingPorts.ts:56`, `createWorkflowPorts.ts:51`) — tests/local only.

Observability per stage: audit events via `mas_events` (`schedule.created`,
`etrade.auth_blocked`, `etrade.token_auto_renewed/failed/error`,
`screener.sharded_chain_submitted`, `screener.run_fallback`, `screener.run_completed`,
`screener.opportunities_detected`, `screener.screen_failed`, `goal_screen.*`,
`options.scheduled_analysis_*`, `async_job.queued/retried`, …); Workers Logs (100%
sampling); Analytics Engine `observability` dataset (passive delivery tap); admin/job
surfaces (`/api/jobs/:id`, AsyncJobsPanel, Records & Ledger Explorer, ScreenersHub history).
**Blind stages:** feed per-symbol failures (only aggregated counts + top skip reason
survive); gather misses (no event, no metric); serve internals (job row only); Q1 (no
consumer metric); breaker trips (state-change hook exists, no production subscriber found
in the screen path — unverified, not proven); audit *read* path (writes proven; payload
retrievability is #1968, open).

### 2.6 Async vs sync, batch vs realtime

**Boundary-async, execution-sync.** Schedule fire async → wrapper `waitUntilStable` 30 s +
`keepAliveWhile` sync-await → guard sync-await → `runScreen` sync-await (one invocation;
universe fetch batched where available, else per-symbol) → `persistRun` sync-await → event
publish async (queue) or sync (bus fallback) → follow-up jobs async (alarms,
`not_before` stagger) → channel sends sync inside the async job. Sharded variant:
submission sync, all shard work async, collation async (hook-driven). Workflow variant:
parent/child async with 15-s poll sleeps. Manual variant: HTTP request sync-await end to
end (goal screen returns inline, §3), except `async=1`, which selects the workflow path
(202 response).

**Batch vs realtime, quantified.** Subrequest budget `DEFAULT_SUBREQUEST_BUDGET = 35`
(`src/config/etapiConfig.ts:6`); measured options cost ~12 fetches/symbol → monolithic cap
`floor(35/12) = 2` symbols (`scheduledTasks.ts:1690`) — hence auto-shard above 2 symbols for
scheduled options, and the pre-#1785 exactly-3-of-100 symptom. Options sharding: 1 paced job
per symbol, stagger 1,000 ms; 100 symbols ≈ 100 jobs + chain jobs. Stock sharded chains:
feed shards `nasdaq → etrade → yahoo`; generate shards `assemble → pdf/xlsx/csv`. Workflow
sharding: max 4 parallel, 10-min deadline, 15-s poll. Batch windows: `screener:last_runs`
capped at 20; job history pruned at 500/session + 30 days; tick history 50; quote cache
5 min / 200 entries. Realtime pieces: manual trigger, Trigger-Now, live quote fetch at run
time, websocket `broadcast`, queue batch max 10. **No streaming feed, no realtime push of
quotes into an open screen** — every "live" number is a fetch at run time.

### 2.7 AOP fit/gap (from `docs/architecture/code/aop-fit-gap-analysis.md`)

The pipeline is *aspect-adjacent*, not aspect-driven: it has the catalogs, the retry
executor, the breaker port, and the audit sink the AOP doc prescribes, but each is invoked
manually per call site, with per-isolate state and hand-written message variants. Per stage:
trigger — no `@Audit`/`@TenantAware` interceptor, tenant threaded manually, no traceparent
across schedule → callback; guard — best-covered stage (typed `AUTH_002/003`,
`codedMessage`, episode dedup) except the Slack alert text is a hand-written variant, not
the catalog `businessMessage` (#1969 gap); feed — `withRetry` + breaker + registry, but
breaker state in-memory, no `@Measure`/`@Trace` spans, 429 handling per call site; gather
(pipeline) — **no stage identity at all** in the monolithic path (no `gather.*` event, no
metric, no failure state); analysis — coded `SCREEN_002/003` + coverage floor, but raw
`throw new Error` still used for universe/validation failures, and goal-leg failures had no
coded stage failure until #1963; generate — report retry + `REPORT_001/002/003` + single
owner, but per-format failure is `console.warn` + status field, no `@TrackCost`; store —
canonical-report seam, but store failure swallowed in the market wrapper, no `@Audit`
interceptor; serve — job-row projection, but no `withRetry` and no adoption-time validation
(a "ready" result with no artifact key is a downstream `REPORT_003` skip); deliver —
delivery retry + `DELIVER_002` + notification matrix, but per-channel texts hand-built, not
catalog-rendered (#1969 gap #1). A full AOP pass would not invent new stages — it would wrap
the existing ones (interceptor-emitted audit + trace propagation across the Q2/Q4/Q7
boundaries + catalog-only rendering + durable breaker state) and give stage 3 a first-class
failure state.

## 3. The goal-screen divergence: why thesis selection was impossible

This section is the #1963 record, kept here because it is the clearest proof of what
"no stage contract" costs. #1963 is now CLOSED; its fix is merged as `9b38d3b` (touches
`src/client/GoalScreenPanel.tsx`, `src/services/goalDrivenScreen.ts`, plus panel and
phase-3 tests). The defect below is the *before* state the fix corrects.

### 3.1 Where the 6594 comes from

The Nasdaq all-listings universe, resolved through the platform Nasdaq provider route. It
is the raw universe size that morning — not E*TRADE quotes, not a filtered result. The
leg's quotes carry price, daily change, and market cap, but **not technical fields**.

### 3.2 Why nothing for any thesis

A thesis maps to a technical momentum filter: Bullish → `bullish_breakout`, Bearish →
`bearish_pullback`, Volatile → `high_relative_volume`. Those gates need 52-week highs,
average volume, and RSI — fields listings quotes do not carry. So `screenLive` refuses
technical filters up front and returns 0 matched plus a `validationError` message saying
exactly that. The goal screen discarded that message and reported `Complete, 0 hits`.
`Unknown` bypasses the guard (momentum `any`), so it returns the whole universe as
"hits". In short, as wired for manual runs, the goal screen's stock leg can only return
**everything or nothing**. No thesis produces a selective screen through it.

The deeper gap, in the §1 frame: the goal screen runs **feed-only for stocks** — it
bypasses the gather stage, so momentum has no indicators to evaluate on. Surfacing the
refusal is the bug fix; actually doing thesis selection (routing to a capable provider, or
through gather) is a follow-up program decision, not the #1963 PR. That decision is §7.

### 3.3 The two live cases (#1963)

- Case 1 — Directional / Unknown, Stocks + Options, symbols `AAPL, NVDA, MSFT`: green
  `Complete — directional (unknown)`, `Scanned 6594 stocks (6594 matched), 0 option
  underlyings (0 contracts matched); 6594 hit(s)`, with Candidate structures `—` on every
  row. The Unknown-direction whole-universe return is **intended** (no thesis =
  everything) and the fix does not change it.
- Case 2 — Income / Bullish, symbol `aapl`: green `Complete — income (bullish)`,
  `Scanned 6594 stocks (0 matched), 1 option underlyings (0 contracts matched); 0 hit(s)`.
  The stock leg is the RC4 refused-filter case; the options leg (1 underlying scanned, 0
  contracts) is exactly the dead-E*TRADE-auth failure with symbols present, previously
  swallowed as `Complete`.

### 3.4 Data sources, artifacts, reuse

- **Data sources.** Stocks = Nasdaq listings + live quotes via the quotes route
  (E*TRADE-primary + Yahoo gap-fill; with E*TRADE dead, effectively Yahoo gap-fill).
  Options = E*TRADE chains — dead auth, so fetches fail.
- **Manual-run artifacts.** A manual run leaves the UI result plus a canonical report in
  Reports, PDF + XLSX + CSV artifacts (0 hits included), and an activity log entry. It
  does **not** email or Slack — the panel sends no delivery request. Scheduled runs add
  deliveries.
- **Pipelines reused.** Route → run execution → ScreenerAgent → provider registry → task
  ledger → scenario engine for the plan → listings stock leg / E*TRADE options leg →
  artifacts → report → log. **The gather stage is the one piece it does not reuse.**
- **Standalone? No.** The goal screen is an orchestration layer over those shared pieces,
  not a second screening implementation.
- **Different from the screener? Different capability, same engine family.** The
  Stocks/Options screens are filter-driven; Goal Screen is goal-driven (scenario → plan →
  candidate structures). The discarded-signal defect is goal-screen-specific — the
  underlying screeners produced the error signals; the goal screen threw them away.

### 3.5 The #1963 fix (Phase 0 of §7 — done)

Strictly three things, per the issue: (1) error-status leg → PARTIAL/FAILED per the #462
partial contract (`failedClasses`); (2) `validationError` stock leg (listings feed refusing
a technical filter) → PARTIAL with the feed's reason; (3) hide the structures column when
no hit carries structures. It does not change the intended Unknown semantics, and it does
not wire gather. Reported at the time: 36/36 targeted tests, `tsc` clean, full battery
re-running on the final tree — then PR → merge → §15 + close. That sequence has since
completed: fix merged as `9b38d3b`, #1963 closed.

## 4. The correction arc: what was overstated, and what replaced it

The lane investigation of 2026-10-27 first concluded, in the user's words, that "the
staged workflow does not exist yet as runnable code for screens" and that there was "no
feed/gather". That conclusion was investigated narrowly: it grepped for the #1654
`gather.ts` function names, found zero callers, and leapt to "no workflow, no gather".
That conflated one module with the stage, and skipped the lane-built work. The correction,
verified against the actual code, is:

- **Workflows exist.** `ScreenerScreenWorkflow` (Cloudflare Workflows binding) with parent
  fan-out + shard children, store/deliver steps, and stage honesty — running sharded
  market screens.
- **Gather as a stage exists.** Inside the delegated market screen, as technicals
  attachment (`attachTechnicals` / `fetchPlatformTechnicalsBatch` — RSI/MACD/gaps) before
  screening. That is the pipeline's gather. What is unwired is only the #1654 `gather.ts`
  dataset module — a different artifact.
- **Schedules, queues, agents, job system all exist.** ScheduledAgent ticks → callbacks,
  `screener-events` + delivery queues with the bus bridge, the full DO fleet, `asyncJobs` +
  ledgers + shard store + outcome sink.

**The precise divergence is narrower:** goal screens — manual and scheduled — never run
through that workflow or that delegated screen. Scheduled runs use the schedule layer but
the same direct engine; manual runs skip even that. The goal screen's stock leg never gets
the technicals gather, which is why thesis filters refuse.

**Record of the correction:** #1972 was rewritten from "build the workflow" to *migrate
the goal screen onto the existing workflow machinery* (body + correction comment
`6445967705`), and the overbroad claim on #1963 was withdrawn (comment `6445968907`). The
#1963 fix itself is unchanged — it still just makes the direct path honest. #1972 stays
filed, not started, awaiting the queue call in §7.

**Why the UX looked workflow-integrated when it was not:** every `/api/*` request goes
through the same HTTP entry and job envelope, and `apiFetch` polls the 202 job to a result
transparently — so the goal screen *submits* like everything else. The divergence is
inside the handler: instead of a staged workflow, it runs one synchronous direct-registry
screen and returns inline. The goal screen was built (Phase 3) as plan + orchestration over
the provider registry — direct calls by design at the time, before gather existed. Gather
was built later (#1654 slice 8) and never wired into any flow, so there was no staged
pipeline for the goal screen to plug into. The manual path wants a synchronous-looking
result for the UI, so it kept the direct call; scheduled paths added job-tree tracking and
deliveries without changing the screen engine, which made the direct engine look
workflow-integrated. In the user's frame: "same pipeline" is true at two layers (HTTP
submission, shared providers via the registry) and false at the one that matters (the
staged workflow).

## 5. Connectedness verdict (per component, not a blanket yes/no)

- **Genuinely exists and is wired:** schedules, wrappers, `ScheduledTasksService`, stock +
  options engines, shard-chain staged execution for scheduled stock/options,
  `mas_async_jobs` + follow-up chains, CF Queue delivery for `screener.*` events,
  in-process bus delivery, provider platform, breaker + retry executors, canonical store +
  R2 blobs.
- **Exists but is unwired (or wired only narrowly):** `gather.ts` slice-8 module (zero
  production callers — confirmed by grep: only `src/trading/gather.ts` itself and
  `tests/gather_stage_1654s8.test.ts`); CF Queue `screener-events` (producer-only,
  consumer deferred — a documented slice boundary, not an accident, but nothing consumes
  it today); Cloudflare Workflow engine (wired for 3 manual routes, unwired for all
  scheduled and all goal runs); in-memory messaging/workflow adapters (deliberately
  test-only, correctly unwired); breaker state durability (in-memory by design,
  cross-isolate sync missing).
- **Does not exist at all as runnable code:** a single unified workflow that stock, goal,
  options, and strategy screens all run through; a staged goal-screen flow on either
  staged engine; a per-stage failure state for pipeline gather in the monolithic path; a
  DLQ for the delivery queue; a durable cross-isolate breaker store; trace propagation
  across queue/workflow boundaries.
- **Where the original lane report was wrong or overstated:** (1) any blanket "nothing is
  connected" — the scheduled stock/options path is connected end to end (schedule → guard
  → screen → store → serve → deliver, with queue + job tracking when `stageChain` is
  present); (2) any "no gather" without qualification — pipeline gather is wired, slice-8
  gather is not, and they are different modules; (3) any "staged workflow does not exist"
  — withdrawn by #1972 itself; (4) calling #1963's honesty patch done before it merged —
  it is now merged (`9b38d3b`) and #1963 closed, which is what makes it Phase 0 rather
  than a pending item; (5) treating #1904 as the decided vehicle for #1972 — the queue
  decision between them is explicitly still open.

## 6. Gap list (what is genuinely missing)

1. A unified run-request path that goal submissions use (same submission endpoint,
   schedule or ad-hoc run request → workflow → queues → …).
2. A goal-screen flow on the existing workflow machinery (not a new workflow).
3. Thesis gates evaluating on enriched data (technicals gather) for the goal stock leg —
   i.e. real thesis selection, not just surfacing the refusal (§3.2).
4. A decision on slice-8 `gather.ts`: wire it under its own slice design, or leave it
   unwired deliberately. #1972 explicitly excludes it ("NOT this program's scope unless
   the slice design says so") — it must not be wired by drive-by import.
5. A DLQ for the delivery queue (today: drop after 3 retries).
6. A durable cross-isolate breaker store (today: per-isolate, fail-open on cold start).
7. Trace propagation across queue/workflow boundaries (today: none; observability 62/100
   in the AOP audit for this reason).
8. A consumer for `screener-events` (Q1) — or a deliberate decision to remove the
   producer-only queue.
9. Serve-stage retry (today: manual `retryAsyncJob` only) and a first-class failure state
   for pipeline gather in the monolithic path.
10. A usable audit read path (#1968, open) — captures must be retrievable with their
    code, message, and structured payload fields, or the stage contracts in §7 cannot be
    verified from the record alone.

## 7. Transformation to the target state

**Sequencing rule:** each phase lands as its own slice with its own verification; the
journey does not start until lane feedback on this document and the Phase 1 decision are
in. #1963's fix is the dependency everything else inherits (its PARTIAL contract).

### Phase 0 — Make the direct path honest (DONE)

#1963: legs fail loudly (PARTIAL/FAILED per the #462 contract), refused filters surface
with the feed's reason, structures column hidden when no structures exist. Merged
`9b38d3b`; #1963 closed. This phase changes no engine and wires no gather — it only stops
the direct path from discarding signals. Every later phase inherits its PARTIAL contract:
a leg failure must surface at its stage, never as a false `Complete`.

### Phase 1 — Decide the vehicle (DECISION, before any build)

The "Venus queue decision" from #1972: **standalone #1972 program, or a #1904 P1 slice**
(the IROS program owns the target DAG; this migration may ride it). #1904's own framing
ruling applies: it is an enhancement program, not a greenfield build — most capabilities
it describes are already built; P1/P3 are consolidation/formalization, and its first job
is re-verifying the target doc's gap claims against current main before slicing. Whichever
vehicle is chosen, the slices below scope to verified gaps, not assumed ones.

### Phase 2 — Goal submission through the unified run-request path

The UX submits a goal run request through the same submission endpoint as other
screeners; the flow is triggered by creating a schedule (or an ad-hoc run request) →
workflow → queues → feed → gather → store → serve → deliver. The UI reads the stored
result instead of awaiting a synchronous screen (the 202-job poll the UX already uses is
the natural shape for this — the submission layer already exists; only the handler's
engine changes). No new workflow is built: the goal-screen flow rides the existing
`ScreenerScreenWorkflow` machinery (parent fan-out + shard children + store/deliver steps
+ stage honesty), extended with a goal-plan step, not a parallel implementation.

### Phase 3 — Thesis gates on enriched data

The goal stock leg routes through the delegated screen's technicals gather
(`attachTechnicals` / `fetchPlatformTechnicalsBatch`) so momentum filters
(`bullish_breakout`, `bearish_pullback`, `high_relative_volume`) evaluate on RSI, 52-week
highs, and average volume instead of refusing. This is the actual thesis-selection
capability §3.2 says is missing. Slice-8 `gather.ts` wiring is **not** in this phase
unless a separate slice design says so (gap 4) — the two gathers must not be conflated
in the implementation either.

### Phase 4 — Stage contracts for legs

Every leg failure has a stage to fail in, with a coded stage failure, a persisted stage
record, and a retrievable audit event — the §2.4 table becomes the contract, not a
description. Concretely: gather gets a first-class failure state (not just missing
fields); serve gets a retry; the swallowed-failure inventory (§2.4) is driven to zero or
to explicit, documented, owner-accepted exceptions; and the audit read path (#1968) is
fixed so a future incident's record answers "which code, what happened, for which login"
from the record alone (the #1969 usable-captures principle).

### Phase 5 — Harden the shared path

DLQ for the delivery queue; durable cross-isolate breaker store; trace propagation
across the Q2/Q4/Q7 boundaries; a Q1 consumer (or removal of the producer-only queue);
catalog-only rendering of per-channel texts (#1969 Phase 1) so the guard's Slack alert
and every other channel render from the catalog, not hand-written variants. These are
shared-path improvements: they pay off for every family, not just goal.

### Non-goals (from #1972, carried forward)

PROD E*TRADE reconnect; options Yahoo fallback; #1904 P2 swarm negotiator and P4 closed
outcome→calibration loop; provider-contract changes. None of these ride this journey.

### Exit criteria (the journey is done when all hold)

1. Stock, goal, options, and strategy screens all run the same staged pipeline
   (schedule → queues → feed → gather → store → serve → deliver).
2. A leg failure surfaces at its stage with a coded failure and a persisted record —
   never as a false `Complete`, never silently discarded.
3. Thesis selection works on enriched data: a thesis produces a selective screen, not
   everything-or-nothing.
4. The swallowed-failure inventory is empty or explicitly owner-accepted.
5. Delivery is durable or its loss modes are explicit (DLQ wired, Q1 resolved, bus no
   longer the sole path anywhere).
6. Lane feedback on this document is incorporated and the slices were scoped to verified
   gaps.

## 8. Open questions for lane feedback (answer before slicing)

1. **Vehicle:** #1972 standalone program, or #1904 P1 slice?
2. **Slice-8 `gather.ts`:** wire it under its own slice design, or leave it unwired
   deliberately? (It is not in #1972's scope as filed.)
3. **Q1:** wire a `screener-events` consumer, or remove the producer-only queue?
4. **DLQ + breaker durability:** what designs fit the ports/adapters + deterministic
   execution invariants (#1904: hexagonal throughout, pricing/technicals/risk guards
   100% AI-free, HITL gates on trade execution)?
5. **Manual goal UX:** keep a synchronous-looking path (submit → poll 202 job → stored
   result) or move fully to stored-run reads? What does the panel show while a staged
   goal run is in flight?
6. **Thesis selection scope:** is routing the goal stock leg through the delegated
   screen's technicals gather sufficient, or is a capable-provider route also needed for
   any thesis?
7. **Trace + audit:** does the #1968 read-path fix land before, with, or after the
   goal migration? (Phase 4 assumes it; if it slips, stage contracts cannot be verified
   from the record.)

## 9. Sources

- Code: `src/agents/orchestrator/scheduledCallbacks.ts`, `src/agents/orchestrator.ts`,
  `src/services/scheduledTasks.ts`, `src/services/shardJobs.ts`,
  `src/services/shardExecutors.ts`, `src/agents/screener-agent.ts`,
  `src/trading/screenerPipeline.ts`, `src/trading/gather.ts`,
  `src/workflows/screenerWorkflow.ts`, `src/workflows/screenerWorkflowFlow.ts`,
  `src/agents/orchestrator/asyncJobs.ts`, `src/services/screenerFollowups.ts`,
  `src/services/resilience.ts`, `src/services/pipelinePolicy.ts`,
  `src/breakers/breakerPorts.ts`, `src/breakers/inMemoryBreakerAdapter.ts`,
  `src/messaging/screenerQueueConsumer.ts`, `src/services/goalDrivenScreen.ts`,
  `src/services/screeningRuntime.ts`, `wrangler.jsonc` (queues, workflows, crons,
  bindings) — all on `origin/main` at the evidence base above.
- Issues: #1963 (closed, fix `9b38d3b`), #1972 (open, incl. correction comment
  `6445967705`), #1963 claim-withdrawal comment `6445968907`, #1904 (open), #1965
  (fix merged `c2f7c86`), #1967, #1968, #1969, #1718, #1785, #462 (partial contract).
- Docs: `docs/architecture/code/aop-fit-gap-analysis.md` (incl. 2026-10-27 addendum),
  `docs/architecture/enterprise/iros-system-analysis.md` (IROS target DAG).
