# Scan appendix (i) — Goal chain + AgentDB vs live routes — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. SAFETY: G02's PENDING-vs-LIVE distinction
must be preserved, not collapsed.

## G01 — goal.compile — UNPAIRED (no REST counterpart)

- `src/mcp/goalChainCommands.ts:137`: compiles a goal over the Phase 1 registry
  via the SAME `compileGoal`/`compileGoalWithMemory` the planner uses (explicitly
  no second compiler). Output is data only; unrecognized goal → `chain:null`,
  never an error. No REST compile endpoint exists.
- Slice guidance: if a REST compile endpoint is added, it must reuse the same
  compiler (already single) — the work is transport + envelope, not a second
  compiler. Under "no new stores/engines unless proven", the slice says so first
  if it adds a route.

## G02 — goal.schedule vs POST /schedules/create — DIVERGENT by design (must not be "unified" naively)

- `goal.schedule` (`goalChainCommands.ts:240`) returns a PENDING record only:
  "never goes live without human confirmation… creates no scheduled job, no
  goal-list entry, and no async job"; refuses non-pending synthesis.
- REST `POST /schedules/create` (`src/agents/routes/schedules.ts:450`) creates a
  LIVE SDK schedule, restricted to a callback allow-list
  (`creatableScheduleCallbacks`, 400 naming the list).
- These are opposite safety postures for the same word "schedule"; a unification
  must keep the PENDING-vs-LIVE distinction, not collapse it. A switch that let
  an MCP caller flip a PENDING record live without human confirmation would be a
  safety regression, not a unification.

## G03 — chain.run vs schedules/async execution — DIVERGENT

- `chain.run` (`goalChainCommands.ts:575`) re-validates the chain, executes legs
  inline via supplied executors (a failed/budget-blocked leg skips later legs),
  and NEVER creates a scheduled job (`scheduledJobCreated: false`).
- REST schedules and async jobs are persistent, retryable
  (`POST /jobs/{id}/retry`), and stage-projected (appendix (d)).
- No REST endpoint runs a compiled chain inline. The slice must not present
  inline execution as durable/scheduled execution, or vice versa.

## G04 — AgentDB tools vs REST reads — DIVERGENT (projection vs source of truth)

- `agentdb.jobs.history` (`agentDbReadCommands.ts:317`) and REST
  `GET /api/jobs/history` (`src/server.ts:1346`) share the `readJobHistory` port,
  but: REST is session-gated (`requireAuth`), tenant from IAAA resolution, 503
  when AgentDB is unbound, and goes through `handleJobHistoryRoute`; MCP resolves
  tenant from env only, no session gate in the tool, and returns the MCP-shaped
  projection. Both read the PROJECTION (may lag one transition), never DO state.
- `agentdb.audit.history` reads the AgentDB audit projection for a chain;
  `GET /audit` reads live `mas_events` (appendix (m) M10) — different sources,
  different rows for the same chain.
- `agentdb.reports.list` returns projection metadata only ("report bodies are
  never included"); `GET /reports` serves full canonical reports from the DO.
  Same word "reports", different completeness.
- `agentdb.chain.status` is UNPAIRED: no REST chain-status read exists (schedules
  list and `/api/chains/reconcile` are different operations; reconcile is a
  platform-admin operator action, not a status read).
- Slice guidance: tenant resolution is the safety-relevant delta here (IAAA
  resolution vs env-only). Any switch covering tenant sourcing must default to
  the session-gated IAAA behavior for REST-facing reads and must never let a
  caller assert a tenant the session does not hold (see main doc Security Guard:
  behavior variants configurable, enforcement not opt-out).
