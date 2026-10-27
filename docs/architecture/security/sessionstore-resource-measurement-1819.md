# SessionStore resource measurement — cfagent #1819

**Issue:** [#1819](https://github.com/OpenAIMP/cfagent/issues/1819) — 2026-10-26
agent.openaimp.com sign-in bounce: SessionStore Durable Object free-tier
rows-read quota exhausted (5M/day), script `ai-search-agent`, POST `/kv`,
15:16:33 EDT.

**Status of this document:** MEASUREMENT SLICE. The inventory below is
verified on current main with file/line evidence; the instrumentation it
specifies is built in the same PR as this doc. The issue stays OPEN after
this slice: the comparison against Cloudflare dashboard data and the fix
slice are still owed, and sign-in is NOT claimed verified by this slice
(a quota reset alone is not verification).

**Standing direction:** optimize resource utilization — measure first, then
cut reads at the named source. Paid plan only as a decided fallback, never
the default. No fix, no production switch change, no paid-plan decision in
this slice.

**Update 2026-10-27 (rollup slice, separate PR):** the daily rollup,
hourly 70% cap alert, and dashboard-comparison report now run as
ScheduledAgent goals on the existing */30 tick, reading the D1
projection this slice writes (fan-out enabled for the auth path with
`withProjection: true`). See
`sessionstore-resource-rollup-alert-1819.md`. Nothing in the inventory
or verdicts below is rewritten by that slice; the comparison procedure
in §5 is now executed by the comparison goal, with dashboard data
still owner-supplied.

## 1. Inventory headline

**Top SessionStore source, with numbers: wired `requireAuth` fresh reads —
~1 read per authenticated `/api/*` request** (`src/server.ts` requireAuth →
`validateAndTouchWiredSession` → fresh `getSession`, when wiring is ON and
the session carries `internalUserId`; see §2 claim 3 for the precise scope).

Per open tab per hour, visible tab, wired session (SessionStore rows only;
polled endpoints' own DO rows are separate namespaces):

| Load | SessionStore reads/hr | Per day (24 h visible) |
| --- | --- | --- |
| Plausible (idle jobs poll + options + ticker fallback + auto-refresh 15 s) | ~1,200–1,400 | ~29k–34k |
| Aggressive (busy jobs poll + everything + auto-refresh 5 s) | ~3,500–4,000 | ~84k–96k |

Reaching 5M/day from polling alone needs ~52–172 continuously-visible tabs
for 24 h — implausible for a single-owner dashboard. **Polling contributes;
it does not explain 5M alone.** Automation does scale to 5M (10 callback
attempts/sec × ~5 reads ≈ 4.3M/day; or continuous UUID-cookie hammering
across isolates), but no such traffic is proven from code — it is a
candidate for the instrumented data, not a finding.

**What remains unmeasurable statically, stated exactly:** whether the 5M
is (a) SessionStore-local or (b) account-summed across all DO namespaces,
and if (b), each other namespace's share. Code cannot settle quota scope
or production schedule contents. The counters that prove it are named in
§5 — do not present any hypothesis about the 5M burner as a measurement.

## 2. CEO-lane claim verification (on current main)

Each claim from #1819 comments 6425612105, 6425761388, 6425794798 was
verified against main, not assumed. Verdicts:

| Claim | Verdict | Evidence / correction |
| --- | --- | --- |
| Login start works (302 to GitHub); failure downstream | CONFIRMED, route spelling corrected | Only generic `/auth/login/<id>` + `/auth/callback/<id>` remain (`src/server.ts:478-488`); `startLogin` returns 302 with zero SessionStore ops (`src/security/oidcProvider.ts:241-261`); OAuth state is an HMAC string, not a stored record (`src/security/session.ts:175-197`). Callback does binding/membership reads + `createSession` put + audit append, then 302s with a cookie even if store ops silently failed — the next `/` request fails auth: that is the bounce, downstream of start. |
| Point gets cheap; only `list` is a prefix scan | CONFIRMED | Schema `kv_store (ns, key, value, expires_at, PRIMARY KEY (ns, key))` (`src/security/sessionStore.ts:28-33`). Point get = 1 PK lookup; `list` restricted to `ns=etrade` + `etrade:token:` prefix, an index range scan whose cost scales with matching token rows, not a full-table scan. Caveat: "1 row" is the expected cursor value, not a measured one — this slice now measures it. |
| Wired sessions bypass the 60 s cache on every request | CONFIRMED, precisely scoped | Only when wiring is ON (`IAAA_WIRING_ENABLED`) AND the session carries `internalUserId` (`src/server.ts:3298-3330`, `src/security/iaaaEnforcement.ts:87-122`). Steady-state wired cost ≈ 1 fresh read per request + ~1 persist per 60 s of activity + ~1 cached re-read after each touch (the touch invalidates that isolate's cache). Persist is NOT per request (touch interval 60 s, `src/security/iaaaSessionActivity.ts:51-60`); invalidation is a local `Map.delete` (zero DO rows). Legacy sessions, and all sessions with wiring OFF, keep the cached path with no fresh read. |
| Audit log is a single growing JSON array; append = full read + rewrite | CONFIRMED, significance CORRECTED | `IAAA_AUDIT_LOG_KEY = "iaaa-audit:events"`, one key, no expiry (`src/security/iaaaAuditStore.ts:44-47`); append = 1 get + 1 put of the whole array; overview = full read + in-memory filter (`src/security/iaaaAdminOverview.ts:142-148`). **But it is 1 row/op however large the JSON grows** — its cost is payload bytes, CPU/latency, and lost-update risk, NOT rows-read volume, and appends happen only on auth events (login/logout), not per request. It does not explain a rows-read breach by itself. |
| UI polling scale; old 4 s jobs poll already fixed | CONFIRMED in structure, CORRECTED in one place | Jobs poll is visibility-aware (4 s busy / 20 s idle / stopped hidden: `src/client/AsyncJobsPanel.tsx:68,87-96`, `src/client/polling.ts:46-95`). Global Auto-Refresh is OFF by default, 15 s default, min 5 s, broadcast with no visibility check (`src/client/Chat.tsx:160-185,272-299`); options panels re-fetch on broadcast. AutonomousOptionsRuns 60 s plain poll (`src/client/options/AutonomousOptionsRuns.tsx:37,53-58`) AND a second 60 s poll in `ScheduledOptionsManager.tsx:297` — two polls/min if both mounted. Ticker 12 s fallback ignores visibility (`src/client/components/MarketTickerTape.tsx:97-130`); search 10 s fallback only while the modal is open (`src/client/components/StockSearchBar.tsx:180-240`). Also found: `OptionsFlowsHub` 30 s poll while mounted (`src/client/options/flows/OptionsFlowsHub.tsx:162-168`). Poll endpoints' own costs are their DOs' SQL, not SessionStore — SessionStore pays only the auth read. |
| Hourly options scans 24/7, no market-hours/weekend guard; NASDAQ100/SP100 pair ~20 s apart; 30-min tick; Track 1 screens | MIXED | **No market-hours/weekend guard exists in code** (grep over `src/agents/routes/schedules.ts`, `src/agents/orchestrator/scheduledCallbacks.ts`, `src/services/scheduledTasks.ts` returns nothing); hourly interval schedules fire 24×7 unless disabled. **The NASDAQ100/SP100 pair, the ~20 s spacing, and Track 1 08:30/12:30 times are NOT in code** — no `SP100` schedule, no such times exist in `src/`; they are production schedule-table contents, not repo state. What code proves is the overlap mechanism: dedup keys are per-universe (`claimScheduledExecution` `options:<universe>:…`, slot guard `screener:scheduled:last-slot:<universe>`), so two different universes with overlapping constituents both fully scan. **#1789-style dedup does NOT remove cross-universe overlap** (it suppresses same-slot duplicates of the same schedule) and no #1789 code/migration/changelog entry is identifiable on current main — only design prose (`src/workflows/workflowPorts.ts:82-85`). 30-min tick CONFIRMED (`wrangler.jsonc:110-111`, `src/server.ts:3111-3180`); the tick itself touches SessionStore only via due-goal executions. Per-run auth is one pre-flight per run for the monolithic path (`src/services/scheduledTasks.ts:475-505,890,1232`); sharded per-symbol jobs cold-start their own token cache, so a sharded scan can pay ~1 token get per shard isolate, not 1 per run. |
| Quota account-wide; other burners (Agents DOs, RAG/D1, scan/run stores) | PARTIALLY CONFIRMED as candidates, UNPROVEN as to scope | Other DO namespaces exist on the same account (`wrangler.jsonc:45-71`: SEARCH/SCREEN/RESEARCH/PAYMENTS/SCHEDULED/REPORT_ASSET/TRADING/ORCHESTRATOR/OPTIONS_SCANNER). Hot per-poll SQL: jobs list ≤100 rows, memory `LIMIT 50`, job prune `LIMIT -1 OFFSET 500` (scans ≥500 rows per prune). **CORRECTION to the inventory analysis: a D1 binding DOES exist** (`wrangler.jsonc:25`, `AGENT_DB`/`agentdb`) — but no `meta.rows_read`/`meta.rows_written` consumer exists in `src/`, so D1 rows are not measurable from code today. Whether the 5M sums across namespaces is a dashboard/billing fact, not a code fact. |
| Instrumentation facts (cursor rowsRead/rowsWritten; D1 meta; store_op gaps) | CONFIRMED, one scope correction | `storage.sql.exec` cursors expose `rowsRead`/`rowsWritten` (used once in-tree: `src/agents/orchestrator/asyncJobs.ts:663`); SessionStore discarded every cursor. `store_op` v1 (`src/security/storeMetrics.ts`) had ns/op/outcome/latencyMs only — no rows, no caller, no trigger. D1 `meta` fields are real in general but inapplicable as configured (no consumer in-tree). |

## 3. Caller inventory (SessionStore, single `kv` instance)

All namespaces share one DO instance and one `kv_store` table; `ns` is only
a key prefix. Full per-caller table (caller → ns/op → frequency) was
produced from static analysis; the load-bearing rows:

- `sessions` get — `requireAuth`, every authenticated `/api/*` request:
  legacy ~1 per 60 s per session per isolate (cache hit = 0); wired ~1 per
  request; unauthenticated UUID cookie with no record ~1 per 10 s per
  isolate (negative cache); non-UUID/no cookie = 0 (regex gate).
- `sessions` put — `createSession` (login only); `updateSession` wired
  touch persist (≤1 per 60 s of activity per wired session).
- `sessions` delete — `deleteSession` (logout only).
- `sessions` get+put — audit append (per auth event only) and audit list
  (per admin overview); binding resolve (per login, 1–2 gets + 2 puts for a
  new binding); membership index + records (per login/provision/overview,
  1 index get + N record gets, N = memberships per user — NOT per request).
- `etrade` get — `getValidTokens`, 60 s isolate token cache (~1 per 60 s
  per (env, login) per isolate; 2nd get only on legacy-key fallback).
- `etrade` list + per-token consume/delete/put — `renewAllStoredETradeTokens`,
  03:00 UTC cron, once/day (plus manual triggers). Per listed token: 1 list
  row + ~4 ops. At 1 run/day, even 1,000 prefix rows cost ~1,000 rows/day —
  negligible unless prefix accumulation reaches tens of thousands AND the
  list runs frequently (it does not).
- `etrade` put/delete — connect/renew/revoke only.
- `api_keys` get/put/delete — key mint/verify/revoke only.
- `public` get/put/delete — Public connect/status/callback only.
- `payments` consume/delete — x402 replay guard per payment/draft only.
- `slack_principal_links` get/put/consume — link/claim only.

**Not SessionStore:** all `mas_*` SQL (jobs, memory, events, reports,
screens) lives in the SearchAgent/Orchestrator/ScreenerAgent DOs' own
SQLite. `/api/jobs` and `/api/options/latest` poll costs to SessionStore
are auth-only.

**Expired-row accumulation:** no sweep exists. Expiry deletion is lazy
only (re-read of the exact key, `sessionStore.ts` get path). E*TRADE
tokens are deleted on revoke or when re-read expired, but a never-re-read
token sits forever and keeps being visited by the list scan. List-scan
cost per run ≈ `T_prefix` = live + expired-unread token rows under the
prefix. `T_prefix` and total `kv_store` row count are production numbers
with no admin endpoint in the repo — obtaining them needs DO-side
instrumentation or dashboard SQL access, not a code read.

**Bounce-amplifier cost:** a human login attempt costs ~4–6 reads
(binding + membership + audit get) + ~4–6 writes (~10 ops, ~5 reads);
landing reloads after a failed landing add only the negative-cache read
(1 per isolate per 10 s). A human retrying every 30 s for an hour ≈ 600
reads — 0.01% of 5M. **The bounce is a symptom amplifier for user pain,
not a rows-read amplifier at human speed.** Related fix-candidate finding
(recorded, NOT fixed in this slice): `createStoreKv.put` swallows DO
failure — with `legacyFallback: false` for sessions, a null send returns
void silently (`src/security/durableKv.ts:216-226`) — so `createSession`
mints and returns a session id that was never stored, the callback 302s
with that cookie, and the next `requireAuth` misses. Under quota
exhaustion every login *looks* successful and then bounces. The fix lane
should decide whether a failed session put must fail the login loudly.

**Public/unauthenticated routes:** no session read for static assets,
`/.well-known/oauth-client-id-metadata-document`, `/health`,
`/api/health`, `/login` render, `/auth/login/<id>` start, `/mcp/scanner`,
A2A dispatch (key-gated, not session-gated). `/api/features`,
feature-gated routes, and `/` call `requireAuth` but tolerate anonymity
(0 reads with no/non-UUID cookie, normal cached/fresh read with a UUID
cookie). Every other named `/api/*` route requires auth, plus the
catch-all 401s unmatched `/api/*` without a session.

**False "no daily read cap" comments — corrected in this slice** (all three
files touched by the slice):
1. `src/security/sessionStore.ts` header — corrected.
2. `src/security/durableKv.ts` header — corrected.
3. `src/security/session.ts` header — corrected.
Recorded as follow-ups (files not touched by this slice):
`wrangler.jsonc:61` comment ("sessions + credentials off KV (no daily read
cap)") and `src/security/staticAssets.ts:31` (recounts the KV-era 100k
exhaustion, not a DO claim — leave alone unless touched).

## 4. Instrumentation built in this slice

**Port** — `src/telemetry/resourceUsagePorts.ts` (pure, no bindings, no I/O;
#1742's port pattern, different subject):

- `ResourceUsageEvent`: ns, op, rowsRead, rowsWritten, caller?, trigger?,
  statement fingerprint?, tenantId?/runId?/sessionRef?, timestampMs,
  durationMs?. Caller/trigger are populated ONLY where a call site passes
  attribution explicitly; absent = aggregates as "unknown", never inferred.
- `fingerprintSql`: whitespace-normalized parameterized template. No bound
  value, token, or user datum ever enters a statement field; `sessionRef`
  must already be a truncated hash, never a raw session id.
- `toObservabilityEvent`: converts to #1743's landed `ObservabilityEvent`
  as type `resource.sql_op` — same tenant/run/session scope, same key-based
  redaction (field keys chosen to have nothing to redact), same single
  Analytics Engine index constraint (tenant-as-index1). This is a new event
  TYPE inside the existing stream, not a second schema.
- `bucketTotals(events, bucketMs)`: the single aggregation definition —
  time-bucketed totals by ns/op/caller/trigger in dashboard units (rows
  read/written per op).

**Adapters + composition** — `src/telemetry/`:

- `ObservabilityResourceUsageAdapter`: writes through #1743's sink
  (Analytics Engine in production, console degradation when unbound).
  Never throws.
- `D1ResourceUsageAdapter`: own table `resource_sql_ops`, created
  idempotently by the adapter itself — deliberately NOT through the shared
  migration-runner list, so measurement landing does not couple to a
  cross-cutting migration change. Totals query groups by time bucket +
  ns/op/caller/trigger. Recording never throws; totals (a query path)
  throws visibly on DB error.
- `InMemoryResourceUsageAdapter`: test double + local dev; same port
  semantics, same bucket definition.
- `createResourceUsagePort(env)` precedence, durability-first: OBSERVABILITY
  bound → AE stream; else AGENT_DB bound → D1; else null. It NEVER returns
  an in-memory adapter: a per-isolate array constructed per request would
  look like instrumentation while measuring nothing, so unwired callers
  fall back to the store_op v2 log lines alone.

**Emitters:**

- `SessionStore.fetch` returns `rowsRead`/`rowsWritten` summed across its
  statements (cursor fully consumed via `toArray()` before reading totals)
  plus the parameterized statement template, for every op (get incl. the
  expired-get lazy delete sum, list, consume incl. the claim insert sum,
  put, delete).
- `store_op` v2 (`src/security/storeMetrics.ts`, funnel in
  `src/security/durableKv.ts`): the Workers Logs record now carries
  rowsRead/rowsWritten/statement from the DO reply and caller/trigger when
  attribution was passed. Failure paths carry no rows (no reply measured).
  When a resource sink is wired, the funnel forwards the same event to it;
  forwarding never throws and adds no store round-trip.
- Attribution wired at the top source in this slice: `requireAuth`
  (`src/server.ts`) passes `{caller: "requireAuth", trigger: "user"}` +
  sink to the cached path, and `{caller: "validateAndTouchWiredSession",
  trigger: "user"}` + sink to the wired fresh-read and persist paths.
  Cache hits emit nothing (correct: no rows read). All other call sites
  keep the default (rows measured, caller "unknown") until the follow-up
  wiring below.

**Deliberately NOT built:** no second aggregation system, no second
rollup, no second alerting path (the 70%-of-cap alert from the CEO proposal
is a next-step decision, not built here); no polling/cache/schedule
changes; no gateway LLM-token-spend capture (see follow-ups — #1741's
snapshot carries counts, not token spend).

## 5. How the comparison must be run (owner-supplied dashboard data)

**Inputs owed (owner-side, never invented):**

1. Cloudflare Dashboard → Durable Objects → Metrics, rows read/written
   per DO namespace, hourly, for 2026-10-26 (SessionStore vs SearchAgent
   vs ScreenerAgent vs others). This is the single decisive view.
2. Workers Logs `store_op` v2 lines aggregated by ns/op/caller/trigger,
   hourly, for the same day (available once this slice is deployed; for
   2026-10-26 itself only v1 op counts exist — rows must come from the
   dashboard side for that day).
3. Production schedule table contents (to verify/falsify the NASDAQ100/
   SP100 pair, 20 s spacing, Track 1 times) and `T_prefix` (live +
   expired token rows) if obtainable.

**Procedure after this slice deploys (minimum one full day of traffic):**

1. Compute instrumented totals with `bucketTotals` (or the D1 totals
   query) at 1-hour buckets, grouped by ns/op/caller/trigger.
2. Line them up against the dashboard's hourly rows-read series for the
   SessionStore namespace, same buckets, same units.
3. **Agreement** = instrumented SessionStore rows ≈ dashboard SessionStore
   rows (same order of magnitude, same top caller, same hourly shape —
   steady burn vs spike at a specific job). Agreement licenses the fix
   slice to target the named caller (expected: `requireAuth` /
   `validateAndTouchWiredSession` if wired traffic dominates).
4. **Gap, dashboard ≫ instrumented** = the burner is outside SessionStore
   (another DO namespace — check the per-namespace dashboard split first)
   or in unattributed SessionStore callers (caller "unknown" share large —
   extend attribution wiring per §6 before fixing anything).
5. **Gap, instrumented ≫ dashboard** = double counting or an attribution
   leak (same op recorded twice, or a non-DO cost folded into rows) —
   fix the emitter, do not "fix" the caller.
6. **Background vs user split** = sum by trigger: `user` vs `scheduled` /
   `tick` / `manual`. Until attribution wiring extends beyond auth, the
   split is partial by construction — report it as partial, not as a
   percentage of the 5M.

## 6. Precise next step + follow-ups (fix slice is NOT this slice)

**Next step (in order):** (a) deploy this slice; (b) collect one full day
of instrumented totals; (c) run the §5 comparison against the
owner-supplied dashboard curves; (d) open the fix slice scoped to whatever
the comparison names — expected candidates, in no presumed order: wired
session validation cost (short-TTL caching with revocation invalidation,
no touch-and-persist on read-only calls), polling visibility gaps, hourly
options-scan gating + cross-universe dedup, audit append-only indexed
table + retention cap, token-list accumulation cleanup sized against the
100k rows-written/day cap, or a measured paid-plan decision if the
instrumented total still approaches the cap after the named cuts.

**Follow-up wiring (attribution extension, not in this slice):**
renewal cron (`renewAllStoredETradeTokens` → `scheduled`), scheduled-run
auth pre-flight (`guardScheduledAuth` → `scheduled`), `createSession` /
`deleteSession` (log-level caller labels), `listStoreEntries` /
`consumeStoreKey` direct funnel users.

**Other follow-ups:** `wrangler.jsonc:61` false-cap comment;
`#1741` gateway stats carry rate-limit bucket counts, NOT LLM token
spend — token spend remains a blind spot unless a future slice adds it
(do not claim otherwise); the bounce silent-null behavior (§3) as a
fix-candidate decision; a D1 `meta.rows_read` consumer if D1 query paths
grow; the 70%-of-cap early alert as a decided next step, not a built one.

## 7. Acceptance status against #1819

1. Top source named with numbers — PARTIAL, honestly: top *SessionStore*
   source named with numbers (wired `requireAuth`, §1/§3); the 5M-level top
   source still needs the §5 runtime comparison. Not claimed as closed.
2. False "no daily read cap" comment corrected — DONE for the three files
   this slice touches (§3); two more locations recorded as follow-ups.
3. Fix OR explicit owner decision — RECORDED, NOT PRE-DECIDED: the decision
   needed is the fix-slice scope after the §5 comparison, or a measured
   paid-vs-read-reduction decision on instrumented numbers.
4. Sign-in verified working after the fix/decision — NOT CLAIMED. A quota
   reset alone is not verification, and no fix has landed in this slice.

## Agent

#CISO-bhdm
