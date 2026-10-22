# cfpay — reference agent implementation

> Stored from the issue #291 (TradingAgent) alignment study, 2026-10-22, #CTO-mbshr lane.
> Source: OpenAIMP/cfpay (read-only study; no cfpay code was modified). This document is the
> evidence base for the TradingAgent × cfpay alignment slices A1–A7 recorded on issue #291.

## cfpay → cfagent TradingAgent alignment report

**Scope.** Study of OpenAIMP/cfpay as the reference implementation for OpenAIMP/cfagent
issue #291's TradingAgent (design posted on issue #291; T1: `src/agents/trading-agent.ts`
+ `src/config/tradingAgentConfig.ts`, PR #1082).
No code was modified in either repo. Line citations are `file:line` in the respective repo.

**Headline.** cfpay's fleet pattern is considerably more specific than cfagent's current
A2A port suggests. The ported pieces in cfagent (`src/orchestrate.ts`,
`src/services/cfpayA2A.ts`) carry cfpay's *client-side* conventions and a simplified
catalog, but cfpay's *server-side* agent pattern — `@callable() handleA2A(body, origin)`
returning a collected SDK outcome, a spec-shaped card generated from an SDK-free ops
table, `{text, data}` capability results with stable error tokens, an authenticated
edge, and ThinkWorkflows for HITL trades — was not ported. T1 aligns on the big shape
(Think base, one execution path, registry-generated surfaces) and diverges on most of
the wire-level details. Two divergences are internal inconsistencies in T1 itself
(instance naming, dispatcher signature) and should be fixed before T2 regardless of
how much of cfpay's heavier machinery (tenancy/FGA/aspects) cfagent chooses to adopt.

---

## (a) cfpay pattern summary

### 1. Agent base pattern

- Every agent extends **`Think<Env>`** (host: `Think<Env, AgentState>`) from
  `@cloudflare/think` — host `CfmailAgentSQLite` (`src/agent.ts:221`), PaymentsAgent
  (`src/payments-agent.ts:101`), SearchAgent (`src/search-agent.ts:38`),
  OrchestratorAgent (`src/orchestrator-agent.ts:77`). No agent extends raw `Agent` or
  `DurableObject`.
- Think surface is three overrides: `getModel(): string` → `defaultModelId()`
  (`src/search-agent.ts:65`, `src/payments-agent.ts:139`), `getSystemPrompt(): string`
  (a static capability statement incl. explicit refusals, `src/payments-agent.ts:143`),
  and `getTools()`. **Capability agents return an empty tool set on purpose** —
  `override getTools(): Record<string, never> { return {}; }` (`src/search-agent.ts:77`,
  `src/payments-agent.ts:160`, `src/orchestrator-agent.ts:116`) — because they "are
  dispatched TO": their surface is `@callable()` RPC methods + A2A operations, not
  AI-SDK tools. Only the host carries real tools (the child agent-tools, §3).
- Real work lives in **`@callable()` methods** (`agents` SDK): e.g. SearchAgent's
  `searchSnapshot/searchQuery/searchAsk` (`src/search-agent.ts:97,105,122`); PaymentsAgent
  has ~25 callables including `handleA2A` itself (`src/payments-agent.ts:753`).
- Instances: one named instance per capability for the operator tenant (`"payments"`,
  `"email"`, `"slack"`, `"search"`, … — the `instance` field of the orchestration
  catalog, `src/orchestrate.ts:30-46`), extended per-tenant as `<base>:<tenantId>` (§5).
- State: Think state (`initialState` + `setState`, `src/payments-agent.ts:127` — the
  payments ledger lives there) **and** the DO's own SQLite via `this.ctx.storage.sql`
  (A2A task store, orchestrator job tables, scheduled goals). Agents own their tables;
  nobody writes another agent's tables (ResearchAgent-style publication discipline is
  cfpay's too: the host's A2A capability in `src/a2a.ts` is built from caller-supplied
  accessors "so this class has no dependency on the agent's internal shape").
- Lifecycle hooks: `onStart()` seeds the agent's own tenant FGA tuple
  (`selfProvisionOwnTenant`, `src/search-agent.ts:45`, `src/payments-agent.ts:108`);
  `onConnect()` stamps tenant/user onto the connection (`src/search-agent.ts:59`).

### 2. handleA2A / handleA2AMessage

Two layers, strictly separated:

- **On the agent (RPC door):** `@callable() async handleA2A(body: unknown, origin: string)`
  (`src/payments-agent.ts:754`, `src/search-agent.ts:145`, host `src/agent.ts:1492`).
  It takes a **parsed JSON body, not a `Request`** — a Request cannot cross the DO RPC
  boundary. It builds a transport per call (the card must carry the request's real
  origin or the SDK rejects the call) and returns `handleCollecting(...)`'s plain,
  serializable outcome `{streamed, events, result}` (`src/a2a.ts:771`
  `createA2ATransport`, `src/a2a.ts:916` `handleCollecting`).
- **Transport/executor:** built on **`@a2a-js/sdk`** (`DefaultRequestHandler` +
  `JsonRpcTransportHandler` + a `CapabilityExecutor implements AgentExecutor`,
  `src/a2a.ts:238`) with an `AgentTaskStore` on the DO's SQLite
  (`a2a_tasks` table, `src/a2a.ts:134`). The executor publishes the A2A lifecycle:
  Task `submitted` → `status-update` working → **artifact-update** carrying the data
  part (`artifact.name === "result"`, published *before* the reply because the SDK
  treats a Message as terminal) → reply **Message** (text part) → `status-update`
  completed/final.
- **Capability contract:** `A2ACapability.handle(message, {taskId, contextId, trace})`
  returns **`{text, data?}`** — text is mandatory ("Always present, so the task always
  ends with a message", `src/a2a.ts` `CapabilityResult`). Each agent's
  `handleA2AMessage` (e.g. `src/payments-agent.ts:785`, `src/search-agent.ts:156`)
  extracts text parts and the data part, reads `data.operation`, and **switches on the
  operation string**, passing the whole data object as args. No operation → a
  natural-language read path (answer a question from facts). Unknown operation →
  `{text: "Unknown operation: …", data: {ok: false, error: "unknown_operation"}}`
  (`src/search-agent.ts:156ff`).
- **Error shape:** failures are data, not throws: `data: {ok: false, error: "<stable_token>"}`
  with tokens like `missing_fields`, `missing_message`, `unknown_operation`. The
  executor upgrades any failure data part with a catalog **`code`** (`a2aErrorCode`,
  `src/a2a.ts` executor body) and maps thrown errors to
  `{ok: false, error: "agent_error", code: mapUnknownError(err)}`. Codes come from the
  #209 catalog (`src/errors.json` via `src/errors.ts`: body shape
  `{error, code, hint, retryable}`; raw exception text is never put in a body). Edge
  failures are catalog bodies too (`errorResponseAs("UNAUTHORIZED" | "INSUFFICIENT_SCOPE" | …)`,
  `src/index.ts:206,296`).
- **In-process reading:** callers must dispatch with `message/stream` and read the
  collected events via **`a2aReplyFromOutcome(outcome)`** (`src/a2a.ts:945`) — reading
  `outcome.result.parts` silently yields empty text and no data (fleet-wide bug this
  helper replaced; pinned by `tests/a2a-reply.test.ts`).
- **Auth (`src/a2a-identity.ts`, `src/index.ts:184` `a2aBranch`):** every `/a2a/*` POST
  resolves an identity before dispatch, 401 when none: (1) dashboard key (Bearer or
  X-API-Key, timing-safe compare, fail-closed — also `a2aAuthorised`, `src/a2a.ts:110`)
  → operator tenant; (2) `app_session` cookie → that user's tenant; (3) scoped JWT
  (`MCP_JWT_SECRET`, `tenant_id` claim bound to `sub`, `jti` kept as the FGA subject).
  Write-class operations get a **second, per-operation FGA gate at the branch**
  (`branchWriteGate`, `src/index.ts:267`): JWT callers need an `actor_for` tuple,
  operator/session callers an owner tuple, checked against declarations in
  `src/aspect-authz.ts:125` (`OPERATION_DECLARATIONS`); deny → 403 + an accounting
  event either way. Tenant-scoped branches add their own gates (QA: user tenants get
  read-class ops only, decided by the op's access class in the ops table).

### 3. Agent-as-a-tool

- cfpay uses the framework primitive **`agentTool(ChildClass, {description, displayName, inputSchema})`**
  from `agents/agent-tools` (`src/agent-tools.ts`). One tool per capability agent
  (`emailAgentTool`, `paymentAgentTool`, `slackAgentTool`, `searchAgentTool`,
  `orchestratorAgentTool`, …). Dispatching runs a **retained sub-agent's own Think
  chat turn** — the child reasons with its own model/prompt.
- The tool input is `{operation, ...args}` — **the same operation set as A2A** ("one
  behaviour with two ways to reach it rather than two behaviours"). Schemas are
  declared once as **plain JSON Schema** in `src/agent-tool-schemas.ts` (operation
  enums mirror the A2A ops) and cast to zod via an `asZod` bridge (`src/agent-tools.ts:44`)
  because zod 4 has no `fromJSONSchema`; argument validation ultimately happens at the
  A2A call.
- Registration is the host's choice, in the host's tool set: `CfmailAgentSQLite.getTools()`
  returns the child tools (`src/agent.ts:245`). Deliberate safety shaping: the payments
  tool (which includes `payment.process`) is **fail-closed behind
  `AGENT_TOOL_ALLOW_PAYMENTS === "true"`** (`src/agent.ts:2717,2732`,
  `src/types.ts:65`); the Slack tool's operation list **omits every write**, so a model
  cannot reach a post through it at all — writes live only on the RPC surface.
- The deterministic alternative is preferred for exact work: in-process callers use DO
  stub RPC — singleton stubs are centralized in **`src/agent-stubs.ts`**
  (`qaAgentStub`, `slackAgentStub`, `hostStub`, `identityStub`, …) using
  `getAgentByName` from `agents`, imported **dynamically inside each helper** so test
  modules that import the helpers stay SDK-free. The orchestrator dispatches steps the
  same way: `ns.get(ns.idFromName(entry.instance))` then `stub.handleA2A(body, origin)`
  with a `message/stream` envelope (`src/orchestrator-agent.ts:267` `dispatchStep`).

### 4. Agent cards + operation catalog

Three coordinated artifacts, all derived from SDK-free tables:

- **Ops table — the single source of truth:** `src/a2a-ops.ts` exports
  `A2A_OPS: Record<A2aSurfaceKey, A2aOpSpec[]>` where
  `A2aOpSpec = {operation, summary, access: "read" | "write" | "action", inputs: {name, type, required, hint}[]}`
  plus `A2A_SURFACE_RPC` (surface → dispatch path). Pure, no imports from the runtime,
  so tests import it directly.
- **Cards:** per-agent builder functions in `src/a2a.ts` (`paymentsCard(origin)`,
  `searchCard(origin)`, …) returning the **SDK `AgentCard`** shape extended with
  `operations: A2A_OPS.<surface>` (`AgentCardWithOps`): `name, description, version,
  protocolVersion: "0.3.0", url: origin + rpcPath, preferredTransport: "JSONRPC",
  capabilities {streaming: true, …}, defaultInputModes/OutputModes, provider
  {organization: "OpenAIMP", url}, skills[] {id, name, description, tags, examples}`.
  Cards are written as contracts — they state refusals and disclosures explicitly
  (webhook card: receive is unverified; chat card: transcript is a disclosure).
- **Fleet index, generated:** `A2A_FLEET` (`src/a2a.ts:853`) is one table of
  `{agent, rpcPath, cardPath, card}`; `fleetCardIndex(origin)` (`src/a2a.ts:886`) is
  *generated* from the builders and served at `/.well-known/agent-cards.json`, so the
  index cannot drift from the cards.
- **Orchestration catalog:** `OPERATION_CATALOG` in `src/orchestrate.ts` —
  `{agent, binding, instance, operations, blurb}` per agent; the planner prompt is
  generated from it, plan validation rejects any step whose operation is not in the
  catalog, and destructive ops are deliberately excluded (documented in the header).
- **Sync is enforced by pin tests, not hope:** `tests/a2a-ops.test.ts` pins A2A_OPS
  against (a) the MCP spec's implemented op set (`src/mcp-agent-tools.ts`, aliases
  mapped explicitly), (b) every card builder's emitted operations, (c) the probe list
  `A2A_ENDPOINTS` (`src/a2a-test.ts`); `tests/fleet-index.test.ts` pins the fleet table
  against routed paths and probes; `tests/spec-drift-*.test.ts` pin docs/specs.

### 5. Configuration

- **No central config module per agent.** Configuration is: env vars read at the use
  site with in-code defaults (`AI_SEARCH_INSTANCE || "cfpay"`, `src/search-agent.ts`
  `instanceName()`), boolean env flags compared as strings
  (`AGENT_TOOL_ALLOW_PAYMENTS === "true"`, `LOG_ASPECTS` kill flag), and **per-agent /
  per-tenant persisted settings in the agent's own state/SQLite** (e.g. the autopilot
  objective set via `autopilot.objective.set {goal, budget, cadenceCron?, …}`; the
  dashboard-selected model persists in host state).
- **Models are catalogued, not hardcoded:** `src/models.json` is the owner's model
  catalogue (id, label, context window, prices, `functionCalling`); `defaultModelId()`
  (`src/models.ts:56`) resolves catalogue default → first entry; `src/model-routing.ts`
  adds per-task ordered fallback chains (`MODEL_CHAINS` for plan/supervise/synthesize/
  chat/classify) executed by `runRouted` (`src/model-routing.ts:139`) with
  catalog-aware retry semantics (3043 transient → retry/fallback; 4006 quota →
  terminal, surfaces as `AI_QUOTA_EXHAUSTED`). A test fails if a chain names a model
  outside the catalogue.
- **Tenancy (`src/tenancy.ts`, `src/tenant-dispatch.ts`, `src/tenant-provision.ts`):**
  `resolveTenant(credential)` is the one SDK-free resolver (operator-key / session /
  mcp-jwt / oauth-legacy / anonymous → `{tenantId, userId, identityKind}`);
  `instanceFor(base, tenantId)` = base for the operator, `<base>:<tenantId>` otherwise;
  singleton bases (qa) never split. All dispatch funnels through
  `dispatchToTenantInstance` (`src/tenant-dispatch.ts:143`): resolve instance →
  `checkDispatchEnvelope` (a dispatch's trace tenant must equal the target instance's
  tenant; cross-tenant only to operator singletons) → lazy provisioning (instance
  created on first use; the `(user, owner, tenant:<uid>)` tuple seeded in the
  IdentityAgent; failure never reports ready) → `stub.handleA2A(body, origin)`.

### 6. Cross-cutting aspects (WS1, `src/aspect-*.ts`, all SDK-free)

- **Logging (`src/aspect-logging.ts`):** one fixed-shape structured event per
  operation — `AspectEvent {v: 1, ts, level, tenantId, userId, agent, operation,
  correlationId, durationMs, outcome, errorCode?, scopeUsed?, authDecision?, detail?}` —
  emitted at the API edge, A2A branches, the A2A executor, callables, and workflow
  steps via `emitAspectEvent` (`src/aspect-logging.ts:288`). Correlation travels in the
  `X-Correlation-Id` header and in a **private `_trace` message part**; the executor
  strips that part before the capability sees the message (`extractTracePart`,
  `src/aspect-logging.ts:359`) and the edge *replaces* any inbound trace part with the
  edge-resolved one (`replaceTracePart`, `src/index.ts` a2aBranch), so a replayed
  trace can never pollute the stream. Env knobs: `LOG_ASPECTS` (kill), `LOG_LEVEL`.
- **Error (`src/aspect-error.ts` + `src/errors.ts`):** a thin interception wrapper —
  handlers stop shaping their own errors; thrown values are classified to the #209
  catalog (`classifyApiError` / `classifyA2AError`), bodies are byte-stable catalog
  bodies, and a diff test pins the wire shape. Workflow steps are wrapped with
  `withWorkflowStepAspect` (records; never retries — waitForEvent semantics unchanged).
- **Authz (`src/aspect-authz.ts`):** deny-by-default. Every protected operation
  declares `{objectType, objectId, relation}` in central registers
  (`HTTP_DECLARATIONS` `src/aspect-authz.ts:96`, `OPERATION_DECLARATIONS` `:125`) —
  "not scattered in route code". A check = resolve identity → RBAC coarse gate → FGA
  tuple check against the IdentityAgent; every decision (allow and deny) is emitted as
  an accounting event.
- Aspects are **wrappers/seams at boundaries**, not decorators inside business logic:
  `beginA2AAspect` at each branch, the executor's try/catch, step wrappers in workflows.

### 7. Workflows

cfpay uses **Think workflows** (`ThinkWorkflow` from `@cloudflare/think/workflows`),
not raw Cloudflare Workflows and not ad-hoc state machines:

- Shape: `class XWorkflow extends ThinkWorkflow<HostAgent, Params>` with
  `async run(event: AgentWorkflowEvent<Params>, step: ThinkWorkflowStep)`; steps are
  `step.do(name, fn)` and `step.waitForEvent(name, {type, timeout})`. Registered as
  wrangler `workflows` bindings (`TRADE_WORKFLOW`, `EVIDENCE_WORKFLOW`,
  `wrangler.jsonc:92-101`) and exported from `src/index.ts:115-116`.
- Started from the agent: `this.runWorkflow("TRADE_WORKFLOW", params)`; external
  decisions delivered via `this.sendWorkflowEvent("TRADE_WORKFLOW", workflowId, …)`
  (`src/agent.ts:1893,1934`). **Params carry ids only** (e.g. `proposalId`) — never
  credentials or payloads; steps re-read state/credentials from the agent at run time.
- **`src/trade-workflow.ts` (the trading precedent):** the model proposes a concrete
  Public.com order in a chat turn → host records a trade proposal → `TradeWorkflow`
  (`src/trade-workflow.ts:44`) parks on `step.waitForEvent("wait-for-approval",
  {type: "approval", timeout: "24 hours"})` → on decision, `record-decision` step →
  **`verify-approval-authorization` step**: execution additionally requires an
  *approver FGA tuple* on the proposal in the IdentityAgent, so an approval event
  that bypassed the dashboard route can never execute (deny-by-default) → only then
  `execute-approved-trade`, where the agent claims the proposal before calling out so
  a step retry cannot place the order twice. Timeout = expiry recorded, nothing
  executes, treated as a normal outcome. (cfpay's trading is the Public.com desk on
  the host agent — there is no separate trading agent and no broker-platform
  registry in cfpay; the *workflow/HITL shape* is the transferable part, not the
  plumbing.)
- `src/evidence-workflow.ts:37` shows the minimal shape: three failure-isolated
  `step.do` lanes (backtest submit / forward paper submit / advance-and-arm a
  `scheduled.once` follow-up), idempotent by design.

### 8. Testing

- Vitest over **SDK-free pure modules**: `a2a-ops.ts`, `orchestrate.ts`, `tenancy.ts`,
  `aspect-*.ts`, `errors.ts` are deliberately importable without the agents SDK (this
  is also why `agent-stubs.ts` dynamic-imports `agents` — a static import "would break
  Vitest for every module that imports this one").
- **Runtime contract pins with fakes:** `tests/a2a-reply.test.ts` builds a real
  transport via `createA2ATransport` over a hand-written fake `SqlStorage` and pins
  the envelope/stream shapes for both `message/send` and `message/stream`;
  `tests/a2a-test.test.ts`, `tests/orchestrate.test.ts` (plan validation, waves,
  outcome merging), `tests/model-routing.test.ts` (chains stay inside the catalogue),
  `tests/tenant-isolation.test.ts` / `tenant-provision-onstart.test.ts` /
  `tenant-connection-onconnect.test.ts` (tenancy seams via injected `deps` test
  seams, e.g. `resolveA2AIdentity(request, env, {sessionBackend})`).
- **Drift pins across every generated/derived surface:** `tests/a2a-ops.test.ts`,
  `tests/fleet-index.test.ts`, `tests/iaaa-completeness.test.ts`,
  `tests/spec-drift-335.test.ts`, `tests/spec-drift-352.test.ts`,
  `tests/fleet-index.test.ts`. The pattern: any table that exists in two places gets
  a test that fails when they disagree.

---

## (b) Delta table — cfagent TradingAgent T1 vs the cfpay pattern

| # | Area | cfpay pattern | cfagent TradingAgent T1 | Verdict |
|---|------|---------------|--------------------------|---------|
| 1 | Base class / Think surface | `extends Think<Env>`; `getModel()` → `defaultModelId()` (models.json catalogue); static refusal-stating system prompt | `extends Think<Env>`; `getModel()` → `resolveAiModelName(env, "tradingAgent")` (cfagent's own `src/agents/model.ts` convention, same as ResearchAgent); prompt generated from live services | **ALIGN** — model resolution follows cfagent's in-repo convention, not cfpay's catalogue; acceptable, revisit only if cfagent adopts a model catalogue |
| 2 | Agent's own tools | Capability agents return `getTools() {}` — they are dispatched TO; surface = `@callable()` methods + A2A ops | `getTools()` returns the agent's own services as AI-SDK tools (`buildTradingTools`) | **DIVERGES-JUSTIFIED** — Venus's directive explicitly asks for the agent's own Think workflow with tools; the registry-generated ToolSet is how a dispatched TradingAgent turn would act. But note the inversion vs cfpay and keep T2+ services operation-first (callable/A2A), tools as the generated mirror — which T1 already does |
| 3 | Agent-as-a-tool exposure | Host registers `agentTool(TradingAgent-class, …)` (from `agents/agent-tools`) with a JSON-Schema in `agent-tool-schemas.ts` mirroring the A2A ops; money tools fail-closed behind an env flag | Nothing registers TradingAgent as a tool anywhere; cfagent has no `agentTool` usage at all (OrchestratorAgent reaches ResearchAgent by direct stub RPC, `src/agents/orchestrator.ts:322`) | **DIVERGES-JUSTIFIED** — matches cfagent's established fleet pattern (ResearchAgent precedent). If literal cfpay parity is wanted later, the slice is: `tradingAgentTool` in the orchestrator + a schema mirroring `TRADING_SERVICE_REGISTRY` ops, trading ops gated behind an env flag like `AGENT_TOOL_ALLOW_PAYMENTS` |
| 4 | handleA2A signature | `@callable() handleA2A(body: unknown, origin: string): Promise<unknown>` — parsed body in, collected serializable outcome out | `handleA2A(request: Request): Promise<Response>` (trading-agent.ts) — and cfagent's dispatcher `src/a2a/index.ts` calls `stub.handleA2A(request)` and probes `typeof stub.handleA2A` | **SHOULD-FIX** — a `Request` is not RPC-serializable, so the ported dispatcher cannot actually invoke this method on a DO stub the way cfpay's edge does; cfpay's `(body, origin)` + `handleCollecting` shape exists precisely for this. Adopt the cfpay signature; the HTTP edge (server.ts) should parse the body and re-frame the outcome |
| 5 | A2A wire shape | SDK transport: Task object, lifecycle status-updates, artifact-update (data) published before the terminal reply Message; result read via `a2aReplyFromOutcome` | Hand-rolled JSON-RPC: `{result: {artifacts: [{parts: [{kind: "data", data}]}]}}` — no Task, no status, **no text part** | **SHOULD-FIX** — cfpay's contract makes `text` mandatory (every reply ends with a human-readable message) and cfagent's own cfpay client (`src/services/cfpayA2A.ts`) already knows how to read artifact/history data parts. Either adopt `@a2a-js/sdk` + `CapabilityExecutor` wholesale (cfpay's a2a.ts is portable — it has no cfpay-domain deps beyond errors/models) or, minimally, return `{text, data}`-shaped results with the data part *and* a text part inside a Task-shaped result |
| 6 | handleA2AMessage routing | Per-agent method: find data part → `operation` → switch → call own `@callable()`s; no-op = NL read path; unknown op = `{ok:false, error:"unknown_operation"}` | `dispatchTradingA2A` + registry lookup (`getTradingServiceByOperation`) — same data-part convention (`extractA2AOperation` handles the JSON-RPC envelope and a bare body) | **ALIGN** — routing convention matches, and the registry switch is cleaner than cfpay's per-agent switch statements. Two gaps vs cfpay: no NL/text fallback path (acceptable for a structured competency) and error tokens (next row) |
| 7 | Error shape | Stable tokens in data (`missing_fields`, `unknown_operation`); executor adds catalog `code`; edge errors are catalog bodies `{error, code, hint, retryable}`; raw exception text never shipped | `error: err.message` free text from thrown `Error`s; JSON-RPC `-32700` only for unparseable bodies | **SHOULD-FIX** — adopt stable error tokens in `A2ADataResult` now (cheap: services throw typed errors or return `{ok:false, error: token}`), and use cfagent's own existing catalog (`src/aspects/errorCodes.ts`: `AGENT_ERROR_CATALOG` / `AgentError`, `resolveErrorAspect`) instead of raw messages. Consumers (orchestrator `outcomeFromReply`-equivalent) judge failures by token/code, not prose |
| 8 | A2A edge auth | Every `/a2a/*` POST: identity resolution (key / session / JWT) → 401 fail-closed; write ops additionally FGA-gated per operation at the branch | `src/server.ts:261` routes `/a2a/*` to the dispatcher with **no auth check**; the dispatcher and `TradingAgent.handleA2A` perform none either (cfagent's own `iaaaEndpointCatalog` already flags this) | **SHOULD-FIX (before T3, mandatory before any write op)** — T1's only op is a read, but it still spends provider/API quota per call, and T3/T4 add order placement. Port cfpay's edge shape at cfagent's scale: a credential check in the dispatcher (session or API key, timing-safe, fail-closed) now; per-operation write gating when trade ops land |
| 9 | Operation metadata | Ops table carries `summary`, `access: read/write/action`, and typed `inputs[]` per op — access drives branch gates and the dashboard tester | `TradingServiceDef` carries id/toolName/a2aOperation/description + a zod schema; no access class, no machine-readable input spec outside zod | **SHOULD-FIX** — add `access: "read" \| "write" \| "action"` to `TradingServiceDef` (screening = read; T3/T4 trading = write) so the T3 approval/write gate and any future catalog UI have something to key on. This is a one-field change now and a redesign later |
| 10 | Cards | SDK `AgentCard` (protocolVersion, url w/ real origin, skills[], provider, capabilities) built per agent from the ops table; fleet index **generated** from one `A2A_FLEET` table | Local simplified `AgentCard` interface (`src/a2a/agent-cards.ts`): name/description/version/endpoint/cardPath/capabilities: string[]/operations: string[]; hand-maintained `AGENT_CARDS` array; trading card present and correct for T1 | **DIVERGES-JUSTIFIED** — cfagent's card shape predates T1 (PR #2 port) and changing it is a fleet-wide cfagent decision, not a TradingAgent one. Within T1's control: keep card ops generated from the registry (today they are a hand-written literal that happens to match — the anti-drift test pins it, see #14) |
| 11 | Orchestration catalog | `CatalogEntry {agent, binding, instance, operations, blurb}`; catalog is the planner's universe; dispatch resolves `entry.instance` | cfagent's ported `CatalogEntry` **dropped the `instance` field**; the A2A dispatcher hardcodes `idFromName(agentKey)` | **SHOULD-FIX** — restore `instance` to cfagent's catalog and resolve instances through it; this is the seam tenancy/per-user naming hangs off in cfpay, and its absence is what produces divergence #12 |
| 12 | Instance naming | `instanceFor(base, tenant)`: operator = base itself (`"payments"`); others = `"payments:<tenantId>"`; one stub helper per agent in `agent-stubs.ts` via `getAgentByName` | `tradingAgentName()`: default user → `"default"`, others → `"trading:<login>"`; but the A2A dispatcher resolves `idFromName("trading")` — **three different names for the default instance** depending on the door; stub helper is inline in trading-agent.ts using `ns.get(ns.idFromName(...))` | **SHOULD-FIX** — internal inconsistency, not just a cfpay delta: RPC callers and A2A callers land on different DO instances for the same user. Unify on the cfpay convention: base = `"trading"` (which the dispatcher already uses), per-user = `"trading:<login>"`; move resolution into one helper (cfagent has no agent-stubs.ts — create `src/agents/agent-stubs.ts` or a trading-local helper used by all doors) |
| 13 | `@callable()` decoration | Every RPC surface method incl. `handleA2A` is `@callable()` | `executeService` / `handleA2A` are undecorated plain methods | **SHOULD-FIX** — one-line-per-method; cfagent's ResearchAgent doesn't use it either, but cfpay's pattern (and the agents SDK's client RPC) expects it, and T5's caller migration will want callable semantics. Verify against cfagent's SDK version (agents 0.24.0) when applying |
| 14 | Config | Env-at-use-site + persisted per-agent settings + models catalogue; string-compared boolean flags | Typed `TradingAgentConfig` module with env overrides (providers/default/services), baseline fallback, unknown-service filtering | **ALIGN** — arguably ahead of cfpay (single typed resolver vs scattered env reads) and consistent with cfagent's own `researchConfig.ts` precedent. One cfpay habit worth copying: read flags as exact strings (`=== "true"`) — T1's list parsing already does the equivalent |
| 15 | Tenancy / provisioning | Per-tenant instances, lazy provisioning + FGA tuple seeding in `onStart`, connection tenant stamping, cross-tenant dispatch rule | Per-user instances by GitHub login; no provisioning hook, no `onStart`, identity arrives as an `userLogin` input field | **DIVERGES-JUSTIFIED** — cfagent's tenancy *is* the user login (SessionStore-backed); porting cfpay's tenant/FGA stack is a platform program, not a #291 slice. Do adopt the cheap parts: an `onStart()` that idempotently ensures per-instance state exists (T2+ will add tables), and treat `userLogin` from input as untrusted until the edge supplies it (ties to #8) |
| 16 | Aspects (logging/error/authz) | WS1 aspects at every boundary: one structured event/op with correlation id (header + stripped `_trace` part), catalog-classified errors, central authz declarations | No equivalent in the A2A path. (cfagent has an unrelated older `src/aspects/` — trading error catalog + `withAspects` logging — which T1 doesn't use either) | **DIVERGES-JUSTIFIED for T1, with a pre-T3 slice** — a read-only screening op doesn't need the full aspect stack. Before write ops land, add the minimum: one structured log event per A2A dispatch (agent, operation, outcome, duration, correlation id) and honor/propagate a correlation id. Full FGA declarations are cfpay-scale machinery cfagent hasn't adopted anywhere |
| 17 | Workflows for HITL trading | `ThinkWorkflow` + `step.waitForEvent("approval", 24h)` + approver-tuple re-verification at execution + claim-before-call idempotency; params carry ids only; wrangler `workflows` binding | T1 has no workflow (nothing to approve yet); design doc says placement "flows only through the existing approval path" but doesn't name a mechanism. cfagent has **no** ThinkWorkflow usage anywhere today | **SHOULD-FIX (at T3 design time)** — adopt cfpay's TradeWorkflow shape verbatim for T3/T4: proposal record → `runWorkflow("TRADING_WORKFLOW", {proposalId})` → `waitForEvent` approval with a 24h window → verify-approval step → execute step that claims the proposal first. Add the wrangler `workflows` binding in that slice. Do not build an ad-hoc approval poll |
| 18 | State ownership | Agents own tables/state; A2A tasks persist in the agent's SQLite; cross-agent reads go through the owner's A2A/RPC | TradingAgent T1 is stateless; design keeps ORM persistence (trade records, watchlists) orchestrator-side, state passed as parameters | **ALIGN** — matches cfpay's ownership discipline and T0's data-locality finding. When T2/T3 add state (screening runs, proposals), it should land in TradingAgent's own SQLite (`this.ctx.storage.sql`), following the `AgentTaskStore`/ResearchAgent table pattern |
| 19 | Testing | SDK-free modules + fake-SqlStorage transport runtime pins (`a2a-reply.test.ts`) + cross-surface drift pins (ops↔MCP↔cards↔probes↔fleet) | `tests/trading_agent.test.ts`: config, execution path vs fake provider, A2A extraction/dispatch unit tests, and a card↔catalog↔registry anti-drift test — good coverage of the pure layer; no transport-level pin (there is no transport), no fake-SQL DO test | **ALIGN (for T1's shape)** — the anti-drift test is exactly cfpay's pattern. When slice A1/A2 below introduces the transport outcome shape, add the `a2a-reply.test.ts` equivalent: a fake-SqlStorage runtime pin for `handleCollecting`-style outcomes so the reply-extraction contract can't silently break |
| 20 | Provider pluggability | N/A in cfpay (single-provider desk; Public.com is wired as MCP tools on the host) | `TradingPlatformRegistry` resolution inside services; providers config-gated; fake-provider test proves broker-neutrality | **ALIGN / cfagent ahead** — this is the directive's core requirement and cfpay has no counterpart pattern to copy; keep the registry as the only provider seam (T3/T4 services must resolve platforms exactly like `stock_screening` does) |

---

## (c) Recommended alignment slices (ordered; fold into #291 before T2)

Each slice is one small PR under the existing gitops flow. A1–A3 are the
"make the A2A door real" set and should land before T2 adds a second service —
every later service inherits the door's shape. A4 is a prerequisite for T3, not
T2, but is cheapest while the registry has one entry.

1. **A1 — A2A door signature: `handleA2A(body, origin)` + collected outcome.**
   Change `TradingAgent.handleA2A(request: Request)` to cfpay's
   `@callable() handleA2A(body: unknown, origin: string)` returning
   `{streamed: false, events: [], result}` where `result` is a Task-shaped
   object whose parts carry **both** a text part (one-line summary of the
   outcome) and the data part. Update cfagent's `src/a2a/index.ts` dispatcher
   to parse the JSON body at the edge, call `stub.handleA2A(body, origin)`,
   and re-frame the outcome as the HTTP response (the cfpay `a2aBranch`
   shape, minus tenancy). Add a reply-extraction helper
   (`a2aReplyFromOutcome` equivalent) next to `src/services/cfpayA2A.ts` and
   use it in the dispatcher tests. *Why first: every other door property
   (auth, errors, tests) hangs off this signature.*
2. **A2 — One instance name, one stub helper.** Restore `instance` on
   cfagent's `CatalogEntry` (trading: `"trading"`), have the dispatcher
   resolve `idFromName(entry.instance)`, change `tradingAgentName()` to
   return `"trading"` for the default user and `"trading:<login>"` otherwise
   (cfpay's `instanceFor` convention), and move `getTradingAgentStub` into a
   single-owner helper used by all callers. Pin with a test: RPC helper and
   A2A dispatcher resolve the same instance name for the same user.
3. **A3 — Stable error tokens for trading services.** Services return/throw
   typed failures so `A2ADataResult.error` is a token
   (`unknown_operation`, `service_disabled`, `provider_not_enabled`,
   `provider_not_registered`, `provider_unsupported`, `invalid_input`,
   `missing_fields`) and the text part carries the human message. Reuse
   cfagent's `src/aspects/errorCodes.ts` (`AgentError` /
   `AGENT_ERROR_CATALOG`) rather than inventing a parallel catalog. Extend
   `tests/trading_agent.test.ts` to pin the token for each failure mode
   (several already assert message substrings — switch them to tokens).
4. **A4 — Access class on the service registry.** Add
   `access: "read" | "write" | "action"` to `TradingServiceDef`
   (`stock_screening: "read"`), surface it in the generated card/catalog
   data, and pin it in the anti-drift test. This is the hook T3's approval
   gate and any future branch write-gate will key on (cfpay's
   `qaOperationAccess` / `branchWriteGate` pattern).
5. **A5 — Authenticate the A2A edge.** In `src/server.ts`/`src/a2a/index.ts`,
   gate POST `/a2a/*` on a credential (existing session cookie or API key,
   timing-safe compare, fail-closed, 401 catalog-style body) before
   dispatch — cfpay's `a2aAuthorised` shape at cfagent's scale. Cards and
   `/.well-known/*` stay public. *Must land before T3; do it now while the
   only exposed op is a read so the gate is exercised before it matters.*
6. **A6 — Dispatch logging + correlation (aspects-lite).** One structured
   log line/event per A2A dispatch in the dispatcher: `{agent, operation,
   outcome, durationMs, correlationId}`; accept `X-Correlation-Id` or mint
   one, and pass it through the outcome. Deliberately *not* the full cfpay
   WS1 stack (no `_trace` parts, no FGA) — just enough that a multi-agent
   run is debuggable, matching the spirit of `beginA2AAspect` without the
   platform program.
7. **A7 (with T3, not before T2) — TradeWorkflow for order approval.**
   Implement T3's HITL as a `ThinkWorkflow` copied from cfpay's
   `src/trade-workflow.ts` shape: proposal row in TradingAgent's SQLite →
   `runWorkflow("TRADING_WORKFLOW", {proposalId})` → `step.waitForEvent`
   (24h) → verify-approval step (approval record checked inside the
   workflow, not trusted from the event payload) → claim-then-execute step.
   Add the wrangler `workflows` binding and export the workflow class in
   `src/server.ts` in the same PR.

**Explicitly not recommended for #291:** porting cfpay's tenancy/FGA stack
(`tenancy.ts`, `tenant-dispatch.ts`, IdentityAgent tuples), the `@a2a-js/sdk`
transport wholesale (worth it only if cfagent wants spec-client interop —
A1's Task-shaped outcome gets 90% of the value), `models.json` /
`model-routing.ts` (cfagent's `resolveAiModelName` convention is fine), and
`agentTool()` host registration (row #3 — revisit only if Venus asks for
literal agent-as-a-tool dispatch in the orchestrator).
