# Durable Objects rows-read RCA — why login went down (2026-10-29)

Status: living record, consolidated on the incident issue.
Issue: [#2280](https://github.com/OpenAIMP/cfagent/issues/2280).
Related: [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) (instrumentation and the
session-scoped alert), [#329](https://github.com/OpenAIMP/cfagent/issues/329) (session-store read
budget), [#2294](https://github.com/OpenAIMP/cfagent/issues/2294) (outcome retention).

## 1. Symptom

Login stopped working end to end. The OAuth callback completed and wrote the session record, but the
redirect to `/` could not read it back, so the browser was rendered signed-out and sent to
`/auth/login/github` again — a loop.

`wrangler tail` on `ai-search-agent` showed every `SessionStore` request failing at construction:

```
outcome: exception   entrypoint: SessionStore
Error: Exceeded allowed rows read in Durable Objects free tier.
    at new SessionStore (server.js:501327:26)
[store:sessions] get failed: Exceeded allowed rows read in Durable Objects free tier.
```

The cap is account-level: when it is exhausted, **every** DO read in the account fails, not only the
object that consumed it. `SessionStore` is the first DO every request touches, which is why the
outage surfaced there.

## 2. Measured evidence

Source: Cloudflare GraphQL, account `1e7e9bb45eca8d59ec86bbd6dac9b900`, queried 2026-10-29.
`durableObjectsPeriodicGroups` (`sum.rowsRead`, `sum.rowsWritten`) and
`durableObjectsInvocationsAdaptiveGroups` (`sum.requests`, dimension `type`).

### 2.1 Per object, 2026-10-29 (day-to-date)

| Object | rows read | requests | rows/request |
|---|---:|---:|---:|
| `dhmprstw@gmail.com` (per-user `SearchAgent`) | 4,097,199 | 1,685 | ~2,432 |
| `OpenAIMP` (per-user `SearchAgent`) | 961,616 | 219 | ~4,391 |
| `default_trader` | 26,425 | 128 | ~206 |
| `mha786sh@gmail.com` | 23,119 | 185 | ~125 |
| `screener:OpenAIMP` | 11,763 | — | — |
| `screener:dhmprstw@gmail.com` | 10,194 | 648 | ~16 |
| `kv` (**SessionStore**) | **5,672** | 5,582 | **~1.0** |

Total ≈ **5.14M rows read** — the cap. The two per-user agents are **98.5%** of it; the session
store is **0.11%**. The platform's own D1 projection agrees for the session path: 3,945 `get` + 75
`put` = 4,019 rows read on the day.

### 2.2 Prior full day, 2026-10-28 — chronic, not a spike

| Object | rows read |
|---|---:|
| `dhmprstw@gmail.com` | 2,709,780 |
| `OpenAIMP` | 2,374,956 |
| `agent` | 218,365 |
| all others | < 40k each |

≈ 5.4M, the same two objects, on a day with no deploy of ours.

### 2.3 Writes versus reads

| Day (UTC) | rows written | rows read | read:write |
|---|---:|---:|---:|
| 2026-10-25 | 28,193 | 2,512,521 | ~89× |
| 2026-10-26 | 29,883 | 5,520,010 | ~185× |
| 2026-10-27 | 30,222 | 5,162,815 | ~171× |
| 2026-10-28 | 43,834 | 5,418,014 | ~124× |
| 2026-10-29 (to ~12:00) | 27,973 | 5,147,030 | ~184× |

Top writers on 2026-10-28: `dhmprstw@gmail.com` 20,588; `screener:OpenAIMP` 6,374;
`screener:dhmprstw@gmail.com` 6,373; `OpenAIMP` 5,225.

`rowsWritten` counts inserts **and updates**: a run that updates its status three times counts three.
So ~28-44k writes/day is an upper bound on records created, and it is 100-190× smaller than the rows
read. **The cap is on reads; writes cannot exhaust it.**

### 2.4 Request shape — two different readers

Hourly for `dhmprstw@gmail.com`, 2026-10-29:

| Hour (UTC) | requests | rows read | rows/request |
|---|---:|---:|---:|
| 03:00 | 80 | 114,689 | 1,434 |
| 04:00 | 1,149 | 887,485 | 772 |
| 05:00 | 274 | 638,596 | 2,331 |
| 06:00 | 50 | 625,204 | 12,504 |
| 07:00 | 46 | 629,621 | 13,687 |
| 08:00 | 44 | 633,651 | 14,401 |
| 09:00 | 42 | 567,953 | 13,523 |

- **Steady hours:** ~45 requests/hour — about one every 80 seconds — at **~13.5k rows each**
  (~600k rows/hour). A repeating, clock-driven read.
- **04:00:** 1,149 requests at ~772 rows each — a burst of small queries in the nightly window.

The daily average (~2,432 rows/request) mixes both and understates the steady reader.

### 2.5 Invocation types, 2026-10-29

| Type | Count |
|---|---:|
| `http` | 1,352 (38 `exceededMemory`) |
| `alarm` | **331** (19 `exceededMemory`, 8 `scriptThrewException`, 7 `clientDisconnected`, 2 `exceededResources`) |
| `hibernation` | 2 |

Alarms are 20% of requests. **4.1M ÷ 331 ≈ 12.4k rows per alarm**, which matches the steady
~13.5k rows/request.

## 3. Mechanism — rows read are rows scanned

A Durable Object's SQLite billing counts rows the engine **scanned**, not rows returned:

```
cost per request = rows scanned by the query
daily cost       = rows scanned × requests per day
```

Without a usable index, `WHERE`/`ORDER BY` on an unindexed column scans the whole table; `LIMIT 50`
applies only after the scan. The table grows, the request repeats, and cost rises with no change in
traffic. Measured signature: 2,400-14,400 rows per request where a lookup would read 1.

### 3.1 The dominant reader: the framework's alarm job queue

The `agents` framework's `Lifecycle.alarm()` drives a durable job queue table **`cf_agents_jobs`**,
created as `id TEXT PRIMARY KEY ... WITHOUT ROWID` — **with no index on `time`**. Each alarm runs:

| Query | Rows read |
|---|---|
| `JobQueue.due()`: `SELECT * FROM cf_agents_jobs WHERE time <= ? ORDER BY time ASC` | whole table |
| `nextAlarmTime()`: `MIN(time)` where `exclusive = 1` | whole table |
| `nextAlarmTime()`: `MIN(time)` where `singleflight = 0 OR running = 0 …` | whole table |
| `nextAlarmTime()`: hung-recheck `MIN(...)` | whole table |

`rearmAlarm()` runs `nextAlarmTime()` again after every push and at the end of every alarm, so one
alarm costs roughly **four full scans** of the queue.

```
331 alarms/day × 4 scans × ~3k queued rows ≈ 4.0M rows/day
```

That is the 4.1M. It also explains the `exceededMemory` outcomes on alarm invocations: the alarm
work is loading the queue repeatedly.

Confidence: high on the mechanism and the arithmetic; the queue size (~3k) is inferred, not yet read
— see §8.

### 3.2 Secondary readers in `mas_*`

| Query | Index | Cost |
|---|---|---|
| `SELECT * FROM mas_job_outcomes ORDER BY created_at DESC LIMIT 50` (`services/jobOutcomes.ts:137`) | added in #2294 | was whole table |
| `SELECT payload_json FROM mas_async_jobs WHERE status NOT IN ('completed','failed')` (`services/scheduledTasks.ts:773`) | none on `status` | whole table, 48×/day |
| `SELECT … FROM mas_reports … LIMIT ? OFFSET ?` (`services/reportSemanticIndex.ts:263`) | `created_at` yes, OFFSET still | `O(offset+limit)` per page; a sweep is `O(N²/limit)` |
| retention batches on `mas_events` / `mas_messages` / `mas_memory` | none on `created_at` | whole table per batch |

### 3.3 Ranking — current, with the superseded ones named

1. **Framework alarm queue (`cf_agents_jobs`) — primary**, ~4M/day by arithmetic.
2. `mas_async_jobs` status scan — 48×/day, whole table (size unmeasured).
3. `mas_reports` OFFSET sweeps — weekly, quadratic in report count.
4. `mas_job_outcomes` feed — **superseded as the primary hypothesis** (#2294 indexed and bounded
   it; it was derived from an average that mixed two readers).
5. `mas_events` / `mas_messages` scans — plausible secondary, unmeasured.

## 4. Where the data comes from

### 4.1 The rows the scans read

`mas_job_outcomes` — one row per run, upserted by id through its lifecycle, written by five call
sites:

| Writer | Trigger |
|---|---|
| `agents/orchestrator/asyncJobs.ts:500` | an async job reaches a terminal state |
| `agents/routes/etradeOptionsScreen.ts:310` | a manual options screen run |
| `services/optionsServeRecord.ts:117` | the serve stage writing artifact keys |
| `services/goalScreenReports.ts:176` | a goal-screen report run |
| `services/scheduledTasks.ts:451` | a scheduled task run |

Fields: `id, kind, trigger, status, scanned, matched, coded_error, report_url, pdf_key, xlsx_key,
csv_key, delivery_json, origin, created_at`. In plain terms: "*discovery run X — 2 scanned,
2 matched, report at …*".

### 4.2 What generates runs — the `*/30` tick

`*/30 * * * *` is the only cron driving scheduled work (every 30 minutes, :00 and :30 UTC). It exists
because the account sits at the **Workers Free ceiling of 5 cron triggers** (error 10072), so the
daily research run, weekly reflection, weekly weight adjustment and weekly corpus sync ride this
heartbeat instead of owning triggers. Each tick:

1. `ScheduledAgent.onCron()` — evaluate stored goals, budget-check, create Orchestrator jobs;
2. `POST /research/scheduled-tick`, `/reflection/run`, `/adaptation/weights/run`,
   `/knowledge/corpus-sync` — unconditional dispatches whose fire/no-fire decision is inside.

Cost: 48 ticks × 5 dispatches ≈ **240 requests/day** — 0.2% of the heavy agent's traffic. **The tick
is not the reader**; it is upstream of the data. Its frequency is also the firing resolution of every
user schedule, so changing it changes what schedules mean.

## 5. What data exists, what may be deleted, and how

| Table | One row is | Retention today | Verdict |
|---|---|---|---|
| `mas_job_outcomes` | one run outcome + artifact keys | **90d + 500-row cap** (#2294) | prune; feed reads newest 50 |
| `mas_async_jobs` | one job incl. `payload_json` | 30d terminal + 500/session at submit | prune at source |
| `mas_events` | one audit/observability event | 365d nightly | prune |
| `mas_messages` | one chat message | 90d nightly | prune |
| `mas_memory` | one memory key | 365d by `updated_at` | prune |
| `mas_reports` | one generated report | **KEEP** (bodies in R2) | never delete rows raw; keyset reads |
| `mas_transactions`, `mas_trades` | financial ledger/orders | KEEP | never |
| `mas_policy_verdicts` | signed compliance ledger | KEEP | never |
| `mas_watchlists`, `mas_referrals` | user content | KEEP | never |
| `mas_settings`, `mas_autopilot` | per-key state | KEEP | never |

### 5.1 How deletion happens

`pruneJobOutcomes` (age delete, then keep-newest-500) runs from **two** places, because the nightly
dispatch reaches only one instance:

1. **`listJobOutcomes`** — first feed read per instance per 24h, guarded by the durable
   `mas_job_outcomes_meta.pruned_at` row. This is what reaches the per-user agents where the history
   lives.
2. **`/schedules/trigger-retention`** at 04:00 UTC — the shared Orchestrator instance only.

Documented in `src/security/storageRetention.ts` (decision header) and the #2294 changelog.

Deletion cannot run while reads are blocked: a delete reads rows to find them. It runs on the first
successful read after the quota resets.

Deletion alone does not fix the defect — the scan returns as the table regrows. Index first, then
bound.

## 6. Why nothing warned

- The #1819 cap alert is explicitly session-scoped: *"Scope: SessionStore projection only — a breach
  here implies the account is at >=70%"*. It sums `resource_sql_ops`, which only the session KV path
  writes. At exhaustion that projection held ~4k rows — 0.08% of the cap — so it could not fire.
- Agent SQL and framework SQL emit **no** rows measurement at all.
- No query in the repo is checked with `EXPLAIN QUERY PLAN`.

## 7. Remediation

| # | Change | Effect | Status |
|---|---|---|---|
| 1 | `CREATE INDEX idx_cf_agents_jobs_time ON cf_agents_jobs(time)` from agent startup | each of the four scans per alarm becomes a seek | **pending** |
| 2 | Find and stop the queue growth (~3k rows) | removes the multiplier inside each scan | **pending** — needs the count (§8) |
| 3 | Compute `nextAlarmTime()` once per wake, including re-arm | halves-to-quarters the scans per alarm | **pending** |
| 4 | Index `mas_job_outcomes(created_at)` + 90d/500 retention | feed scan + unbounded growth | **shipped** (#2294) |
| 5 | Index `mas_async_jobs(status, created_at)`; replace `NOT IN` | 48 full scans/day → seeks | **pending** |
| 6 | Index `mas_events`/`mas_messages` `created_at` | retention batches stop scanning | **pending** |
| 7 | Keyset pagination for `mas_reports` sweeps | `O(N²)` → `O(N)` | **pending** |
| 8 | Rows-per-statement measurement for agent SQL + framework SQL | makes the next burn attributable | **pending** |
| 9 | Account-wide cap alert (50/70/85%, top statements) | early warning instead of outage | **pending** |
| 10 | Cache the polled reads (same 50 rows, 45×/hour) | removes the repeated scan entirely | **pending** |

Not the fix: raising the session cache TTL (the burn is not the session path); moving to a paid plan
(buys headroom, does not remove a scan that grows with data); purging user schedules (they change
growth, not per-request cost).

## 8. Open questions

1. **`cf_agents_jobs` row count on the burning object.** If ~3k, §3.1 is proven; if small, the
   arithmetic points elsewhere. One query, blocked until reads recover.
2. **Which exact statement** dominates. Closes with item 8.
3. **Per-table split** of the `mas_*` reads. Closes with item 8.

## 9. References

- `src/security/sessionStore.ts` — `execCounted`, the measurement pattern.
- `src/security/durableKv.ts` — `store_op` v2 emission.
- `src/security/storageRetention.ts` — retention decisions.
- `src/services/jobOutcomes.ts` — outcome feed, prune, index.
- `src/services/scheduledTasks.ts` — async-jobs gate scan.
- `src/services/reportSemanticIndex.ts`, `corpusSync.ts` — OFFSET sweeps.
- `src/agents/resourceGoals.ts` — session-scoped cap alert.
- `node_modules/agents` — `Lifecycle.alarm()`, `JobQueue`, `JobDriver`.
