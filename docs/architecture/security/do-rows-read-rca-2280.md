# Durable Objects rows-read RCA — why login went down (2026-10-29)

Status: recorded. Issue: [#2280](https://github.com/OpenAIMP/cfagent/issues/2280) (incident),
[#2284](https://github.com/OpenAIMP/cfagent/issues/2284) (this record).
Related: [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) (instrumentation and the
session-scoped cap alert), [#329](https://github.com/OpenAIMP/cfagent/issues/329) (session-store read
budget).

## 1. Symptom

Login stopped working end to end. The OAuth callback completed, wrote the session record, and
redirected to `/`; the root route could not read the session back, rendered the landing page, and the
client sent the browser to `/auth/login/github` again — a loop.

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

## 2. Evidence (measured, not inferred)

Source: Cloudflare GraphQL `durableObjectsPeriodicGroups` (`sum.rowsRead` per object) and
`durableObjectsInvocationsAdaptiveGroups` (`sum.requests`), account
`1e7e9bb45eca8d59ec86bbd6dac9b900`, queried 2026-10-29.

Day-to-date 2026-10-29:

| Object | rows read | requests | rows/request |
|---|---:|---:|---:|
| `dhmprstw@gmail.com` (per-user `SearchAgent`) | 4,097,199 | 1,685 | ~2,432 |
| `OpenAIMP` (per-user `SearchAgent`) | 961,616 | 219 | ~4,391 |
| `default_trader` | 26,425 | 128 | ~206 |
| `mha786sh@gmail.com` | 23,119 | 185 | ~125 |
| `screener:OpenAIMP` | 11,763 | — | — |
| `screener:dhmprstw@gmail.com` | 10,194 | 648 | ~16 |
| `kv` (**SessionStore**) | **5,672** | 5,582 | **~1.0** |

Total ≈ **5.14M rows read** — the cap. The two per-user agents are **98.5%** of all rows read;
`SessionStore` is **0.11%**.

Full prior day, 2026-10-28 (no deploy of ours):

| Object | rows read |
|---|---:|
| `dhmprstw@gmail.com` | 2,709,780 |
| `OpenAIMP` | 2,374,956 |
| `agent` | 218,365 |
| all others | < 40k each |

≈ 5.4M — the same two objects. The burn is **chronic**, not a spike and not caused by the
2026-10-29 auth change (#2271), which adds at most one session read per duplicate-cookie request.

The platform's own projection agrees: D1 `resource_sql_ops` for the day holds 3,945 session `get`
+ 75 `put` = **4,019 rows read**, i.e. the session path is 0.08% of the cap.

## 3. Mechanism

A Durable Object's SQLite billing counts **rows read**, which for a query is the number of rows the
engine **scanned**, not the number returned. Therefore:

```
cost per request = rows scanned by the query
daily cost       = rows scanned × requests per day
```

When a query has no usable index and filters/orders on an unindexed column, `rows scanned` equals the
table size. The table only grows, and the request repeats on a clock, so daily cost grows without any
change in traffic.

Measured signature: **2,400–4,400 rows read per request** on the two burning objects. A lookup would
read 1. This is a scan.

## 4. What data is being read

One row per record the user's agent accumulates, in tables that only grow:

| Table | One row is | Why a scan is expensive |
|---|---|---|
| `mas_job_outcomes` | one completed run: kind, trigger, status, scanned/matched counts, report and artifact keys | unbounded (no retention anywhere), `id` primary key only, read as `ORDER BY created_at DESC LIMIT ?` — no index on `created_at`, so every call sorts the whole table |
| `mas_async_jobs` | one queued/running/completed job, `payload_json` included | per-session retention (500 completed/failed, 30 days) but read as `WHERE status NOT IN ('completed','failed')` — no index on `status`, so every scheduled gate scans every session's retained jobs |
| `mas_events` | one audit/observability event for the session | no `created_at` index; retention batches scan |
| `mas_messages` | one chat message (role, content, agent) | no `session_id`/`created_at` index; retention batches scan |
| `mas_reports` | one generated report (title, summary, body keys) | deliberately KEEP/unbounded; swept with `LIMIT ? OFFSET ?`, so a full sweep costs `O(N²/limit)` |

So "a user reading millions" is not the user fetching millions of records: it is the user's panel
asking for **50 rows** and the database reading that user's **entire run/outcome history** — thousands
of rows — to answer, once per request.

Request sources that hit these objects on a clock:

- `GET /api/options/latest` — polled every 60 s by `src/client/ScheduledOptionsManager.tsx:298`
  (the read itself is one KV `get`; the surrounding agent request runs the table setup and any
  scan the endpoint performs).
- `GET /api/screener/latest` — polled every 60 s by `src/client/ScreenersHub.tsx:312`.
- `GET /api/autopilot/jobs?limit=50` — on panel mount (`AutopilotControlCenter.tsx:526`) and
  `GET /api/workflow-runs` (`routes/workflowRuns.ts:161`), both `listJobOutcomes` scans.
- The 30-minute `*/30` cron for scheduled market screens (`services/scheduledTasks.ts:773`).

## 4.1 What generates the rows — and what generates the reads

Two different multipliers, routinely conflated:

| | Driven by | Volume |
|---|---|---|
| Rows **written** | one per run (scheduled or manual), the same id replaced as the run advances | runs per day for that user |
| Rows **read** | every request that lists the table, whether or not new data exists | requests per day × table size |

The 4.1M rows on 2026-10-29 were not 4.1M new records. They were the user's ~2,432 existing
rows re-read by 1,685 requests. A day with zero runs still spends the same rows read, because
the readers are polling a history that already exists.

Consequences:

- Manual screener use is irrelevant to the read cost. It adds a row occasionally; it does not
  change the per-request scan.
- Schedules change the growth rate, not the per-request cost. The shipped defaults are few
  (`src/schedule.ts:47`: daily QA sweep, 6-hourly opportunity hunt, hourly resource alert, social
  post disabled). A per-user table of ~2.4k rows therefore means either a user-defined schedule
  firing frequently or long accumulation. The live inventory is `GET /api/schedule/goals`
  (`src/server.ts:1038`), unreadable while the DO is blocked by the cap.
- The "feed"/"gather" stages write rows through the same `recordJobOutcome` path (kind
  `discovery`). They grow the table; they do not change the multiplier.
- With a 50-row table, the same 1,685 requests cost ~84k rows instead of 4.1M. That is the whole
  effect of the index in P0 item 1.

## 5. Why nothing warned

The #1819 cap alert is explicitly session-scoped: *"Scope: SessionStore projection only — a breach
here implies the account is at >=70%"* (`src/agents/resourceGoals.ts`). It sums `resource_sql_ops`,
which only the session KV path writes. At the moment the account hit 5M, that projection held ~4k
rows — 0.08% of the cap — so the 70% alert could not fire. Agent SQL emits no measurement event at
all, and no query in the repo is checked with `EXPLAIN QUERY PLAN`.

## 6. Remediation

### P0 — remove the scans (restores headroom)
1. Indexes, created idempotently in the existing table-setup functions:
   `mas_job_outcomes(created_at DESC)`, `mas_async_jobs(status, created_at)`,
   `mas_events(created_at)`, `mas_messages(created_at)`, `mas_memory(updated_at)`.
2. Replace `WHERE status NOT IN ('completed','failed')` with an index-usable predicate
   (`status IN ('queued','running',…)`) and return only the fields the gate needs.
3. Retention for `mas_job_outcomes`, same shape as the existing `asyncJobs` pruning
   (age and count bound).
4. Keyset pagination (`WHERE created_at > ? ORDER BY created_at LIMIT ?`) for `mas_reports`
   sweeps, so one sweep is `O(N)` instead of `O(N²/limit)`.
5. Wrap the Orchestrator's `sql.exec` in the `execCounted` helper `SessionStore` already uses and
   emit `store_op` v2 events with a statement tag, so the next investigation reads numbers.

### P1 — reduce steady-state cost
6. Account-wide cap budget: sum every namespace (session + agent SQL) against the rows-read cap and
   alert at 50/70/85% with the top statements, instead of the session-only projection.
7. Consolidate the two `listJobOutcomes` callers into one read per request and cache the small
   "recent outcomes" list with a short TTL.
8. `EXPLAIN QUERY PLAN` pin: fail the suite when a hot statement plans a `SCAN` where a `SEARCH`
   is expected.
9. Lengthen the negative session-cache TTL (the positive 60 s TTL is the revocation bound pinned by
   #1750 and stays).

### P2 — structural
10. One measured SQL surface for every DO, not only `durableKv`.
11. Cost budgets per scheduled job and per request, alerted on breach.
12. A resource dashboard over `resource_sql_ops` and the rollups.

### Not the fix
- Raising the session cache TTL: the burn is not the session path.
- Moving to a paid plan: it buys headroom, it does not remove a scan that grows with data.

## 7. Verification

- `EXPLAIN QUERY PLAN` on each changed statement returns `SEARCH … USING INDEX`.
- `resource_sql_ops` shows agent statements with rows read after P0 item 5 ships.
- A normal day, including the 30-minute ticks and the 60-second polls, stays under 25% of the cap.
- Login round-trip works with the session store healthy.

## 8. Known gap

Which exact statement dominates within the two burning objects is **not yet attributable** — agent
SQL has no per-statement measurement. The ranking above is by scan size × frequency and is confirmed
only for the object and the per-request cost, not for the individual query. P0 item 5 closes it.
