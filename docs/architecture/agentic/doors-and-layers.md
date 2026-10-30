# Doors and Layers: how capabilities are invoked

Status: v1 (2026-10-29, #CAIO-quns) — the Agent Mesh program's
invocation-model reference, landed via #2256; improved in place by
follow-up slices. Companion references: the
Agent Mesh program (OpenAIMP/cfagent#2225), the mesh survey
(`docs/architecture/survey/`), the standards register
(`docs/architecture/standards/standards.md`), and `think-or-DO.md` in this
folder.

This document defines the invocation model of the platform: the vocabulary
(channels, triggers, doors, agents, services, engines, workflows), the layer
stack they form, and the rules that follow. It exists so that program issues
and PRs can cite one model instead of re-deriving it. Sections 1–6 describe
the runtime as it is and as the mesh program is making it; Section 7 covers
the cross-cutting planes a self-improving platform needs around that runtime.

## 1. Vocabulary

- **Channel** — a transport that carries a user's intent into the system:
  web chat, Slack, email, voice, webhook. A channel invokes nothing itself;
  it terminates on the orchestrator and becomes a turn.
- **Turn** — one round-trip inside a chat conversation with an agent: a
  message arrives, the agent processes it (model call, tool calls, state),
  and the reply returns in that conversation. A turn natively carries
  conversation history, agent state, and the acting identity, because the
  orchestrator instance is per-login (`/agents/orchestrator-agent/<login>`).
- **Route** — an HTTP endpoint on the Worker (`/api/...`). Request/response,
  addressed by URL, called by the web UI, cron, or external services. A
  route carries only what the request carries; identity is reconstructed
  per call from the session. A turn never calls a route.
- **Door** — any distinct surface through which a caller can invoke a
  capability. Each door has its own wiring, its own identity handling, and
  its own gate enforcement point. A capability is reachable only through
  the doors it was wired into.
- **Agent** — a Durable Object class (all nine extend PortThink). Agents
  are drivers: identity, state, turn mechanics, callable door methods,
  workflow starts. Agents are not supposed to own domain logic.
- **Service** — the coordinating shell for one unit of work: acting
  identity and tenancy, persistence, provider wiring through the registry
  and circuit breakers, gates, retries, delivery, audit. A service call
  assembles inputs, invokes an engine, and persists the outcome — all
  within a single activation (one turn, one route call, one workflow
  step). A service cannot wait: nothing of the call survives the
  activation.
- **Engine** — a self-contained computational core: inputs in, result out.
  No caller knowledge, no identity, no persistence of its own; same inputs,
  same output. Examples: the goal screen engine, the chain executor, the
  shared approval engine (approve/reject/expire state machine plus
  signed-link verification, extracted in #1262 from three channel copies).
- **Workflow** — durable composition across time. A workflow sequences
  service invocations as steps whose completion is persisted; it retries
  failed steps, sleeps, fans out to children, and waits for events or
  approvals, surviving eviction throughout. A workflow contains no domain
  logic: every step calls a service, usually via an agent method.
  Workflows never call engines directly — a step needs identity and
  domain persistence, which only the service provides.
- **Trigger** — an origin of work that is not a caller. Schedules
  (Section 4) are the platform's triggers; channels bring a person,
  schedules bring a time.

### Program vocabulary

The terms the programs around this model run on:

- **Agentic fleet** — the agent classes as a managed whole: nine
  PortThink classes under one base-class and port discipline (Section
  10). Fleet work (the #1951 migration) treats the nine as one surface:
  same base, same hooks protocol, same conformance bar.
- **Mesh** — the program state in which every agent and workflow is
  reachable behind chat through typed doors, with the conformance matrix
  pinned (#2225). The mesh is the fleet plus its doors, made complete.
- **Lane** — an ownership line in the agentic org (CAIO, CTO, CDO, CISO,
  CBO, CEO, COO, CPO): one agent team, its queue, its hashtag on every
  issue and PR. Lanes link each other's work; they do not duplicate it.
- **Gate** — a deterministic check that can stop a flow: permission
  (PDP), approval (shared engine), budget, payment, halt, and the CI /
  Policy Gate on the repository side. Gates are services, not
  conventions.
- **Pin** — a test that fixes a contract in place (a conformance pin):
  if behavior drifts, the pin fails. Pins are how survey findings and
  matrix cells become permanent.
- **Slice** — one issue → one PR → one merge, the unit of delivery
  (gitops). An epic or program is a set of slices, never one large PR.
- **Seam** — a named join point where a caller meets a capability
  through a small interface (the payment submission seam, the PDP seam,
  the orchestrator's store/deliver seams). Seams are where gates attach.
- **Port / adapter** — the hexagonal rule: domain code depends on a port
  (interface); each platform or provider is an adapter behind it. D1 is
  one storage adapter, not the architecture (Section 3, layer 6).
- **Projection** — a read-optimized copy of authoritative state (D1
  mirrors DO state). A projection can be rebuilt from its source; the
  source (DO storage) is the truth.
- **Registry** — the code-derived inventory of fleet, workflows,
  capabilities, and their door exposure (G0). The registry is the
  machine-readable form of Section 10 — and, made queryable at runtime,
  the platform's self-knowledge (Section 7.2).
- **Card** — an A2A agent card: a published description of an agent's
  capabilities for the A2A door. Six cards exist; cards are a surface,
  not agent classes.
- **Stub** — an in-process RPC handle to a Durable Object instance. How
  agents and route handlers actually call each other; not HTTP.
- **Fail-closed** — on missing identity, missing configuration, or a
  failed check, the flow refuses rather than proceeding on a default.
  The opposite of a synthetic fallback (Section 7.3, G14).
- **Qualified partial** — a run that completes with named missing
  parts (failed legs recorded with reasons), as opposed to a false
  Complete or a total failure.
- **Conformance matrix** — the per-agent × per-capability grid (G7) in
  which every cell is IMPLEMENTED-with-pin, NOT-APPLICABLE-with-reason,
  or a GAP slice. Zero unclassified cells is the bar.
- **Golden task** — a fixed evaluation task with a known-good outcome,
  run per door on a schedule (G13): the deterministic check wrapped
  around a non-deterministic surface (Section 8).

## 2. The door inventory

Five invocation doors, plus channel ingress (Section 1) and schedule
triggers (Section 4):

| Door | Caller | Wiring | Identity | Gate enforcement |
| --- | --- | --- | --- | --- |
| Chat turn | The user, in conversation | Tools registered in the orchestrator agent (the MCP command set) | Per-login session (the instance key) | In-turn, before the tool executes |
| HTTP routes | Web UI, cron, external services | Handlers in the Worker's fetch layer | Session, reconstructed per request | In the handler / service seam |
| MCP | External MCP clients and hosts | The MCP server: protocol endpoint + command registry | Per-tool scopes (#1744) | At the MCP factory / adapter |
| A2A | Other agents, external agent clients | A2A endpoint dispatch to agent cards (inbound built by #2223) | A2A credentials — one shared bearer token today; per-agent credentials are G14 | At dispatch |
| Agent-as-a-tool | An agent, inside its own turn | SDK dispatch to another agent (`runAgentTool`) | Acting agent + principal (two-part attribution, G14) | At the dispatch seam |

Two doors are easy to conflate and must not be:

- **Chat turn vs MCP.** The turn's tools *are* the MCP command set — same
  command definitions, same handlers over the same services. They are
  still two doors: in-process tool calls inside a turn are not protocol
  calls from an external MCP client, and their identity and enforcement
  points differ (per-login session vs per-tool scopes).
- **Routes vs everything.** Routes are the only door whose caller is plain
  HTTP. No other door goes through a route, and a route is never how an
  agent reaches a capability.

Known single-door capabilities (survey evidence, 2026-10-29): the MAS
tools are route-only (sole production caller: the SearchHub route);
PaymentWorkflow starts from an orchestrator route, not from the chat turn;
TradingAgent's approval door has tests-only callers; no workflow start is
reachable from chat at all. Closing these is Agent Mesh G1/G2/G4/G5/G12.

## 3. The layer stack

Top to bottom. Everything above the agents is plural and per-door;
everything from the agents down is shared and singular.

1. **Channels** — web chat, Slack, email, voice, webhook. Terminate on the
   orchestrator; become turns.
2. **Doors** — chat turn, routes, MCP, A2A, agent-as-a-tool, in a parallel
   band. No door calls another door. Two partial exceptions: channels feed
   the turn from layer 1, and agent-as-a-tool is a door between agents,
   invoked from inside the calling agent's turn, one level in from the
   edge.
3. **Identity and gates** — each door resolves identity its own way and
   enforces at its own point, but gate *logic* is shared and singular:
   PDP permission checks, the shared approval engine, the budget check,
   the payment gate. Per-door enforcement points; one implementation per
   gate.
4. **Agents** — the PortThink Durable Object classes: turn handling,
   state, callable door methods, workflow starts.
5. **Services and engines** — services coordinate one unit of work;
   engines compute. A capability lives here, exactly once.
6. **Execution and persistence** — workflows (durable runs), the
   queues / CloudEvents bus, Durable Object storage (authoritative
   per-agent state), D1 (queryable projection), R2 (blobs). Workflow runs
   are tracked in D1 projection rows + instance status — deliberately not
   the SDK's built-in per-agent workflow tracking (the G7 matrix classifies
   that cell explicitly).

Rules that fall out of the stack:

- **Logic once.** A capability is implemented once, in layer 5. Exposing
  it through a new door is wiring + identity + gate enforcement — never a
  copy of the logic per door. (Counter-example on record: the approval
  logic triplicated across email/Slack/voice before #1262.)
- **Register once, expose per door deliberately.** The G0 registry records,
  per capability, which doors expose it — including MCP. A capability
  externally callable over MCP must not read as unexposed.
- **Exposure never removes a gate.** A new door inherits the approval,
  budget, and payment gates of the capability (G12 guardrail).
- **Workflows are adopted where a path is long, multi-step, retryable, or
  approval-gated.** Short paths run door → service → engine in one
  activation, no workflow — that is a legitimate shape, not a gap.

## 4. Triggers: schedules

A schedule is an origin, not a door. Its two aspects live in different
layers:

- **Definitions are domain data.** The schedule catalogue (production:
  'Options Market Screen', 'Stock Market Screen', the synthesized goal
  schedules) is user-visible, managed through the doors, and stored as
  agent state — ScheduledAgent's storage, projected to D1
  (`agent_synthesized_schedules`). The catalogue is a product surface.
- **Firing is a platform trigger.** Worker cron enters through the server
  into `ScheduledAgent.onCron()`; the Agents SDK's own `schedule()`
  primitive fires as a Durable Object alarm waking the instance. From the
  firing onward, the work is indistinguishable from a door-originated
  call: it lands on services, which invoke engines or start workflows (a
  scheduled goal screen starts the ScreenerScreenWorkflow).

The one structural difference: **a firing has no caller**, so identity
comes from the schedule itself — the owner's login it was created under,
or the service identity (`SERVICE_USER_LOGIN`, fail-closed when unset)
for unattended work. Consequential unattended paths are restricted by
rule: scheduled paid runs are subscription/credits only, never an
unattended card.

Two kinds, one mechanism (mesh survey §4 ruling): **catalogue schedules**
(ScheduledAgent — user-visible goals) and **machinery schedules** (an
agent's own `schedule()` calls — escalation reminders, per-login
housekeeping). Same trigger family, different visibility.

## 5. Worked example: a chat-initiated screen

1. Channel: web chat. The user's message becomes a turn on their
   per-login orchestrator instance (door: chat turn; identity: session
   login).
2. The turn starts **ScreenerScreenWorkflow** (G2 shape; today the screen
   still runs in-process — that is the gap G2 closes).
3. Step `execute-goal-screen` calls ScreenerAgent; the **screening
   service** assembles identity, universe, and provider data (registry +
   breakers); the **goal engine** computes the screen.
4. The service stores the canonical report; step `project-shard` writes
   the D1 projection row; step `deliver-shard` delivers (Slack/email per
   the command).
5. Status and results surface in the chat turn and the screening UI; an
   eviction mid-run resumes from the persisted steps (G6 pins).

The same screen via a schedule differs only at the origin: cron fires,
ScheduledAgent supplies the identity, and steps 2–5 are identical. That
is the point of the model — origins and doors vary; everything below the
agents does not.

### Second example: "upgrade my subscription" sent over Slack

Target shape, with today's gaps named:

1. **Channel:** Slack. The message should terminate on the orchestrator
   as a turn (G10). Today Slack ingress bypasses SlackAgent — a parallel
   implementation nothing calls — so this step is not yet uniform.
2. **Identity — the hard blocker.** The system must know *whose*
   subscription this is. There is no Slack team/user → login mapping
   today (#1262 finding: without one, any workspace member could act on
   anyone's account). Until the mapping exists (per-user connect-code
   binding is the recorded recommendation), the correct behavior is
   refusal, not a guess.
3. **Interpretation:** the turn classifies upgrade / review / cancel —
   non-deterministic, and harmless, because nothing has been decided yet.
4. **Decision and execution:** review is a read through the subscription
   service (payment-provider-backed; subscription state lives with the
   provider, cfpay-side). Upgrade and cancel are money-adjacent state
   changes: they execute deterministically through the service only
   after an explicit confirmation via the shared approval engine —
   exposure through a chat door never removes that gate (G12). A bare
   "yes" in chat from an unmapped identity authorizes nothing.
5. **Record:** the change, the mapped identity, and the approval land in
   the audit record (evidence plane); the turn narrates the
   deterministic result back into Slack.

Status: not supported end-to-end today — no Slack identity mapping, no
subscription-management door. It is a mesh-shaped slice (G10 + G12 +
a provider-backed subscription service), not new engine work.

## 6. Honesty notes (survey state, 2026-10-29)

- SDK state API (`setState`) is used by no agent; state is direct
  `ctx.storage`. The G7 State row is classified on that evidence.
- Zero `onConnect` in the fleet; only OrchestratorAgent defines `onStart`.
- The repo's `durableFibers` is home-grown and not durable (in-memory Map;
  checkpoints written, never read). Durable execution is judged against
  the real SDK primitive (`runFiber` / `startFiber` / `stash` /
  `onFiberRecovered`).
- No workflow has an eviction/resume test; G6's proof bar is unmet
  everywhere today.
- Sandbox and Browser tool families are degraded in the deployed
  configuration (no container backend wired; no Browser Rendering binding
  declared) and report themselves honestly as such (G11).

## 7. The RSI/ASI planes

The stack above is the runtime path — how work gets invoked and executed.
A self-improving platform needs four cross-cutting planes around it. They
are not layers in the stack: each one observes or constrains every layer.

### 7.1 Evidence plane — what the platform remembers about what happened

- One event schema on a CloudEvents envelope (#1739, #1743): every door
  call, workflow step, and engine result is observable as a structured
  record with a trace that follows correlationId from enqueue → run →
  events → D1 rows.
- Audit as a first-class record (D1 `agent_chain_audit`, row per event;
  Q7's blocking set decides which actions may not proceed when durable
  audit cannot be recorded).
- Calibration (#1742): outcomes scored against predictions (thesis
  realizations, falsification-gated decisions). Evidence is what makes
  improvement claims checkable rather than asserted.
- Cost and token metering per door, per agent, per run (G13 budgets).
  Today: absent in the turn path — a named gap.

### 7.2 Knowledge plane — what the platform can recall

- Retrieval behind a port (#1740 hybrid RAG; AI Search as a tool family):
  the market graph, the reports corpus (`mas_reports`), and agent memory
  are retrievable knowledge, not just stored data.
- The G0 registry and the G7 matrix are runtime-queryable self-knowledge:
  an agent can ask what exists, what it may call, and what state it is in
  (G13). Today the catalog and A2A cards are data with no query surface —
  self-knowledge is partial.

### 7.3 Governance plane — how the platform is bounded

- The halt switch (fail-closed mirror; the single synchronous D1 write)
  and feature flags/kill switches per capability (e.g.
  `enrichment.killSwitch`).
- Circuit breakers (#1745) as the automatic bound on failing providers
  and models; budget checks and the payment gate as the bound on spend.
- Per-agent identity and attestation (G14): per-agent mesh credentials
  replacing the one shared A2A bearer token, two-part attribution on every
  call. Note: the current DID construction is unkeyed hashing — a
  labelling pattern, not a proof. Real attestation needs a keyed
  construction, decided in the G14 slice.
- Human-in-the-loop gates that exposure never removes (G12): trade
  approvals, payment approvals, and the Q7 blocking set.

### 7.4 Improvement loop — how the platform changes itself

The loop is a cycle *around* the stack, and it writes back through the
repository — never around it:

1. **Observe** — the evidence plane records runs, traces, outcomes.
2. **Evaluate** — golden-task evals per door (G13; the harness
   landed as S18, #2439 — tasks declared as data in
   `src/services/meshGoldenTasks.ts`, driven through the real
   door paths, scored results recorded in
   `agent_mesh_eval_results` for the proposal pipeline to read),
   calibration scoring, QA sweeps, self-healing signals
   (note: `handleQAFailure` was dispositioned by #2439 as
   superseded — issue filing lives in `scripts/qa-smoke.mjs`
   and the supervised diagnosis in `POST /api/qa/investigate`;
   the function is deprecated in place with no caller, by
   design).
3. **Propose** — findings become §5 issues through the proposal pipeline;
   the platform files its own change proposals with the same evidence bar
   as any lane's.
4. **Gate** — gitops decides: branch, PR, CI, review, merge. No
   self-merge, no direct production mutation. Prompt steps never decide
   money or screening outcomes; where generation is used (Phase 6), a
   prompt produces a spec and deterministic code validates it.
5. **Deploy and re-observe** — the change becomes new runtime behavior,
   and the evidence plane records whether it actually improved anything.

**Loop components and their relationships:**

- **Observers** (evidence plane, Section 7.1) — telemetry, audit,
  calibration. They read every layer of the stack and write only
  records; they never change runtime behavior directly.
- **Evaluators** — the golden-task harness (G13, absent today), the
  parity harness (#1746), QA sweeps and smoke checks. Evaluators consume
  observer records and produce verdicts (pass/fail, falsification
  rates), not changes.
- **Proposers** — the proposal pipeline and the agent lanes. A verdict
  becomes a §5 issue with evidence attached; lanes implement slices.
  Proposers write to the repository, never to production.
- **Gates** (governance plane, Section 7.3, plus repository gates) —
  CI, Policy Gate, review, the merge ruleset, and the owner's
  sequencing decisions. Gates are the only path from a proposal to a
  running change.
- **Actuators** — the deploy pipeline and operator actions (seed
  invokes, flag flips, gateway activation). An actuator acts only on
  what the gates have passed.

Relationship rule for the loop: information flows observe → evaluate →
propose → gate → actuate → observe. No component skips a stage — an
observer that could actuate, or a proposer that could merge, would
break the loop's safety property, which is that every self-modification
is a reviewed repository change.

The loop is the difference between a platform that is merely automated
and one that is self-improving: automation is the stack; improvement is
the loop, and the loop's only write path is the gated repository.

## 8. The determinism boundary

**Where it sits:** between interpretation and execution — physically,
between the agent turn (layer 4) and the service layer (layer 5). Doors
carry non-determinism; they do not create it. The chat turn is the only
inherently non-deterministic door; route, MCP, and A2A calls are
deterministic unless they reach a turn.

**Non-deterministic points — exhaustive by construction:**

1. **Agent chat turns** — model generation and tool choice, in the
   turn-capable agents only.
2. **Interpretation of unstructured input** — NLQ parse/plan, goal-plan
   scenario work. The plan that comes out is executed deterministically;
   the interpretation is not.
3. **Sanctioned generators** — Phase 6's `step.prompt()` producing a
   WorkflowSpec (the first sanctioned prompt step, sequenced after
   Phase 5), and the #1742 governed prompt-note engine. Retrieval ranking
   (vector similarity) is model-adjacent and treated as non-deterministic
   for contract purposes.

**Everything else is deterministic:** services, engines, gates, workflow
step logic, projection and reconciliation, retention. By decision
authority the split is absolute — every item in the Q7 blocking set
(trade execution/approval, delivery claims, report store, guard
decisions, E*TRADE token operations) is decided by deterministic code.

**The crossing rule:** non-deterministic output flows down only as a
validated proposal — schema-checked tool arguments, a compiled plan, a
validated spec, a falsification-gated note. Deterministic results flow
up as facts a turn may narrate but not alter. Prompt interprets;
deterministic code decides.

**Why money and screening workflows ban prompt steps:** workflow replay
requires deterministic step logic — step results are memoized, and a
model call inside a step would make the run's record unreproducible.
Steps are `step.do()` plus approval waits, never `step.prompt()`.

**Bounding the surface:** per-door golden-task evals (G13) are
deterministic checks wrapped around a non-deterministic surface; the
conformance pins (G6/G7) hold the deterministic side. The
non-deterministic surface is kept deliberately small — turns,
interpretation, two boxed generators — against a deterministic substrate
that is the overwhelming majority of the codebase by volume, and all of
it by authority over consequential action.

## 9. Code generation and the browser: when the system uses them

**Code generation — not used in the runtime today, by design.** The only
sanctioned generation produces artifacts that deterministic code then
validates: Phase 6's prompt step produces a WorkflowSpec (never
executable code; a deterministic compiler validates it against the
registry allowlist, and registration needs human approval), and the
#1742 engine produces prompt *notes* behind a falsification gate. The
sandbox tool family — the would-be code *execution* surface — is
honestly degraded in the deployed configuration: no container backend
is wired, calls report `executed: false`. Code generation's working
home today is the improvement loop's propose step (Section 7.4): agent
lanes draft code as PRs under gitops gates. Any future in-runtime code
execution requires the sandbox backend decision on evidence plus owner
confirmation (G11) — and never on money or screening paths, where the
determinism boundary (Section 8) forbids generated code from deciding
or executing.

**The browser — for pages that fetch cannot read.** The browser tool
family and BrowserAgent exist for work that needs JavaScript rendering,
a login session, screenshots, or interaction: research capture and
page evidence, where `web_fetch` (static, no session) is insufficient.
Status today: degraded in the deployed configuration — the `env.BROWSER`
path is real, but no Browser Rendering binding is declared in wrangler,
so captures fall back to labelled placeholders. Wiring the binding is a
G11 item; until then the family reports itself degraded rather than
pretending to have browsed. Like every tool family it sits behind the
turn that invokes it: the browser gathers evidence, deterministic code
decides what the evidence means.

## 10. Named members and their relationships

The inventories below name the principal members as of the 2026-10-29
survey. They are orientation, not the registry: G0 produces the
exhaustive, code-derived lists and pins them against wrangler, cards,
and catalogs. Where this section and the registry ever disagree, the
registry wins and this section is updated.

### 10.1 The fleet (agents)

Nine Durable Object classes, all extending PortThink:

| Agent | Role in the mesh |
| --- | --- |
| Orchestrator | The chat-facing agent: owns the turn, the tool set, and the store/deliver seams every workflow uses. (G0 renames the chat-facing SearchAgent class to OrchestratorAgent; an OrchestratorAgent registration already exists — the collision the rename slice resolves first, survey §5.) |
| Research | Research turns; the one live agent-as-a-tool target (orchestrator dispatches it via `runAgentTool`). |
| Trading | Owns the trade approval door (`runWorkflow`); no production caller from chat today (G4). |
| Screener | Executes screens: `runScreen` / `runGoalScreen` per shard for the screener workflow. |
| Scheduled | The schedule catalogue and its firing (`onCron`); triggers runs, executes no workflow steps. |
| Payments | Paid-request handling (`processPaidRequest` — no production caller today); the budget check G5 wires before PaymentWorkflow spend. |
| ReportAsset | Report assets; reachable from chat indirectly via the report pipeline. |
| Browser | Browser tool family's agent; degraded in the deployed configuration (Section 9). |
| Slack | The Slack channel's agent; its own gated ingress is a parallel implementation nothing calls (G10). |

Joining via #2223: **AiSearchAgent** (AI Search binding; Section 2's
tool references). Not a fleet member until #2223 lands it.

Related surfaces that are **not** agent classes: the six A2A cards
(orchestrator, search, payments, tasks, memory, trading) and
`socialAgent.ts` (a module of posting functions).

### 10.2 Workflows

Three workflow classes, all extending ThinkWorkflow. There is no
OrchestratorWorkflow — orchestration is a caller relationship, not a
class.

| Workflow | Started by | Executes on | Notes |
| --- | --- | --- | --- |
| ScreenerScreenWorkflow | Orchestrator (turn/route), ScheduledAgent (firing) | ScreenerAgent (execute steps) + OrchestratorAgent (store/deliver seams) | The conformance exemplar: sharded fan-out, idempotent start, D1 projections, Runs UI. Parent/child per shard. |
| TradingTradeWorkflow | TradingAgent's approval door only | Trading services via the approval gate | No status surface today; tests-only callers (G4/G6). |
| PaymentWorkflow | The submission seam (`paymentWorkflowSubmission`), from orchestrator routes | OrchestratorAgent as caller; the cfpay gate service | Landed via the CBO program (PR #2023): per-run-request charge, testnet-only, flag default OFF. Never references PaymentsAgent — the G5 budget check is new wiring. |

Planned: the Phase 6 generator workflow (a ThinkWorkflow whose prompt
step produces a WorkflowSpec for deterministic compilation; Section 9).

### 10.3 Services (principal)

- **ScheduledTasksService** (`src/services/scheduledTasks.ts`) — firing,
  audit, and scheduled-task coordination around the engines.
- **Screening runtime** (`src/services/screeningRuntime.ts`) — the
  store/deliver/audit shell for screen execution.
- **Payment gate** (`src/services/cfpayMonetization.ts`) — the
  per-run-request monetization decision; testnet-only; fail-closed.
- **Payment submission seam** (`src/services/paymentWorkflowSubmission.ts`)
  — decides sync vs workflow start for paid requests; no free screener
  when monetization is on.
- **cfpay A2A client** (`src/services/cfpayA2A.ts`) — the outbound
  client to the payments app.
- **Channel trading services** — email/Slack/voice adapters into the
  shared NLQ pipeline and approval engine (consolidated in #1262).
- **Provider services** — market-data providers (E*TRADE, Yahoo,
  Alpaca-behind-flag) behind the registry + breakers; Public.com data
  service exists but is parked by owner direction (2026-10-27).

### 10.4 Engines (principal)

- **Market screen engine** — the feed → gather → analysis pipeline
  behind `runScreen` (coded rules; 100% AI-free).
- **Goal screen engine** — goal/thesis evaluation behind
  `runGoalScreen`; produces qualified partials with named leg failures.
- **Chain executor** — leg-by-leg chain execution (`runChain`), with
  per-leg outcome capture into D1. Execution binds at the server route;
  the MCP `chain.run` command reports unimplemented in MCP context
  (recorded limitation).
- **Approval engine** (`approval.ts`) — one shared approve/reject/expire
  state machine + signed-link verification for email/Slack/voice
  (#1262).
- **NLQ pipeline** — natural-language interpretation → plan → execution
  for the trading channels; interpretation is the non-deterministic
  step, execution is not (Section 8).
- **Calibration / prompt-note engine** (#1742) — scores outcomes
  against predictions; generates governed prompt notes only past the
  falsification gate (≥20 samples, falsification rate > 0.5).

### 10.5 Ports (the seams between layers)

Actor port (PortThink base), workflow port (#1737), storage port with
D1 as one adapter (#1546, `src/data`), messaging bus — CloudEvents
send + publish (#1739, `src/messaging`), retrieval port (#1740,
`src/retrieval`), circuit-breaker port (#1745, `src/breakers`),
telemetry port (#1742, `src/telemetry`), AI gateway port (#1741,
`src/gateway`), observability port (#1743, `src/observability`),
permission scopes (#1744, `src/permissions`). Every port ships an
in-memory adapter beside it — a test/conformance double by design,
never the production path.

### 10.6 Relationships (who reaches whom)

- **Orchestrator → Research:** agent-as-a-tool dispatch (live).
  **Orchestrator → all other agents:** typed doors are G1 — mostly not
  wired today.
- **Orchestrator → workflows:** starts ScreenerScreenWorkflow;
  starts PaymentWorkflow through the submission seam. **ScheduledAgent
  → workflows:** starts them on firing. **TradingAgent → workflow:**
  the approval door is TradingTradeWorkflow's only start path.
- **Workflows → agents:** ScreenerScreenWorkflow executes on
  ScreenerAgent + OrchestratorAgent only. No workflow class inherits
  from an agent; workflows call agents through stubs.
- **Agents → services → engines:** ScreenerAgent → screening runtime →
  screen engines; ScheduledAgent → ScheduledTasksService → screens,
  goals, chains; channel services → NLQ pipeline + approval engine.
- **Doors → capabilities (highlights):** chat turn = MCP command set
  (51 scoped tools post-#1744); MAS tools = route-only; A2A = the six
  cards; schedules = catalogue managed through doors, fired by
  triggers. The full capability × door matrix is the G0 registry's
  job; G12's rule is that every cell in it is deliberate.

## 11. Behavior

Terminology says what things are; this section says how they behave —
the contracts a reader can rely on without reading code.

### 11.1 Doors and turns

- A door resolves identity first, checks gates second, dispatches
  third. A door that cannot resolve identity refuses (fail-closed); it
  never substitutes a default or synthetic identity.
- An unwired or degraded door fails honestly, with the shared error
  tokens (G8 / #1763 discipline): a capability that did not run is
  never reported as run; a degraded tool reports `executed: false` or a
  labelled placeholder, never a fabricated result.
- A turn behaves as: wake → load state → model/tool loop → persist →
  reply → hibernate. Tool results enter the conversation as facts
  (Section 8's upward flow); the turn may narrate results, not alter
  them.
- A route behaves as pure request/response: no conversational state,
  identity reconstructed per request, results returned to its caller
  only.

### 11.2 Agents

- Single-writer serialization per instance. State survives hibernation
  and eviction; in-memory fields do not (the long-running-agents
  boundary, Section 2's reference set on #2225).
- Wake sources: request, connection, RPC/callable, alarm (schedule),
  inbound email, workflow callback. `onStart` runs on cold start (only
  OrchestratorAgent defines one today).
- An agent's door methods are thin: identity in, service call out.
  Domain logic found living in an agent is a consolidation finding
  (Section 3's rule), not a pattern.

### 11.3 Services

- Idempotent where the domain allows; where it cannot be, the seam
  says so explicitly.
- Consequential actions audit — and per Q7, some may not proceed at
  all when durable audit cannot be recorded.
- Provider failure passes through the breakers: an open breaker means
  zero calls and a qualified result, not a retry storm.
- Missing configuration fails closed: `SERVICE_USER_LOGIN` unset means
  no unattended work, anywhere.

### 11.4 Engines

- Pure and deterministic (Section 8). Partial data produces a
  qualified partial with named failures — failed legs, missing fields,
  a gather failure state — never a false Complete and never a silent
  swallow (P4's D2/D3 dispositions).
- An engine never reaches out: no I/O of its own, no identity, no
  clock-dependence beyond its inputs.

### 11.5 Workflows

- Steps are memoized: a completed step never re-executes on resume; a
  failed step retries per its policy, then fails the run visibly.
- Waits are durable: event and approval waits survive eviction for
  their full timeout; a timeout is a coded outcome, not a hang.
- Fan-out collates: the parent completes when its children complete;
  child failures surface at the parent as a qualified partial
  (collation is the parent shard row's `resultJson`, ADR 0003 M10).
- Status is always queryable (D1 rows + instance status). A workflow
  with no status surface is a G6 gap — TradingTradeWorkflow today.

### 11.6 Triggers and channels

- A firing behaves exactly like a door call, with the caller's
  identity replaced by the schedule's recorded identity. A failed
  firing is audited and visible, never silent (P4 D1).
- A channel terminates on the orchestrator and becomes a turn, with
  the channel's identity/session discipline attached. A channel that
  bypasses its agent (Slack today) is a G10 defect, not an alternate
  path.

### 11.7 Behavioral patterns (the fleet's repertoire)

Named for Cloudflare's agentic-patterns reference (the #2225 reference
set, comment 6491152513):

- **Prompt chaining** — staged pipelines (feed → gather → analysis)
  where each stage's stored output feeds the next.
- **Routing** — classification at channels and doors directing work to
  the right agent or workflow.
- **Parallelization** — shard fan-out with collation (the screener);
  sectioning/voting where a task calls for it.
- **Orchestrator-workers** — the mesh's own shape: the orchestrator
  delegates to specialist agents and synthesizes their results.
- **Evaluator-optimizer** — the improvement loop's shape (Section
  7.4): a generator's output is scored by an evaluator before it may
  advance.

## 12. What RSI/ASI creates

The improvement loop (Section 7.4) is a factory with a narrow product
line. Everything it creates is an artifact in a named structure,
created by composition first and new code second — and nothing it
creates reaches production except through the gates.

### 12.1 Products, by loop stage

- **Observe creates records:** audit rows, telemetry events, traces,
  calibration samples. Structure: the one event schema, CloudEvents
  envelope, D1 + the observability dataset.
- **Evaluate creates verdicts:** golden-task results, parity outcomes,
  falsification decisions, QA findings. Structure: eval fixtures plus
  recorded results; QA failures filed as issues (today via the
  external smoke script; in-loop filing is G13).
- **Propose creates proposals:** §5 issues; PRs (code + tests +
  changelog fragment, one logical change set); WorkflowSpecs (Phase
  6); chain definitions — a goal compiled into a chain of existing
  capabilities (the capability-composition program: feed, generate,
  store, serve, deliver); synthesized schedule/goal definitions (job
  synthesis — live today); governed prompt notes (#1742); surveys,
  ADRs, and architecture documents like this one.
- **Gate creates decisions:** CI verdicts, Policy Gate results, review
  verdicts, merge and §15 completion records.
- **Actuate creates state changes:** deployments, seeded rows,
  activated flags and gateways — each an operator or pipeline action
  on a passed gate, never a loop shortcut.

### 12.2 Structures it creates in

The repository (one branch per slice, linear history); the issue
tracker (§5 template, lane hashtag); D1 projection tables; the chain
and dimension registry formats; the WorkflowSpec schema (validated by
the deterministic compiler against the registry allowlist); the
schedule catalogue; the conformance matrix and the G0 registry; eval
fixtures. A created capability is registered (G0) and exposed per
door deliberately (G12) — an unregistered creation does not exist as
far as the platform is concerned.

### 12.3 Creation behaviors

- **Compose before creating.** A goal becomes a chain of existing
  capabilities before any new code is proposed; new code is the
  residue after reuse fails.
- **Propose, never mutate.** The loop's write path is the repository
  and the tracker: no self-merge, no direct production writes, no
  runtime self-modification.
- **Evidence attached.** Every proposal carries its observations —
  file/line, run ids, falsification data. A claim without evidence is
  returned, not filed.
- **Falsification-gated.** Generated self-improvements (prompt notes,
  calibration changes) advance only when the data says current
  behavior is wrong (≥20 samples, falsification rate > 0.5), not on a
  model's say-so.
- **Human-gated at consequence.** Money, screening outcomes, trade
  execution, and capability registration keep their HITL gates no
  matter which stage proposes them.
- **Bounded and reversible.** One slice, one logical change set, git
  history as the undo. A creation that cannot be reverted cannot be
  proposed.
- **Verified after creation.** A merge is not "done": post-merge CI
  plus the §15 completion record is done (gitops §11/§15).
- **Honestly labelled.** Simulated or degraded outputs are labelled
  as such in the record (the simulated-receipt lesson behind G3). The
  loop never writes a flattering record.

### 12.4 What it does not create

Executable code from prompts at runtime (specs only, Section 9); new
agents outside a filed program (the mesh OUT list); synthetic
identities; unregistered capabilities; and — by the determinism
boundary (Section 8) — decisions in the Q7 blocking set. ASI reach,
in this platform, means wider composition and faster loops inside the
same gates, not exemption from them.
