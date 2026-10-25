# Agentic Target Architecture — Phase 2, Phase 1 Deliverable

Implements the architecture stage of
[`docs/agents/agentic-transformation.md`](./agentic-transformation.md)
(mandate sections cited as §n). Tracked by #571; this document is
issue #576. It builds on the phase-1 conformance work (#539,
[`think-conformance.md`](./think-conformance.md),
[`think-roles-decision.md`](./think-roles-decision.md)) and re-verifies
the baseline rather than inheriting its snapshot (§2).

- **Re-baseline commit:** `e6d80a0` (main, 2026-10-20).
- **Gate record (§12):** the owner instructed continuation through
  Phase 1 into Phase 2 implementation on 2026-10-20. That instruction
  is the architecture-gate approval for the Phase 2 slice specified
  in §7 of this document — and for nothing larger. Phase 3+
  increments still need their own approvals.

## 1. Re-baseline (Phase 0, folded in)

Verified at `e6d80a0` by direct inspection:

- Same 9 Durable Object / Worker exports in `src/server.ts` as the
  phase-1 inventory (Orchestrator-as-SearchAgent, OptionsScannerMCP,
  BrowserAgent, SlackAgent, PaymentsAgent, ScheduledAgent,
  ScreenerAgent, ResearchAgent, SessionStore). 18 files in
  `src/agents/`, 40 in `src/services/`, 180 test files.
- Versions unchanged: `@cloudflare/think` 0.19.0, `agents` 0.24.0,
  all dependency specs pinned (#540).
- Intervening merges since phase 1 (PRs #558–#572) were UX, CI/deploy
  hardening, and screener work — no new agent classes, no topology
  change. The phase-1 architecture findings (F1–F6) stand; F1 is
  closed, F3/F4 were closed by #542/#543, F2 is addressed by the
  allocation in §3 plus the still-open owner designation table, F5/F6
  remain open follow-ups.
- The one live delegation path is unchanged: OrchestratorAgent →
  `runAgentTool(ResearchAgent)` with a deterministic fallback
  (observable since #543) and per-tenant instance `research:<login>`.
- Coordination substrate today: synchronous RPC-style dispatch,
  DO-stored schedules, and per-agent SQLite tables. There are **no**
  durable cross-agent task records, no claiming/lease protocol, and
  no queryable record of "which execution path produced this result,
  and was the outcome ever checked?" — the gap §6 targets and the
  Phase 2 slice closes for one journey.

## 2. Design principles (from the mandate)

1. Capability allocation is a decision, not a default (§4). An agent
   is assigned only where judgment, uncertain planning,
   interpretation, or dynamic tool selection earns its cost.
2. Deterministic rules — calculations, risk limits, authorization,
   accounting, schema validation — stay in independently testable
   code (§4, §9C of the conformance plan).
3. Evaluation is independent and, wherever possible, deterministic;
   model self-assessment is never sufficient evidence (§9, §14).
4. Task state is distinct from conversation history (§6).
5. Every adaptive behavior is an explicit, recorded policy with
   budgets; the §8 never-list (expand permissions, remove approvals,
   raise spend, rewrite evaluation criteria, change production
   config, deploy, unauthorized financial actions) is absolute.

## 3. Capability allocation (§4)

| Capability | Current implementation | Target form | Rationale | Verification |
|---|---|---|---|---|
| Top-level chat & goal coordination | OrchestratorAgent (AIChatAgent, manual loop) + Judge routing + MAS tools | **Coordinator agent** (incumbent). Think designation stays an owner decision (think-roles-decision.md); this architecture does not require the migration for the Phase 2 slice | It already owns plan/decomposition in practice; the missing piece is durable task state (§5), not a new loop | Existing chat contract suites |
| Options research | ResearchAgent (Think) + deterministic `researchPipeline` service | **Domain sub-agent (already conformant)** + pipeline stays a service/tool beneath it | Judgment (tool choice, summarization) sits in the agent; discovery/economics/gates are deterministic and stay so | research-* suites, boundary test, **new: task ledger tests (#577)** |
| Stock/options screening | ScreenerAgent (Agent) + deterministic scanner services | **Deterministic service + thin agent shell (status quo)** | Screening is exhaustive rule evaluation; a model loop adds cost and variance, no judgment gap | screener suites |
| NLQ analytics | NLQ planner (model) → parameterized SQL executor | **Micro-agent (planner) + deterministic executor (status quo, formalized)** | Interpretation is judgment; execution must stay parameter-bound and read-only. The planner is recorded as a micro-agent contract in §4 | nlq suites incl. sql-injection |
| Intent routing & response evaluation (Judge) | `judge.ts` model calls inside the orchestrator flow | **Evaluator role (formalized)** | Evaluation must be independent of the implementer (§5); the Judge already is a separate call path — the change is contractual (criteria, records), not structural | judge suites |
| Search / RAG | MAS `searchKnowledge` tool + AI Search + TTL cache | **Tool (status quo)** | Retrieval is a capability agents call, not an agent | ai-search-cache, mas suites |
| Payments drafting | MAS payments tool + gateway services, human confirmation | **Tool + human decision (status quo)** | Drafting benefits from language; authorization is a human act bound to exact target/amount (§10) | payments suites |
| Payments execution (x402) | PaymentsAgent DO (Agent) + budget guard + verifier services | **Deterministic service + DO state (status quo)** | Accounting and budget enforcement must be exact and auditable; no model in the loop | agentic_payments suites |
| Trading research → execution boundary | Research (read-only) separated from order paths; thinkHarness validation service | **Deterministic validators + human decision (status quo)** | §10: never infer trade authorization from a research request; provenance and risk stay deterministic | trading-boundary, research-boundary tests |
| Tasks / memory vault | MAS tools over orchestrator SQLite (`mas_memory`) | **Tools over a governed store (status quo)**; memory policy in §6 | Storage is infrastructure; judgment about *what to remember* is a policy, recorded in §6 | memory suites |
| Scheduling / autonomous ticks | ScheduledAgent + cron triggers + schedule guards | **Durable workflow (status quo)** | Time-driven deterministic dispatch; guards already provide idempotency per slot | scheduling suites |
| Reporting & delivery | `scheduledReports`, PDF/email/Slack delivery services | **Service (status quo)** | Rendering/delivery is deterministic; content originates upstream | reports suites |
| Browser / Slack channels | BrowserAgent, SlackAgent (AIChatAgent) | **Channel adapters (status quo)** — revisit only if one becomes a primary conversational surface | Channel protocol handling, not domain judgment | browser/slack suites |
| MCP tool provision | OptionsScannerMCP (McpAgent) | **Infrastructure (status quo)** | — | mcp suites |

Net topology change from this allocation: **zero new agent classes.**
The transformation's substance is contractual and coordinative —
durable task state, explicit evaluator contracts, recorded execution
paths — not a larger agent count (§14: agent count is not a success
criterion).

## 4. Target topology and agent catalog (§5)

```
Coordinator: OrchestratorAgent
  ├─ delegates (runAgentTool, task-ledger tracked) ─► ResearchAgent [Think]
  ├─ tools: MAS factory (search, payments-draft, tasks, memory, NLQ)
  ├─ evaluator: Judge (routing + quality/safety, independent criteria)
  ├─ micro-agent: NLQ planner (interpretation only; executor is code)
  └─ workflows: ScheduledAgent ticks, screener runs (deterministic)

Non-agent DOs/services: PaymentsAgent (ledger/budget), ScreenerAgent
(shell over deterministic scanners), SessionStore, OptionsScannerMCP.
```

Contracts (abridged to decision-relevant fields; full §5 fields are
recorded for the two roles the slice touches):

**ResearchAgent (domain sub-agent, existing)** — Purpose: read-only
options research per tenant. Non-goals: any order path (boundary-test
enforced). Identity: `research:<userLogin>`. Inputs: `{trigger,
userLogin}` via agent-tool or RPC. Outputs: typed `ResearchReport`
(runId, generationId, ideas/watchlist/rejected counts, summary).
Limits: exactly one pipeline call per request (system prompt);
pipeline gates come from `ResearchConfigService`. Recovery: the
coordinator's deterministic fallback (§7). Evaluation: §9
price-based evaluation (`evaluateRun`) plus the slice's deterministic
outcome evaluation (§7).

**Coordinator task ledger (new in the slice)** — not an agent: the
coordination substrate of §5/§6, owned by the coordinator role and
stored with the delegate (ResearchAgent DO) so a task record and the
work it tracks live and die together.

## 5. Coordination design (§6)

State model for delegated tasks (implemented for research in #577;
the pattern is the template for later delegations):

```
queued ─► claimed ─► running ─► completed
                            ├─► failed ─► escalated
queued/claimed ─► cancelled
```

- **Durable records:** one JSON record per task in the delegate DO's
  SQLite (key/value store table, the repo's mas_settings idiom),
  with a transition history array — task state is never inferred
  from conversation history.
- **Claiming:** the delegate DO is a single serialized instance per
  tenant, so check-and-set transitions inside a DO method are atomic
  for that tenant's tasks; no external lock service is justified
  (§6 "or equivalent ownership control").
- **Deduplication:** an idempotency key
  (`research:<trigger>:<login>:<previousRunId>`) maps to at most one
  *active* task; duplicate dispatches to produce the successor of
  the same report return the existing task instead of double-running.
- **Leases/staleness:** tasks carry `heartbeatAt`; a running task
  whose heartbeat is stale is *visible* as such to operators. The
  slice does not auto-reap (scheduled research already has its own
  slot guard); auto-recovery is a Phase 3 decision with evidence.
- **Artifacts:** a completed task references its report by immutable
  `runId` (reports are append-only in `mas_reports`); the record
  distinguishes the execution path taken (`think` | `fallback`).
- **Cancellation:** defined at the state level (queued/claimed);
  cancelling a running research task is not supported (runs are
  short and read-only) — stated plainly rather than implied.
- **Review loops:** evaluation (§7) is one pass, deterministic, with
  the verdict stored on the task; there is no unbounded rework loop.

## 6. Memory design (§7)

Existing stores already separate the mandate's categories; the
design records the mapping and the policies that were implicit:

| Category | Store today | Policy |
|---|---|---|
| Current-turn context | Think/AIChatAgent session state | Ephemeral to the turn; never a system of record |
| Task working state | Task ledger (#577), DO SQLite | Attributable to a task id; retained with run history |
| Conversation history | `mas_messages` (orchestrator SQLite) with nightly retention pass | Existing retention cron is the policy of record |
| Durable user/tenant facts | `mas_memory` vault; `research_settings` per tenant instance | Tenant-scoped by DO instance id; no cross-tenant reads by construction |
| Reusable domain knowledge | AI Search index; `mas_reports` canonical reports | Reports carry runId/generation provenance |
| Evaluation & improvement records | `research_evaluations`; task-ledger evaluations (#577) | Append-only; verdicts cite the artifact revision evaluated |

Rules: retrieved memory is evidence, not instructions; speculative
model conclusions are not stored as facts (research reports store
source-backed fields with quote provenance); corrections happen by
superseding records, not silent edits.

## 7. Phase 2 slice specification (issue #577)

**Journey:** a research run (manual or scheduled) from coordinator
dispatch to a stored, evaluated task record.

**Components:**
1. `src/services/researchTaskLedger.ts` — SDK-free service over an
   injected `{get,set,list}` store (the `ResearchConfigService`
   idiom): task creation with idempotency dedup, validated state
   transitions, heartbeat, completion with path + evaluation,
   failure + escalation, and a pure deterministic
   `evaluateResearchOutcome` (checks: report present, runId fresh vs
   previous, trigger match, login match, summary present, counts
   non-negative; verdict = all checks pass).
2. ResearchAgent: ledger persisted in a new `research_task_store`
   table (created in `ensureTables` alongside the existing research
   tables — no wrangler migration, matching precedent); methods
   `createResearchTask`, `beginResearchTask`, `completeResearchTask`,
   `failResearchTask`, `getResearchTask`, `listResearchTasks`.
3. Orchestrator `runResearchAndPublish`: create + begin a task
   before dispatch; complete it on success with the path actually
   taken and the deterministic evaluation; on total failure, fail +
   escalate the task. Ledger failures are warned and never break the
   research flow. Result gains additive optional `taskId` and
   `executionPath` fields.

**Baseline vs after (the §12 Phase 2 gate evidence):**

| Property | Before | After |
|---|---|---|
| Durable record that a run happened | Only the report row itself | Task record with full transition history |
| Which path executed (Think vs fallback) | A log line (#543) | Queryable field on the task + result |
| Outcome checked against expectations | Not systematically | Deterministic evaluation stored per task |
| Duplicate dispatch to produce the same successor report | Possible | Deduped while a task is active |
| Total failure | An error return; nothing persists | Task in `escalated` state, awaiting a human |

## 8. Permissions and safety (§8, §10)

The slice changes no permission boundary: research stays read-only,
no new tools are granted to any agent, no payment or trading path is
touched, and the ledger is writable only by the coordinator →
delegate call path inside the user's own tenant instance. Adaptation
in the slice is limited to the pre-existing, now-recorded fallback
policy. Everything on the §8 never-list remains unimplemented by
design.

## 9. Risks and open decisions

- **R1 — Ledger write on the hot path.** Mitigated by warn-and-
  continue; the research result never depends on ledger success.
- **R2 — Dedup key semantics.** Keyed to the previous report, so two
  *intentionally distinct* manual runs in a row still create two
  tasks (the second's predecessor differs once the first completes);
  a manual run racing itself dedups. Accepted for the slice.
- **R3 — Orchestrator Think designation** remains an owner decision
  (think-roles-decision.md). This architecture is deliberately
  neutral to it: the ledger pattern works identically whether the
  coordinator's loop is manual or Think-owned.
- **R4 — Stale running tasks** are observable but not auto-recovered
  (see §5). Phase 3 may add reaping with operational evidence.

## 10. What this architecture does not do

No new agent classes; no migration of deterministic services into
model loops; no external coordination infrastructure; no bounded-
adaptation policies beyond the existing fallback; no improvement
pipeline (Phase 5 of the mandate remains future, gated work).
