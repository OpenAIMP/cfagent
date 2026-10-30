# Agents SDK Conformance Matrix (G7)

Status: v1 (2026-10-29, #CAIO-quns) — Agent Mesh programme
(OpenAIMP/cfagent#2225), goal G7 round 1, landed via #2339.
Companion references: the S1 fleet registry (`src/agents/registry.ts`,
#2322), the mesh survey (§2, the evidence base at base `a71fca57`),
the owner's Agents SDK reference set (#2225 comment 6491152513 — the
yardstick this matrix is judged against), `doors-and-layers.md` in
this folder, and the pin suite
(`tests/mesh_conformance_s4_2339.test.ts`).

This document classifies every agent in the fleet against the Agents
SDK, per agent × per aspect, with **zero unclassified cells**. The
classification also lives as data in the pin suite; the suite fails
if this document and the data disagree, if the registry gains an
agent with no row here, or if a code fact a round-1 classification
rests on changes. Prose elsewhere (including the survey) loses to
this matrix on conformance questions; the matrix loses to the code,
and the pins exist to say so loudly when that happens.

## 1. How to read this matrix

**States.** Every cell is exactly one of:

- **IMPLEMENTED** — the capability is present, with the evidence
  basis named in the cell (a file/line fact or an existing pin
  suite). Where the mechanism deliberately diverges from the SDK
  surface the reference set names, the cell still reads IMPLEMENTED
  and the divergence is stated in the cell — a deliberate divergence
  is classified explicitly, never left unclassified and never
  silently passed off as the SDK mechanism (the reference set's
  rule for the `runWorkflow()` tracking cell, applied fleet-wide).
- **NOT-APPLICABLE** — the aspect does not apply to this agent, with
  the reason in the cell. N/A is a classification, not an omission.
- **GAP** — the capability is absent or unproven, with the
  programme slice that owns closing it named in the cell and in the
  GAP register (§4). Where no slice exists yet, the owner is
  recorded as the programme backlog — an honest unowned gap, not a
  hidden one.

**Aspects.** G7's two sets. Runtime aspects: `identity` (durable
identity — a durable, explicit acting identity: instance naming plus
identity source, no synthetic fallback), `state` (durable state
persistence), `connections` (connection-oriented surfaces —
WebSocket or protocol sessions — terminating on the instance; plain
DO stub RPC is recorded under `routing`, not here), `scheduling`
(scheduled work the agent owns, by whatever mechanism), `recovery`
(eviction/resume behavior). Agent-class aspects: `sdk-state` (the
SDK State API — `setState`/`this.state`), `sessions` (the agent
session store: the port's flat ActorSessionStore and, for
turn-capable agents, Think's tree session), `routing` (bindings,
names, and doors by which the class is reached), `websockets` (the
Agent WebSocket lifecycle), `sdk-scheduling` (the SDK scheduler —
`this.schedule`/`this.scheduleEvery`), `fibers` (durable execution
via the SDK/Think fiber primitive — `runFiber`/`startFiber`/`stash`).

**Roster.** Exactly the S1 registry roster, in registry order: the
12 PortThink agents, plus SessionStore (a plain Durable Object) and
OptionsScannerMCP (an McpAgent) — the two non-Agent entries are
classified too, with the Agent-class aspects marked NOT-APPLICABLE
where the aspect is defined only for Agent subclasses. The roster
has already outgrown the survey: AiSearchAgent (#2223), TickerAgent
(#2230), and SandboxAgent (#2253) landed after the survey base, and
S3 (#2327) changed the identity facts for ResearchAgent,
OrchestratorAgent, and PaymentsAgent after it. Cells state
current-main facts, not survey facts; §7 lists the corrections.

**What the pins prove.** Round-1 pins cover the `identity`, `state`,
`routing`, and `sessions` aspects, plus fleet facts underpinning the
other aspects (lifecycle-hook census, scheduler-call census, fiber
primitive absence). The pins are *static source evidence*: they prove
a guard exists, a fallback literal is present or absent, a hook or
binding is wired. They are not runtime proof. Where a behavioral
suite already pins runtime behavior — S3's identity suite for the
research/orchestrator/payments identity cells — the matrix cites
that suite and the pin here protects the citation. Eviction/resume
*behavior* is proven nowhere in the fleet today; that is why the
recovery column reads as it does.

## 2. Deliberate divergences (classified, fleet-wide)

- **SDK State API (`sdk-state`).** No agent uses `setState`. Durable
  state is held through the actor port's state facet
  (`createCfActorState` over `ctx.storage`,
  `src/actors/cfAgentsAdapter.ts:29-40`) and `ctx.storage` directly.
  This is the fleet's settled posture (ADR 0005's port discipline),
  classified IMPLEMENTED for stateful PortThink agents with the
  divergence named, and pinned: a `this.setState` appearing in any
  agent source fails the suite until the cell is re-classified.
- **Workflow run tracking.** `runWorkflow()` auto-tracks runs in the
  agent's own database; this repo deliberately tracks workflow runs
  in D1 projection rows + instance status instead (ADR 0003 M10).
  Workflows are not matrix rows (the registry records them
  separately); the divergence is recorded here because the reference
  set names it as a G7 classification, and G6's pins (S12) judge the
  D1-tracked posture on its own evidence.
- **Dual session stores.** For turn-capable agents, Think's tree
  session (branching/compaction/FTS) and the port's flat
  ActorSessionStore are separate stores in the same DO, and a turn
  writes to both (`src/actors/thinkAdapter.ts:69-75`). Sessions
  cells classify the pair, not either store alone.

## 3. Summary counts

| Aspect | IMPLEMENTED | NOT-APPLICABLE | GAP |
|---|---|---|---|
| `identity` | 11 | 2 | 1 |
| `state` | 10 | 4 | 0 |
| `connections` | 3 | 11 | 0 |
| `scheduling` | 3 | 11 | 0 |
| `recovery` | 0 | 9 | 5 |
| `sdk-state` | 7 | 7 | 0 |
| `sessions` | 3 | 10 | 1 |
| `routing` | 14 | 0 | 0 |
| `websockets` | 2 | 12 | 0 |
| `sdk-scheduling` | 2 | 12 | 0 |
| `fibers` | 0 | 2 | 12 |
| Total | 55 | 80 | 19 |

154 cells (14 roster entries × 11 aspects), zero unclassified. The
two honest headlines: **recovery has no IMPLEMENTED cell** — no agent
has an eviction/resume conformance pin yet (S12 owns the proof) —
and **fibers is a GAP for every PortThink agent**, judged against the
real SDK primitive.

## 4. GAP register

| Agent | Aspect | Owning slice |
|---|---|---|
| OrchestratorAgent | `recovery` | S12 (G6 conformance) |
| ResearchAgent | `recovery` | S12 (G6 conformance) |
| TradingAgent | `recovery` | S12 (G6 conformance) |
| TradingAgent | `sessions` | Programme backlog (re-dispositioned by #2375 — S9 landed the door caller, not a turn) |
| ScreenerAgent | `recovery` | S12 (G6 conformance) |
| SlackAgent | `identity` | S16 (G14 identity records + mesh credentials) |
| SlackAgent | `recovery` | S13 (G10 channel completeness — first instantiation) |
| All 12 PortThink agents | `fibers` | Programme backlog (no slice yet) |

Residuals recorded inside IMPLEMENTED cells (not GAPs, but tracked):
OrchestratorAgent's `sessionKey()` attribution (S16);
ScreenerAgent's two `tenantId: "default"` report-path literals (S16);
ScheduledAgent's `actor: "system"` audit literal (S16);
AiSearchAgent's unthreaded session login for turn-tool/RPC callers
(#2246 follow-up).

## 5. Per-agent matrix

### OrchestratorAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Per-login instances: server.ts resolves SEARCH_AGENT.idFromName(userLogin) (src/server.ts:364). Fixed names (default_trader, system_webhook_receiver) are addresses, never identities (src/security/serviceIdentity.ts:52-61); unattended work acts under getServiceUserLogin (serviceIdentity.ts:45), fail-closed when unconfigured. S3 (#2327) retired the research-stub default; behavioral pins in tests/mesh_identity_sweep_s3_2327.test.ts. Residual: mas_* rows still attribute via sessionKey() (the opaque DO id string, orchestrator.ts:464+) — an address-shaped value doing attribution duty; two-part (agent + principal) attribution is S16's work. |
| `state` | IMPLEMENTED | Instance-local durable state: ctx.storage KV plus the SQLite mas_* tables (mas_messages/mas_events/mas_memory/mas_transactions) in the instance's own storage. |
| `connections` | IMPLEMENTED | The fleet's chat surface: routeAgentRequest (src/server.ts:488) with session gates, reached by the client's useAgent; the class also serves DO fetch forwards (its onRequest and mounted routes). |
| `scheduling` | IMPLEMENTED | Heavy self-scheduling for per-login machinery: the port schedule facets delegate to this.schedule/this.scheduleEvery (orchestrator.ts:448-495), ScheduledTasksService runs on the instance, and worker-cron forwards (research tick, sweeps) land here. |
| `recovery` | GAP | onStart (:703) runs real recovery mechanisms — queued async-job recovery, legacy schedule reconciliation, stale-task sweep arming — wired and pinned as source facts by tests/orchestrator_class_inventory.test.ts, but no eviction/resume conformance pin exists for any agent; S12 owns the proof. Owner: S12 (G6 workflow + agent conformance). |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | IMPLEMENTED | Dual store (src/actors/thinkAdapter.ts:69-75): the port's flat ActorSessionStore transcript and Think's tree session are separate stores in the same DO, and a turn writes to both; mas_messages is the durable SQL message log on top. |
| `routing` | IMPLEMENTED | Bindings SEARCH_AGENT + ORCHESTRATOR_AGENT (registry-pinned against wrangler.jsonc); routeAgentRequest name search-agent (the class rename is S2, owner-sequenced behind #2326); A2A surfaces orchestrator/search/tasks/memory plus dispatch-only nlq (registry MESH_SURFACES). |
| `websockets` | IMPLEMENTED | The SDK base WebSocket lifecycle behind routeAgentRequest, with onBeforeConnect/onBeforeRequest session gates in server.ts; the class defines no onConnect override (fleet pin) — the SDK's hibernation-aware handling is the conformance posture. |
| `sdk-scheduling` | IMPLEMENTED | this.schedule / this.scheduleEvery through the port schedule facets (orchestrator.ts:448-495). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### ResearchAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Identity arrives per request (ResearchRunRequest.userLogin). Post-S3, explicitResearchLogin (research-agent.ts:89) refuses a missing, blank, or retired-literal login in runResearch (:496) and runDiscovery (:594); evaluateRun/refreshIdeaQuotes resolve from the caller or the run record's recorded owner and decline when neither exists. Behavioral pins: tests/mesh_identity_sweep_s3_2327.test.ts. |
| `state` | IMPLEMENTED | Instance-local: ctx.storage KV (research:latest, research:history) plus SQLite via ctx.storage.sql; report PDFs via the report blob store. |
| `connections` | NOT-APPLICABLE | No connection surface terminates on this class: no client connects and it defines no onConnect. Work arrives by DO stub RPC and agent-as-a-tool dispatch, recorded under routing. |
| `scheduling` | NOT-APPLICABLE | No scheduling role of its own: its daily run is fired by the worker cron through the orchestrator's scheduled-tick route (identity-gated post-S3), and the file contains no schedule calls. |
| `recovery` | GAP | No onStart; reads are read-through from storage (getLatest returns null honestly), so eviction loses nothing durable — but an interrupted run leaves no resumable record and no eviction/resume pin exists. Owner: S12 (G6 workflow + agent conformance). |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | IMPLEMENTED | Turn-capable: portHooks are set in the constructor (:194) as identity pass-throughs of its own getModel/getSystemPrompt/getTools. Turns are driven remotely by the orchestrator (runAgentTool dispatch); the transcript lives in its own instance's port session store. Non-chat: no user-facing session continuity. |
| `routing` | IMPLEMENTED | Binding RESEARCH_AGENT; stub callers are the orchestrator and server.ts; A2A surface research (registry). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### TradingAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Name-derived acting identity: instanceUserLogin() (trading-agent.ts:1042) inverts tradingAgentName (:1254); the workflow door refuses a payload without userLogin (trading-trade-workflow.ts) and decideTradeApproval requires an authorizer DID. The fleet's fail-closed precedent (#1185/#291) that G8/G14 generalize from. |
| `state` | IMPLEMENTED | ctx.storage KV facade plus SQLite ORM over ctx.storage.sql in-instance; config resolved per call from env. |
| `connections` | NOT-APPLICABLE | No client connects and no connection surface exists; reachable via A2A dispatch and via stub RPC — since #2349 the orchestrator's chat turn is a production stub caller through the G1 door (proposals + reads, src/agents/orchestrator/meshDoors.ts), and since #2375 also through the approval door's workflow operations (start/decide). |
| `scheduling` | NOT-APPLICABLE | None in the agent: its durable timing lives in TradingTradeWorkflow's 24h waitForEvent, not in any schedule of its own. |
| `recovery` | GAP | No onStart; drafts/proposals are storage-backed and re-validated at settle time by the shared core, so the wait survives in the workflow — but no eviction/resume pin covers the agent. Owner: S12 (G6 workflow + agent conformance). |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | GAP | The mechanism is wired: portHooks are set lazily via tradingTurnHooks(). #2375 (S9/G4) made the chat turn the first production caller of this class's door surface — proposal → approval-workflow start → decision → settle — but that path is typed RPC from the orchestrator's turn and drives no turn ON this class, so no transcript has ever accumulated and claiming IMPLEMENTED would overclaim; NOT-APPLICABLE is barred because the hooks are set (the portHooks coherence pin). Re-dispositioned by #2375: the GAP stays; conversion needs a slice that drives a real turn on this class. |
| `routing` | IMPLEMENTED | Binding TRADING_AGENT; A2A surface trading — handleA2A at :1236 dispatching to dispatchTradingA2A, pinned by tests/trading_agent.test.ts. The orchestrator's G1 chat door (#2349, src/agents/orchestrator/meshDoors.ts) is the first production stub caller: proposals and reads, addressed per-user via tradingAgentName. Since #2375 (S9/G4) the door also carries the approval door's workflow operations — startTradeApproval starts TradingTradeWorkflow, decideTradeApproval delivers the decision with the authorizer derived server-side — while executeApprovedOrder stays workflow-called only (the settle step), never door-called. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### PaymentsAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Callers must name themselves: budgetCheck requires an explicit agentId and fails closed without one (payments-agent.ts, post-S3 — "budget check requires an explicit agentId"); processPaidRequest likewise requires agentId. Recorded spend carries two-part attribution in the ledger (payments-agent:<agentId>). Behavioral pins: tests/mesh_identity_sweep_s3_2327.test.ts. |
| `state` | IMPLEMENTED | Derived-state posture: live state is computed per call from the orchestrator-owned payments ledger (mas_transactions via src/payments/ledger.ts). Its own ctx.storage holds only the retired legacy blob (payments/budgetGuard keys), read solely by migrateLegacyLedger. |
| `connections` | NOT-APPLICABLE | RPC-only actor: portHooks deliberately unset, no turn, no WebSocket surface in practice. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Nothing instance-local to recover: every read derives from the ledger of record, so eviction is a non-event; the legacy migration is explicit and idempotent, never auto-invoked. |
| `sdk-state` | NOT-APPLICABLE | No agent-managed state through either API: live state is ledger-derived, and the only ctx.storage content is the retired legacy blob. |
| `sessions` | NOT-APPLICABLE | None by design: portHooks deliberately unset (class header), no transcript exists. |
| `routing` | IMPLEMENTED | Binding PAYMENTS_AGENT; production stub callers are ScheduledAgent, the orchestrator budget paths, and the G1 chat door (#2341: budgetCheck + the read side via src/agents/orchestrator/meshDoors.ts); A2A surface payments (registry). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### ScreenerAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Recorded-owner identity: userLogin() returns the owner recorded at first run (OWNER_STORAGE_KEY, screener-agent.ts:407-436), else the login in a screener:-prefixed instance name, else the service identity for instance "default" only — otherwise it throws ("ScreenerAgent has no owner identity recorded for this instance"). Name resolution also fails closed (src/agents/screenerAgentName.ts:28-38). Residual: two goal-screen report paths still stamp a literal tenantId: "default" (screener-agent.ts:1314, :1336 — count pinned). That is a tenant-attribution default, not an acting-identity default; S16 retires it. |
| `state` | IMPLEMENTED | Instance-local ctx.storage plus SQLite: the task ledger, run history, latest results, and provider config tables. |
| `connections` | NOT-APPLICABLE | RPC-only in practice; no client, no connection surface. |
| `scheduling` | NOT-APPLICABLE | None of its own; fired by the orchestrator, server routes, ScheduledAgent goal chains, and workflow shards. |
| `recovery` | GAP | Runs are recorded in its task ledger and a concurrent-run lock reports the first run's age — an honest in-progress state, not a resume; no eviction/resume pin exists. Owner: S12 (G6 workflow + agent conformance). |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | NOT-APPLICABLE | portHooks unset; no turn path, no transcript. |
| `routing` | IMPLEMENTED | Binding SCREENER_AGENT; A2A surface screener (registry); stub callers: orchestrator, the screener workflow's shard runner, server routes. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### ScheduledAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Singleton instance "default"; goals carry their owner login in the goal records and fired work acts as the goal owner. Post-S3 its budget checks name the spend bucket explicitly (AGENTIC_SPEND_AGENT_ID, scheduled-agent.ts:329 and the synthesized-schedule path). Residual: synthesized-schedule audit rows still carry the literal actor "system" (scheduled-agent.ts:937 — pinned); S16 retires it. |
| `state` | IMPLEMENTED | All instance-local ctx.storage: the goals key (seeded with DEFAULT_SCHEDULES on first read, :224-225), tick history, and synthesized schedules. |
| `connections` | NOT-APPLICABLE | No turn path and no port hooks by design (class header); reachable via stub RPC from server.ts and, since #2341, from the orchestrator's chat turn through the G1 door (src/agents/orchestrator/meshDoors.ts). |
| `scheduling` | IMPLEMENTED | It IS the user-visible goal catalogue (survey §4 ruling): the worker cron calls server.ts scheduled(), which invokes onCron() on the singleton; each due goal is budget-gated through PaymentsAgent before firing. The mechanism is the worker cron, deliberately not the SDK scheduler. |
| `recovery` | NOT-APPLICABLE | No in-flight work to resume: each tick re-reads durable goal state from ctx.storage, and fired work is tracked as jobs/chains by the orchestrator. The virgin-instance seeding hazard is an addressing hazard, recorded under routing. |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | NOT-APPLICABLE | None by design; it holds goal state, not conversations. |
| `routing` | IMPLEMENTED | Binding SCHEDULED_AGENT; singleton ('default') addressing from server.ts and the orchestrator's G1 chat door (#2341); A2A surface scheduled (registry), whose resolution pins the "default" instance — dispatch to any other instance name would seed pristine default goals. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | Deliberately never the SDK scheduler (class header: driven by onCron(), "never via the SDK scheduler"); the scheduling it owns is recorded under runtime scheduling. |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### ReportAssetAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Identity is carried in the request (AssetRequest.userLogin), never derived from the instance name; the name helper maps the service identity to instance "default" and users to assets:<login> (reportAssetAgentName). Caller-asserted within capability RPC — attribution is exactly as trustworthy as the caller (survey §2.7). |
| `state` | IMPLEMENTED | Asset bytes via reportBlobStore (imported at report-asset-agent.ts:26): R2 (REPORTS_BUCKET) when bound, DO storage otherwise. |
| `connections` | NOT-APPLICABLE | RPC-only; no hooks, no client, no connection surface. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Assets live in R2/DO storage outside instance memory and reads are per-call, so eviction loses nothing; generateAsset returns null on failure instead of throwing, and callers translate that into an honest error. |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | NOT-APPLICABLE | No sessions: an RPC-only asset store with no turn path, so no transcript exists. |
| `routing` | IMPLEMENTED | Binding REPORT_ASSET_AGENT; A2A surface report-asset (registry — the survey-era hyphen concern is resolved on current main); stub callers: ScreenerAgent, the report pipeline helpers, and the orchestrator's G1 chat door (#2349: list/get via src/agents/orchestrator/meshDoors.ts, per-user assets:<login> addressing). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### BrowserAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | NOT-APPLICABLE | Stateless: every method delegates to ETradeBrowserService built from env only; any instance name behaves identically and the class acts as nobody — there is no acting identity to make durable. |
| `state` | NOT-APPLICABLE | No state: zero ctx.storage use anywhere in the class (pinned). |
| `connections` | NOT-APPLICABLE | No production connection terminates on the class: production use is in-process construction borrowing the caller's ctx (src/agents/routes/tradingIntegrations.ts); its onRequest (:133) is exercised only that way. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless by construction (zero ctx.storage use in the class), so an eviction has nothing to recover. |
| `sdk-state` | NOT-APPLICABLE | No agent state to manage through any API. |
| `sessions` | NOT-APPLICABLE | portHooks deliberately unset (class header): no chat behavior was ever configured, so no session store is exercised. |
| `routing` | IMPLEMENTED | Binding BROWSER_AGENT; A2A surface browser (dispatch module src/agents/browserA2aDispatch.ts); production reachability is the in-process construction recorded under connections, and since #2351 the orchestrator's G1 chat door (src/agents/orchestrator/meshDoors.ts) is a production stub caller addressed to the fixed instance "browser": snap/capture/scrape with results verbatim. The survey §2.8 webhookUrl call is decided in #2351: the door never accepts or forwards a caller-supplied webhookUrl — delivery targets are env configuration only, the #2223 A2A precedent. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### SlackAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | GAP | sessionKey() falls back to the synthetic literal "slack_agent_master" when ctx.id is absent (slackAgent.ts:65-66, repeated at :74 — presence pinned). In a real DO instantiation ctx.id always exists, so the fallback fires only in in-process/test construction, but it is exactly the synthetic-identity shape G14 retires; S16 removing it must update this cell. Owner: S16 (G14 identity records + mesh credentials). |
| `state` | IMPLEMENTED | SQLite via getOrm() over this.ctx.storage.sql (slackAgent.ts:89-90). Caveat: exercised only if the class is ever instantiated as a DO — in production it never has been (see connections). |
| `connections` | NOT-APPLICABLE | Its own signature-gated onRequest ingress (:143) is a parallel implementation nothing calls; production Slack ingress terminates on OrchestratorAgent instances named slack_<teamId> via server.ts forwarders (registry channel posture MIXED). |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | GAP | Never instantiated in production, so its boot/ORM paths are unproven; S13's ingress work is the first instantiation and owns exercising and pinning its recovery behavior. Owner: S13 (G10 channel completeness). |
| `sdk-state` | IMPLEMENTED | State goes through ctx.storage.sql directly (getOrm, slackAgent.ts:89-90) — the same ctx.storage posture as the fleet; the SDK setState API is unused (fleet pin). |
| `sessions` | NOT-APPLICABLE | No chat transcript; its sessionKey-keyed service state is not an agent session store. |
| `routing` | IMPLEMENTED | Binding SLACK_AGENT exists (migration v10, #2215 — the class header's no-binding claim is stale, survey §6.4); A2A surface slack (registry); production stub callers: the A2A dispatcher (#2223) and, since #2351, the orchestrator's G1 chat door (src/agents/orchestrator/meshDoors.ts) addressed to the fixed instance "slack", serving only the two outbound helpers (approval ticket + transaction snap). Production ingress still bypasses the class (see connections), which S13 owns. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### AiSearchAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | The agent fronts a shared search instance and holds no identity of its own; the identity discipline lives in the runner: report-type results are served only to their owner's login and are withheld when the search carries no login or a mismatched one (src/agents/aiSearchPaths.ts, the #2246 report login discipline). Residual: session login is not yet threaded into the turn-tool/RPC callers (aiSearchPaths.ts:168-172), so those callers get report results withheld — fail-safe, with the threading follow-up recorded under #2246. |
| `state` | NOT-APPLICABLE | No ctx.storage use in the class (pinned); the three-path runner (namespace binding, instance MCP, REST) is stateless per call over env configuration. |
| `connections` | NOT-APPLICABLE | No connection terminates on the class; its MCP path is outbound consumption of the instance's endpoint via RemoteMcpClient, a client relationship recorded under routing. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless per call over env configuration, so an eviction has nothing to recover. |
| `sdk-state` | NOT-APPLICABLE | No agent state to manage through any API. |
| `sessions` | IMPLEMENTED | Turn-capable: portHooks are set in the constructor (aiSearchAgent.ts:86-99) mirroring ResearchAgent's — the namespace search is a model turn tool as well as a direct method (the agents/tools/ai-search pattern from the reference set), exposed through the MCP door as ai_search_agent_search (#2250). |
| `routing` | IMPLEMENTED | Binding AI_SEARCH_AGENT (migration v12, #2223); A2A surface aisearch (registry). The ai_search_namespaces binding is dashboard-issued and not declared in wrangler.jsonc, so the primary path is config-gated and the agent degrades honestly to its MCP and REST paths (registry note). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### TickerAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | A single shared instance, "ticker" (TICKER_INSTANCE_NAME, ticker-agent.ts:83), addressed directly by server.ts (idFromName(TICKER_INSTANCE_NAME), src/server.ts:3113). No per-user identity by design: the tape is public, with no auth and no audit (the #2230 posture recorded in the class header). |
| `state` | NOT-APPLICABLE | No durable agent state: subscriptions live in per-connection state and quotes in an in-memory cache refreshed on demand; zero ctx.storage use in the class (pinned). |
| `connections` | IMPLEMENTED | The public quotes WebSocket (/api/market/quotes/ws plus aliases): server.ts forwards the upgrade request to the shared instance's stub, which drives onConnect. Deliberately NOT routeAgentRequest — its onBeforeConnect would 401 the public tape (class header; src/server.ts:3107-3113). |
| `scheduling` | IMPLEMENTED | The tick cadence is a durable SDK schedule installed by onStart: scheduleEvery(TICKER_PUSH_INTERVAL_SECONDS, "pushTicks") (ticker-agent.ts:86-90), idempotent across wakes. |
| `recovery` | NOT-APPLICABLE | Nothing durable to recover: the tick schedule is re-installed idempotently on every wake, per-connection state is restored by the SDK across hibernation, and the quote cache is refresh-on-demand. |
| `sdk-state` | NOT-APPLICABLE | The Agent state API is unused. The Connection.setState calls (ticker-agent.ts:101+) are per-connection state — the SDK's connection-state mechanism, recorded under websockets — not agent state. |
| `sessions` | NOT-APPLICABLE | portHooks never set and no turn ever runs (class header); there is no transcript. |
| `routing` | IMPLEMENTED | Binding TICKER_AGENT (migration v11, #2230); direct stub addressing from server.ts; not routed through routeAgentRequest and no A2A surface (registry) — both deliberate, recorded in the class header. |
| `websockets` | IMPLEMENTED | The fleet's one real WebSocket lifecycle implementation: onConnect (:96) reads header carriers into per-connection state, onMessage (:122) handles subscribe/unsubscribe/ping, onClose is inherited; protocol messages are disabled (shouldSendProtocolMessages returns false) because clients are plain WebSockets, not useAgent clients. |
| `sdk-scheduling` | IMPLEMENTED | this.scheduleEvery in onStart (ticker-agent.ts:89). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### SandboxAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | NOT-APPLICABLE | No acting identity: the class delegates to ETradeSandboxService constructed from env only, and adds no identity of its own. |
| `state` | NOT-APPLICABLE | No ctx.storage use in the class (pinned); the service is constructed with no container backend and holds no per-instance durable state. |
| `connections` | NOT-APPLICABLE | Its doors are the domain methods plus the onRequest surface (:123); production call-site wiring through the agent is a recorded follow-up — the MCP run_sandbox_command still constructs the service directly (class header). |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless; run results are honest non-executions (executed:false, #121) until an owner binds a container backend — there is no in-flight work to resume. |
| `sdk-state` | NOT-APPLICABLE | No agent state to manage through any API. |
| `sessions` | NOT-APPLICABLE | portHooks deliberately unset and no chat behavior defined (class header); no session store is exercised. |
| `routing` | IMPLEMENTED | Binding SANDBOX_AGENT (migration v13, #2253); the onRequest surface mirrors BrowserAgent. No A2A surface — a recorded follow-up in the registry notes, not part of this slice. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |

### SessionStore

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | This class is the fleet's identity substrate: the store holding app sessions and E*TRADE tokens (etrade:token:<env>:<login>) that every agent's identity story ultimately rests on (survey §2.11). |
| `state` | IMPLEMENTED | A kv_store SQLite table (ns/key/value/expires_at) created in its constructor over ctx.storage.sql (sessionStore.ts:134+). |
| `connections` | NOT-APPLICABLE | A fetch op protocol only; no connection surface. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Not an agent: per-call fetch operations over durable SQLite storage; no in-flight work to resume. |
| `sdk-state` | NOT-APPLICABLE | Not an Agents SDK Agent subclass (extends plain DurableObject); the Agent-class State aspect does not apply. |
| `sessions` | NOT-APPLICABLE | It stores the fleet's sessions; it holds none of its own. |
| `routing` | IMPLEMENTED | Binding SESSION_STORE (migration v6); reached by internal stub fetch only. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface: its only door is the fetch op protocol. |
| `sdk-scheduling` | NOT-APPLICABLE | Not an Agents SDK Agent, so the SDK scheduler aspect does not apply. |
| `fibers` | NOT-APPLICABLE | Not an Agent class; the Fibers aspect does not apply. |

### OptionsScannerMCP

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | The caller's x402 payer wallet, verified by the facilitator — the fleet's only externally credentialed surface (survey §2.10). No DID, no service-identity use; attribution is the payment receipt. |
| `state` | IMPLEMENTED | McpAgent protocol session state over ctx.storage; the one paid tool (screen_options) is stateless per call, executing in-process. |
| `connections` | IMPLEMENTED | MCP over HTTP/WebSocket via McpAgent.serve, addressed by an affinity id at /mcp/scanner (src/server.ts:2808-2814). |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless calls; protocol sessions belong to the MCP layer. |
| `sdk-state` | NOT-APPLICABLE | An McpAgent, not an Agents SDK Agent; the SDK State aspect does not apply. |
| `sessions` | NOT-APPLICABLE | Its sessions are MCP protocol sessions (recorded under connections and state), not the Agent-class session store. |
| `routing` | IMPLEMENTED | Binding OPTIONS_SCANNER_MCP (migration v2), served at /mcp/scanner. Registered for completeness; out of mesh scope per #2225 (G3 leaves this class untouched). |
| `websockets` | NOT-APPLICABLE | MCP transport, not the Agent WebSocket lifecycle. |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: this surface has no scheduler role. |
| `fibers` | NOT-APPLICABLE | Not an Agent class; the Fibers aspect does not apply. |

## 6. Coverage: what round 1 pins, and what later rounds add

Round 1 (this document + `tests/mesh_conformance_s4_2339.test.ts`)
pins the classification itself (roster, doc agreement) and the code
facts under the `identity`, `state`, `routing`, and `sessions`
aspects, plus the fleet censuses (lifecycle hooks, scheduler calls,
fiber primitives, `this.setState`) that the remaining aspects rest
on. Later rounds should add, in owning-slice order:

- Behavioral eviction/resume pins per agent and workflow — S12,
  converting the recovery GAPs one by one.
- A first-turn proof for TradingAgent — re-dispositioned by #2375:
  S9 landed the first production door caller (chat trade via the
  approval door + TradingTradeWorkflow) but drives no turn on the
  class, so its sessions GAP stays in the programme backlog until a
  slice drives a real turn on it.
- SlackAgent's identity fix and first instantiation — S16/S13,
  converting its two GAPs.
- A fibers adoption decision (SDK primitive behind the actor port,
  or an explicit programme decision to keep the GAP) — currently
  unowned in the backlog; the matrix keeps it visible until a slice
  claims it.

## 7. Corrections to the survey §2 (recorded so the survey is not cited stale)

- The fleet is 14 registry entries, not the survey's 11 sections:
  AiSearchAgent, TickerAgent, and SandboxAgent landed after the
  survey base (S1, #2322).
- "Zero `onConnect` in `src/`" and "only OrchestratorAgent defines
  `onStart`" were true at the survey base and are false now:
  TickerAgent defines `onStart`, `onConnect`, and `onMessage`
  overrides and uses per-connection `Connection.setState` (the
  connection-state mechanism — not the Agent state API, which
  remains unused fleet-wide).
- A2A dispatch, which the survey recorded as failing for every name
  but trading, is built out (#2223): 13 cards and 14 resolutions,
  with per-agent dispatch modules; the registry pins the current
  shape and the routing cells state it.
- The Browser Rendering binding, absent at the survey base, is
  declared in wrangler.jsonc now (#2253); BrowserAgent's cells are
  unchanged because its production path is still in-process
  construction.
- `durableFibers` moved from `src/agents/` to
  `src/services/durableFibers.ts`; its durability posture is
  unchanged (checkpoints written, never read).
- MAS tools are `createMAS` in `src/agents/mas.ts` (the survey's
  `masTools.ts` references are stale); this does not change any cell.
- Identity facts for ResearchAgent, OrchestratorAgent, and
  PaymentsAgent are post-S3 (#2327): the `"default"` fallback family
  the survey catalogued on those paths is retired and fail-closed,
  and ScheduledAgent's budget calls now name their bucket
  explicitly. The remaining family members the survey found —
  SlackAgent's `slack_agent_master`, ScreenerAgent's `tenantId`
  literals, ScheduledAgent's `actor: "system"`, the DID `"anonymous"`
  derivations, the NLQ webhook's synthetic login — are recorded in
  this matrix as GAPs or residuals with their owning slices (S13,
  S16), not silently dropped.
