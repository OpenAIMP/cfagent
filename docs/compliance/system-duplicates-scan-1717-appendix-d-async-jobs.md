# Scan appendix (d) — Async jobs systems — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path.

## J01 — Three job systems that all call themselves "jobs" — DIVERGENT

1. **Async jobs** (`mas_async_jobs`, `src/agents/orchestrator/asyncJobs.ts`):
   submit → `{jobId (uuid), status:"queued", statusUrl:"/api/jobs/{id}"}`;
   `GET /jobs` (stripped list) / `GET /jobs/{uuid}` (full record) /
   `POST /jobs/{uuid}/retry` (see M04). Capabilities include `mcp.tool`,
   `http.request`, `nlq.execute`, chain stages; 12 MB result cap; 2 h
   stale-running auto-fail.
2. **Job outcomes** (`mas_job_outcomes`, `src/services/jobOutcomes.ts`,
   `GET /autopilot/jobs` in `src/agents/routes/autopilot.ts`): outcome-event sink
   only — `{id, kind: stock|options|goal|discovery, trigger: manual|scheduled,
   status: completed|failed|partial, scanned, matched, codedError, reportUrl,
   pdf/xlsx/csv keys, deliveryStates, origin}`, upsert by stable id (deliveryId
   or run key, merge semantics), limit clamped 1–200 (default 50). It is NOT
   queryable by async jobId, has no retry, and never holds a tool result.
3. **AgentDB shard-job projection** (`agentdb.jobs.history`, appendix (i) G04):
   per-chain projected job rows from AgentDB, tenant-scoped, may lag one
   transition. Reconciled via operator-only `POST /api/jobs/reconcile`
   (platform-admin, 503 when unbound) and read via `GET /api/jobs/history` —
   note the colliding `/api/jobs/*` prefix with system 1 (history and reconcile
   are Worker-level branches that run BEFORE the DO `/jobs` handler; a client
   must not confuse `GET /api/jobs/history?chainId=` with `GET /api/jobs/{uuid}`).
- Slice guidance: these are three different things sharing a word, not three
  implementations of one thing. The slice must not merge the outcome sink or the
  projection into the async-jobs table; its work is envelope/prefix disambiguation
  and any switch covering the delivery split (J02), with each system's contract
  pinned separately.

## J02 — Sync-vs-queued delivery split (Worker + DO entry) — DIVERGENT

- Worker (`src/server.ts`): special prefixes (`/api/schedule/`, `/api/premium/`,
  `/api/payments/agentic/`, `/api/payments/webhook`, `/api/trading/options/`,
  `/api/schedules`, `/api/market|foss/quotes`, `/api/browser/*`,
  `/api/jobs/history|reconcile`) forward synchronously (session → `x-user-login`,
  no async marker). The catch-all `/api/*` forwarder marks everything NOT matching
  `^\/(clear|reset|memory|audit|chat|etrade|broker|trading|screener|options)`
  with `x-async-eligible: 1`.
- DO `onRequest` (`src/agents/orchestrator.ts:1724`): any `/api/*` (or
  async-eligible) request that is NOT `/jobs*`, NOT `/mcp*`, NOT `/schedules*`,
  and NOT an immediate prefix (same list) is QUEUED via `enqueueHttpRequest` →
  async job `capability:"http.request"`, HTTP 202 + `Location: /api/jobs/{id}` +
  `Retry-After: 1`, 8 MB body cap, only `content-type`/`accept`/`x-environment`
  headers forwarded (plus a validated `x-user-login` or the session key).
- Consequence: the SAME route handler is synchronous for `/api/etrade/*`,
  `/api/trading/*`, `/api/options/*`, `/api/screener/*` etc. but a 202-queued job
  for `/api/payments/*`, `/api/categories`, `/api/referrals`, `/api/ads`,
  `/api/knowledge/*`, `/api/autopilot/*` (except state reads that match no
  immediate prefix — verify per-route), `/api/reports/*`, `/api/research/*`,
  `/api/foss/*`, `/api/watchlists/*` when called with the `/api` prefix.
  A unification PR that only merges handler code will NOT merge this delivery split.
- MCP side: `handleMCPRequest` tools/call (`src/mcp/index.ts:386`) submits EVERY
  tool except `get_async_job`/`list_async_jobs` as an async job when `submitJob`
  is present (which the `/mcp` route always supplies). So over `/mcp`,
  `execute_nlq`, `manage_categories`, etc. return a job receipt, not a result —
  while the same commands executed via REST bridges (appendix (h) M02, appendix
  (a) M08, appendix (c) M09, appendix (m) M10) run synchronously. The async-job
  tools are the exception that proves the rule.
- Slice guidance: per-route sync-vs-queued status for every `/api/*` spelling was
  NOT verified individually in the scan — J02 gives the rule; the slice applies it
  per route at build time and does not assume. Any switch covering delivery mode
  defaults to the current per-prefix behavior, recorded per route.

## M04 — get_async_job / list_async_jobs vs GET /jobs — DIVERGENT-minor

- MCP commands (`src/mcp/commands.ts:531,549`) read `mas_async_jobs` via
  `context.getJob`/`listJobs` (session-scoped, 2 h stale-`running` → auto-`failed`
  rewrite in `src/agents/orchestrator/asyncJobs.ts:318,367`).
  `get_async_job` zod-validates `jobId` as UUID; missing job throws
  `"Async job not found."`; list takes no limit argument.
- REST `GET /jobs` and `GET /jobs/{uuid}` (`src/agents/orchestrator.ts`
  `onRequest`, NOT in `routes/`): list strips `result` and returns `{jobs}`
  (NO `count`), limit query param default 50 (clamped 1–100 by `listAsyncJobs`);
  single returns the FULL record including `result`, 404 `"Async job not found."`.
  MCP list returns `{count, jobs}` (also result-stripped by the `/mcp` route
  context). Same table, three envelopes.
- Both are EXEMPT from the MCP async-job wrapping (J02) — the only two tools
  that execute synchronously over `/mcp`.
- Extra REST-only surface with no MCP pair: `POST /jobs/{uuid}/retry`
  (failed-only, 404/409/500 mapping, duplicate-retry refusal).

## S5 — Research vs screener task ledgers — IDENTICAL (pattern)

- `src/services/researchTaskLedger.ts` (#577, ResearchAgent) vs
  `src/services/screenerTaskLedger.ts` (#607, ScreenerAgent, explicitly "the
  screener mirror of researchTaskLedger"): same lifecycle semantics — create +
  begin, heartbeat, deterministic outcome evaluation, total failure → ESCALATED
  for human review, stale-task closing (both agents expose the #615 R4 stale
  sweep). Stores differ (`research_task_store` vs `screener:task:`/`screener:idem:`
  keys, DO-owned ledgers) and the owning agents differ (options research vs stock
  screening) — the duplication is structural (a copied ledger pattern), not a
  second implementation of the same run. Unification here would be a refactor
  choice, not a correctness fix; the slice must say so first if it pursues it.
