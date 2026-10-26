# 0005. Standardize on Cloudflare Agents SDK: actor port and AgentActorDO pattern

- Status: accepted
- Date: 2026-10-26
- Deciders: owner, CAIO-quns
- Issue: #1738 (sub-issue of tracker #1736, third in the owner's priority order)
- Implementing PR: (to be filled on merge)

## Context

Agent implementations were split across two runtimes: Agents SDK
actors (`ScreenerAgent`, `ScheduledAgent`, `PaymentsAgent`,
`ReportAssetAgent`) and procedural `Think` classes
(`OrchestratorAgent`, `ResearchAgent`, `TradingAgent` from
`@cloudflare/think`). New work had to learn both patterns, and the
procedural half could not use actor-native features (durable state,
scheduling, hibernation). The ABoK Target State Blueprint (§19,
Top-10 item 2; §12 ADR-0004 "Adoption of the Cloudflare Agents SDK",
Status Approved) directs standardizing on the Agents SDK under a
single documented `AgentActorDO` pattern, with no behavior change.

As with #1739 and #1737, the blueprint's principle #1
("Cloudflare Native First") is SUPERSEDED by owner direction for
this program: we use the Agents SDK, but behind a port, with a
second adapter and a conformance suite as independence proof — the
blueprint is the WHAT, the cloud-agnostic adapter-first rule is
the HOW (same discipline as ADR 0002 and ADR 0003).

The primary design basis is `docs/architecture/code/
component-taxonomy-01.md` §5/§11: the system sits at Agentic
Maturity Level 3 (autonomous task execution with HITL safeguards)
and the roadmap to Level 4 (closed-loop weight optimization,
dynamic prompt optimization, champion-challenger promotion,
self-healing patching) needs durable actor state as its
precondition — DO SQLite prompt registries, sandbox shadow runs.
Actor DOs with durable state are that precondition.

This slice CONSUMES #1739 (messaging port, CloudEvents v1.0
envelope, stage/job extensions) and #1737 (WorkflowPort, ADR 0004
W1–W13, stage-typed job commands, slice-2 `agent_shard_jobs` job
model) and does not reinvent any of it. It also CONSUMES, and
does not duplicate, the #1717 Adapter S5 actor-gateway port
(#1779, CISO lane — see A7).

## Decision

### A1 — Port-first actors (non-negotiable)

The actor runtime surface is a port in `src/actors/actorPorts.ts`:

- `ActorStatePort` — key-value state (`get`/`put`/`delete`) plus
  a `sql` escape hatch for the DO SQLite tables the class already
  owns (`mas_messages`, `mas_memory`, audit rows).
- `ActorSchedulePort` — schedule/scheduleEvery/list/cancel by
  method name (the SDK dispatches scheduled callbacks by method
  name; the orchestrator inventory pin keeps those names declared).
- `ActorSessionPort` — the chat transcript: `getMessages`,
  `appendMessages` (upsert-by-id, Think `saveMessages` semantics),
  `deleteMessages`, `migrateLegacyRows`, `clear`.
- `ActorTurnPort` — one method, `runTurn`. `waitUntilStable` is
  deliberately NOT in the port: it was a Think turn-lifecycle
  primitive, and the orchestrator's single caller only needs a
  best-effort "is a turn still in flight" poll, which the class
  implements privately against its own `pendingTurn` stash.
- `ActorTurnHooks` — the framework-override surface every actor
  wires: `getModel`, `getSystemPrompt`, `getTools`, `beforeTurn`,
  `onChatResponse`, `onChatError`, `maxSteps`.

Two adapters implement the port, and one conformance suite
(`tests/actor-ports-conformance.test.ts`) runs unchanged against
both: `src/actors/cfAgentsAdapter.ts` (Cloudflare Agents SDK:
session over `ctx.storage` KV, state over `ctx.storage`, schedule
delegated to the SDK scheduler, turns through the shared runner
with the production `generateText` model turn) and
`src/actors/inMemoryActorAdapter.ts` (Map/array-backed state,
schedule, and session; turns through the SAME runner with a
stubbed provider boundary — the lifecycle is not stubbed, only
the model call). `src/actors/createActorPorts.ts` is the factory
(`"cf" | "in-memory"`), mirroring `createMessagingPorts` /
`createWorkflowPorts`.

Honest boundary: the actor classes themselves import `{ Agent }`
from `"agents"` — subclassing requires it. The port rule binds
everything else: no route, service, tool, or pipeline module
imports the SDK directly; all behavior beyond the framework
overrides goes through the port. The class declaration is the
adapter; the logic is not.

### A2 — The AgentActorDO pattern (naming, state, binding)

- **Naming.** Class = role + `Agent` (`OrchestratorAgent`,
  `ResearchAgent`, `TradingAgent`, …). DO binding = `ROLE_AGENT`
  (`SEARCH_AGENT`, `RESEARCH_AGENT`, `TRADING_AGENT`, …).
  Worker export aliases exist only where a stable identity
  requires one (`OrchestratorAgent as SearchAgent`).
- **State ownership.** The DO's `ctx.storage` is authoritative
  for actor state. The chat transcript lives under
  `actor:session:message:<id>` keys plus an `actor:session:index`
  ordered-id list. The `mas_*` SQL tables stay what they were:
  audit/ledger records (`mas_messages` user/assistant rows,
  `mas_events`, `mas_memory`), NOT the transcript. No migration
  renames anything: the transcript move is a behavior-preserving
  store change, and legacy rows are lifted by A4.
- **Binding.** wrangler.jsonc `durable_objects.bindings` plus
  `migrations.new_sqlite_classes` per class, following the
  existing binding pattern. This slice changes NO binding and NO
  migration: all seven actor classes were already bound; the
  migration is class-body only, verified by the conformance
  suite's wrangler pins.
- **Scheduling.** Scheduled callbacks are declared methods on the
  class and armed by name. The orchestrator inventory pin
  (`tests/orchestrator_class_inventory.test.ts`, #992) caps the
  schedule call-sites and requires the delegated method names.

### A3 — Turn lifecycle (the shared runner)

`src/actors/actorTurnRunner.ts` (`AgentChatTurnRunner`) is the
single turn implementation for every actor that chats:

1. Normalize the input (string | message list | factory |
   `{configOverride}`) and upsert the delta into the session.
2. Run `beforeTurn` (or skip it on `configOverride`, mirroring
   the old stub's short-circuit).
3. Run one model turn: AI SDK `generateText` with the hook's
   model, system prompt, and tools, and the step bound expressed
   as `stopWhen: stepCountIs(maxSteps)` — AI SDK 7 has no
   `maxSteps` option, and this is exactly the bound Think
   enforced. `activeTools` is honored by filtering the toolset
   (empty array → no tools), not by passing an option through.
   Model messages are a text-only mapping (role + joined text
   parts); tool parts stay in the transcript at full fidelity
   and are not replayed to the model.
4. Unless an abort gate fires (A5), append the assistant message
   and fire `onChatResponse` (assistant `mas_messages` record,
   judge evaluation → `response.evaluated` audit, best-effort
   VectorMemory remember — the live streamText onFinish side
   effects, preserved).
5. On model failure, fire `onChatError` and rethrow, so the
   route's degraded-fallback handling sees the failure exactly
   as before.

### A4 — Session store and the legacy lift

The actor session store (`src/actors/actorSessionStore.ts`)
backs `ActorSessionPort` over any `SessionStorageBackend`
(`get`/`put`/`delete`). The legacy-row transform
(`legacyRowToSessionMessage`: envelope id/role/parts/metadata
through, `createdAt` from the row) moved from the #658 test
harness into production code in `actorPorts.ts`, and
`migrateLegacyRows` imports `cf_ai_chat_agent_messages` rows by
id and drops the table only on a fully clean lift — the same
semantics the orchestrator's `liftLegacyChatMessages` had under
Think, now over the actor session instead of the SDK session
store. The UIMessage shape of the transcript is unchanged.

### A5 — Abort and reset (memory-reset route)

The memory-reset route needs three Think methods that do not
exist on `Agent`: `abortAllRequests`, `resetTurnState`,
`clearMessages`. They are reimplemented on the class with
separate scopes: `abortAllRequests` bumps a turn epoch (the
runner checks it before appending the assistant message and
before `onChatResponse`, so a reset cannot land a stale turn's
side effects after the clear); `resetTurnState` clears the
in-flight `pendingTurn` stash; `clearMessages` clears the actor
transcript (transcript only — `mas_messages` audit rows are
untouched, as before).

### A6 — Envelope and job participation (no second model)

Actors participate in the vocabulary #1739 and #1737 already
defined and do not mint a new one: CloudEvents v1.0 envelopes
(`id` = idempotency key, `type`, `time`, `source`, `data`, plus
`correlationid`/`jobid`/`parentjobid`/`shardid`/`stage`
extensions), stage-typed job commands consumed from the
WorkflowPort, and the slice-2 `agent_shard_jobs` model
(one row per chain/job/version). The research dispatch label
changes with the base class: executionPath `"think"` becomes
`"agent"` (type, writer, warning text, and all readers/tests);
the primary path is still the SDK's `runAgentTool`, and the
direct-pipeline fallback is unchanged.

### A7 — S5 link: gateway vs runtime pattern (not a duplicate)

#1717 Adapter S5 (#1779, CISO lane) is the actor-GATEWAY port:
how code reaches a DO instance (dispatch + RPC behind one
interface). This ADR's actor port is the actor-RUNTIME pattern:
what the actor class is (state/session/schedule/turn facets).
They are complementary, not competing: this slice does NOT
centralize dispatch and does NOT collapse the orchestrator's
`getScreenerAgent`/`getResearchAgent` duplicates — that dedup
belongs to S5. When S5 lands, actors consume its gateway; the
port defined here is unchanged.

### A8 — S6 note: workflow-port convergence (not this slice)

#1737's disclosed follow-up "S6 workflow-port convergence"
(#1780) concerns the WorkflowPort, not the actor port. The only
convergence implication found here: actors consume WorkflowPort
commands via stage-typed job commands (A6) and need no change
when S6 converges the workflow port — the actor port's turn
facet is independent of which workflow adapter runs the job.

## Disclosed deltas (behavior changes vs the Think base)

These are deliberate, recorded here so the owner can overturn
any of them; everything else is behavior-preserving.

- **D1 — WebSocket chat transport removed.** Think's native WS
  chat went away with the base change. No in-repo client used
  it (no `useAgentChat`, no WS URL in `src/client/`); POST
  `/api/chat` + MCP JSON-RPC remain the supported chat entries.
  An external WS client would break. Follow-up if the owner
  wants it back: an AIChatAgent-based WS chat front-end.
- **D2 — Turn recovery is in-memory only.** Think sealed
  interrupted turns (`chatRecovery`, `onExhausted`); the actor
  runner does not. `pendingTurn` is in-memory and re-derived;
  POST turns are request-scoped, so a DO eviction mid-turn
  drops the turn instead of resuming it. The route's degraded
  fallback still covers the client-visible failure.
- **D3 — Session store move.** Think Sessions / ai-chat SQLite
  → actor `ctx.storage` transcript keys (A2/A4). Same UIMessage
  shape; legacy-row migration preserved as production code;
  `mas_messages` audit records unchanged.
- **D4 — Research dispatch label.** Primary path stays
  `runAgentTool` (an SDK method, not a Think method); the label
  `"think"` becomes `"agent"` everywhere (A6). Fallback direct
  pipeline unchanged.
- **D5 — `waitUntilStable` becomes a `pendingTurn` poll.**
  Same call site, same best-effort catch, same 30 s default
  timeout, 100 ms interval; returns whether the stash cleared.
  No Think turn-lifecycle primitive backs it anymore.
- **D6 — Model-turn internals.** Streaming, recovery fibers,
  and continuation coalescing collapse into a single
  `generateText` turn with the same model/tools/instructions/
  maxSteps/activeTools. WS streaming goes with D1; the HTTP
  path returns the same final text; `onChatResponse` side
  effects are preserved (A3).

## Consequences

- No `Think<Env>` agent class remains; every agent is an Agents
  SDK actor DO. The bare `@cloudflare/think` vite alias and its
  test stub are deleted; the `@cloudflare/think/workflows`
  alias stays because both workflow classes are still
  `ThinkWorkflow` by ADR 0004 W13 (the trade workflow's agent
  type parameter becomes `any`, as W13 prescribes — it never
  called agent methods).
- The test harness for agent turns is the in-memory actor
  adapter, not a framework stub: same runner, stubbed provider.
  Tests that construct real agent classes mock `"agents"` with
  a plain base class (the repo's established idiom) and carry a
  Map-backed `ctx.storage` KV plus inert schedule methods.
- The orchestrator inventory pin rises deliberately in this
  slice — the actor wiring lives on the class by necessity
  (framework overrides + lazy session/runner accessors). The
  pre-rebase tree measured 2,315 lines / 106,258 B; the rebased
  tree combined with #1724/#1725 measures 2,401 lines /
  109,911 B, so the budget is 2410 / 110_500.

## Out of scope (follow-ups, not absorbed)

- Scheduled-screen cutover (autonomousMarketScreen post-steps:
  `last_runs` UX surface, live-client `market_alert` broadcast,
  #1355 chain semantics, #1329 stage-chain stamping, #1499
  preset resolution — no workflow equivalent yet).
- Work-queue consumer starting workflows from run-screen
  envelopes + DLQ wiring (#1739 follow-up).
- MCP `chain.run` execution binding.
- #1078 enforcement flip (observe → enforce).
- Data-layer seed invokes (halt seed, canonical reports seed)
  and #1546 closure — the final program step, owner-gated.
- Changing the #1185 owner rule.
- Durable turn sealing (D2) and AIChatAgent-based WS chat (D1),
  if the owner wants either back.
- S5 gateway landing (#1779) and S6 workflow-port convergence
  (#1780) — consume/link when they land (A7/A8).
