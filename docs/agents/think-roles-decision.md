# Decision Record — Designated Think Roles

Resolves the unresolved requirement identified in
[`docs/agents/cloudflare.md`](./cloudflare.md) §2 and tracked as
finding F2 in [`think-conformance.md`](./think-conformance.md):
*no project document designated which agent roles are required to run
through Cloudflare Think (`@cloudflare/think`).*

- **Status:** owner decisions recorded 2026-10-20 — `ResearchAgent`
  and `OrchestratorAgent` are designated **Required** (the migration
  program below is committed). Remaining rows are still pending an
  owner mark; a recommendation is **not** a requirement until marked.
- **Baseline:** inventory taken at main `9c98301` (2026-10-20; the only intervening merge, PR #554, touched client CSS, not the agent inventory), `@cloudflare/think` 0.19.0,
  `agents` 0.24.0.
- **Tracking:** issue #545, epic #539.

## Inventory — every agent class, and what actually runs

### Exported from `src/server.ts` (Durable Object / Worker surface)

| Class | Base | Bound in wrangler | Loop / persistence ownership today | Role |
|---|---|---|---|---|
| `ResearchAgent` | **`Think`** | `RESEARCH_AGENT` (v5) | Think owns chat turns + tool dispatch; deterministic pipeline in `src/services/researchPipeline.ts` does the research work | Autonomous options research |
| `OrchestratorAgent` (exported as `SearchAgent`) | `AIChatAgent` | `SEARCH_AGENT` (v1) | Manual `streamText` loop, `stepCountIs` clamped 1–10 via `MAS_MAX_STEPS`; own SQLite tables (`mas_messages`, `mas_events`, `mas_memory`, `mas_reports`); LLM Judge routing; MAS tool factory (`src/agents/mas.ts`) | Top-level user chat + coordination hub |
| `BrowserAgent` | `AIChatAgent` | not bound | Manual loop; wraps `ETradeBrowserService`; instantiated by `SlackAgent` | Browser-automation trading surface |
| `SlackAgent` | `AIChatAgent` | not bound | Manual loop; wraps Slack trading service + `BrowserAgent` | Slack channel surface |
| `PaymentsAgent` (`payments-agent.ts`) | `Agent` | `PAYMENTS_AGENT` (v3) | No model loop — ledger + budget-guard state in DO storage | x402 payments / budget decisions |
| `ScheduledAgent` | `Agent` | `SCHEDULED_AGENT` (v3) | No model loop — cron-driven goals, delegates work to the orchestrator and budget checks to `PaymentsAgent` | Autonomous scheduled goals |
| `ScreenerAgent` | `Agent` | `SCREENER_AGENT` (v4) | Deterministic screening pipeline driven by schedules/routes | Stock/options screener |
| `OptionsScannerMCP` | `McpAgent` | `OPTIONS_SCANNER_MCP` (v2) | MCP server surface, no chat loop | MCP tool provider |
| `SessionStore` | `DurableObject` | `SESSION_STORE` (v6) | No model loop — session/credential storage | Storage utility |

### Not exported — and, on inspection, not referenced

`src/agents/search.ts` (`SearchAgent`), `src/agents/tasks.ts`
(`TasksAgent`), `src/agents/memory.ts` (`MemoryAgent`), and
`src/agents/payments.ts` (a second `PaymentsAgent`) are `AIChatAgent`
subclasses with small manual loops (`stepCountIs` 2–3). A full-text
search of `src/` and `tests/` finds **no import or instantiation of
any of them** — the live sub-agent behavior is the tool factory in
`src/agents/mas.ts`, invoked by the orchestrator. These classes are
legacy/prototype code that still appears in the README's architecture
description. (Name-collision hazard recorded as finding F5.)

### Naming caution

`src/services/thinkHarness.ts` implements a trade-validation reasoning
chain and predates the framework adoption; despite its name it is not
`@cloudflare/think` and does not use it. Do not cite it as Think
adoption evidence.

## Recommendations (per cloudflare.md §8 criteria)

Think is a *chat harness*: it owns the agentic chat loop, message
persistence, streaming, and tool interaction (§8C). A role gains from
designation only where that ownership replaces a hand-rolled
equivalent. Applying that test:

| Role | Recommendation | Rationale |
|---|---|---|
| `ResearchAgent` | **Required — designated Think role** | Already conformant (see think-conformance.md); designation makes the #542 conformance suite a requirement, not a snapshot. |
| `OrchestratorAgent` | **Optional — the only serious migration candidate; decide explicitly** | It is the top-level chat agent and hand-rolls exactly what Think owns (loop, persistence, streaming). It is also the most customized surface (Judge routing, MAS tools, schedules, NLQ, report publishing) and the largest agent file in the repo (2,802 lines at the assessment baseline). Migration is a program of work (path below), not a refactor — the owner should mark it Required only with that cost accepted. Until then its manual loop is a documented, bounded (step-clamped), heavily tested status quo, not a conformance violation. |
| `BrowserAgent`, `SlackAgent` | **Not planned** | Channel-specific surfaces driven programmatically, not top-level chat endpoints; their loops are thin wrappers over trading services. Revisit only if either becomes a primary conversational surface. |
| `PaymentsAgent` (DO), `ScheduledAgent`, `ScreenerAgent` | **Not planned** | No chat loop to own. Plain `Agent` is the correct base; Think designation would add a chat harness to non-chat responsibilities (§8G: unused framework features are NOT APPLICABLE, not gaps). |
| `OptionsScannerMCP`, `SessionStore` | **Not applicable** | MCP server and storage utility respectively; outside the Think profile entirely. |
| Standalone `search/tasks/memory/payments.ts` classes | **Do not migrate — remove or formally mark as prototypes** | Unreferenced code cannot be a designated runtime role. Migrating dead code to Think would manufacture conformance evidence for a path production never runs (§8A: routing must actually reach the implementation). A follow-up issue should delete them or move them under an explicit `prototypes/` banner, and correct the README's architecture section either way. |

## Migration path — only if the owner marks OrchestratorAgent Required

Sequenced, each step its own issue → PR → merge (per repo workflow);
no step starts until the previous is merged and verified.

1. **Spike (time-boxed, throwaway branch):** a `Think` subclass shell
   in a scratch file wiring `getTools()` to the existing MAS tool
   factory and `getModel()` to `resolveAiModelName`, proving the tool
   set and model resolution compose with Think 0.19. *Evidence:*
   spike notes filed on the issue; no production code changes.
2. **Parity harness:** extend the conformance suite with the chat
   contract the orchestrator must keep (the existing
   `api_chat_contract` / `api_chat_route` tests must pass against the
   Think-based class behind a flag). *Risk:* Think's persistence
   model vs the `mas_messages` schema — the spike must name the
   migration for existing conversation rows, or state that history is
   intentionally reset.
3. **Shadow implementation:** implement the Think orchestrator beside
   the current one (new class, not yet exported), route only internal
   test traffic. *Evidence:* side-by-side outputs on the judge-routing
   fixture set; step/token bounds shown equivalent or tighter.
4. **Cutover PR:** swap the `src/server.ts` export and `SEARCH_AGENT`
   class binding, keeping the class *name* stable for the existing DO
   migration chain; remove the manual loop only in this PR.
   *Risks:* DO migration mistakes are the highest-severity failure
   here — wrangler migrations must not rename the class; rollback is
   "revert the merge", which must be rehearsed in the PR description.
5. **Post-cutover verification:** live-turn smoke evidence (a real
   Think turn in `wrangler dev` or staging), reconnect/cancel
   behavior notes, and an updated conformance matrix in
   `think-conformance.md`. The §8E UNKNOWN verdicts are re-scored
   from this evidence, not from the code change alone.

Estimated shape: 5 PRs minimum, dominated by step 2–3 parity work.
The dominant risk is not the loop swap — it is conversation-state
continuity for existing Durable Object instances.

## Owner decision

Fill in one row per role. Until a row is marked, the recommendation
above is advisory and the conformance verdict for Think adoption
stays **PARTIAL** by design.

| Role | Recommendation | Owner decision (Required / Optional / Not planned) | Date |
|---|---|---|---|
| ResearchAgent | Required | Required | 2026-10-20 |
| OrchestratorAgent | Optional (migration candidate) | Required — migration program committed | 2026-10-20 |
| BrowserAgent | Not planned | | |
| SlackAgent | Not planned | | |
| PaymentsAgent (DO) | Not planned | | |
| ScheduledAgent | Not planned | | |
| ScreenerAgent | Not planned | | |
| Standalone classes (search/tasks/memory/payments.ts) | Remove or mark prototype | Removed — executed by #597 | 2026-10-20 |

Follow-up migration issues are created **only** for roles the owner
marks Required.

**Decision recorded 2026-10-20 (issue #644):** the owner marked
`OrchestratorAgent` **Required**. The five-step migration path above
is now the committed program; its step issues are created
sequentially, one at a time, beginning with the step-1 spike.
`ResearchAgent` was marked **Required** the same day (already
conformant; the designation makes the #542 conformance suite a
standing requirement).
