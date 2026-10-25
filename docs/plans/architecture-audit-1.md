# Architecture Audit — Issue #1: Architecture and Design Principles

_Audited 2026-10-20 by Muse (CPO-amuse-dhmp). Repo: OpenAIMP/cfagent @ main. Scope: `src/` (250 TS files). Audit only — no code changed._

## 1. Architecture Map

```
┌─────────────────────────────────────────────────────────────┐
│  ENTRY: src/server.ts (1,416 lines)                         │
│  Worker fetch/scheduled/websocket handlers; thin dispatch   │
└──────────────┬──────────────────────────────────────────────┘
               │ routeAgentRequest
               ▼
┌─────────────────────────────────────────────────────────────┐
│  OrchestratorAgent (src/agents/orchestrator.ts, 3,429 lines)│
│  Front Controller: 50 route-handler delegations, 171 pinned │
│  routes (thin_router_inventory.test.ts). Owns durable       │
│  schedules (9 baselines). Extends Think.                     │
└──┬──────────┬──────────┬──────────┬─────────────────────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌──────┐ ┌─────────┐ ┌────────┐ ┌──────────────────┐
│19    │ │Screener │ │Research│ │ routes/*.ts (19) │
│route │ │Agent    │ │Agent   │ │ per-domain       │
│hdlrs │ │(DO)     │ │(Think) │ │ handlers         │
└──┬───┘ └────┬────┘ └────┬───┘ └────────┬─────────┘
   │          │           │              │
   └──────────┴─────┬─────┴──────────────┘
                    ▼
┌─────────────────────────────────────────────────────────────┐
│  DOMAIN: src/trading/ (boundary: index.ts, #290)            │
│  ITradingPlatform, ETradeTradingPlatform, ETradeRestClient   │
│  (3,361 lines), screenerPipeline, options/*, universes,     │
│  setupCatalog, riskPolicyEngine (4-limit pure check)         │
├─────────────────────────────────────────────────────────────┤
│  SERVICES: src/services/ (60+ modules)                      │
│  ETradeService (facade over trading platform), scheduledTasks│
│  (2,059), fossResearch (3,029), researchPipeline, learnings, │
│  reflection, strategyReviews, reportSemanticIndex, etc.      │
├─────────────────────────────────────────────────────────────┤
│  INFRA: src/orm (DO-SQLite), src/events (typed bus +        │
│  publishers), src/security, src/patterns (Facade/Observer/  │
│  Strategy), src/mcp, src/a2a, src/models (router)            │
├─────────────────────────────────────────────────────────────┤
│  CLIENT: src/client (126 files, React)                      │
└─────────────────────────────────────────────────────────────┘
```

**Dependency directions (verified by grep):**
- `src/trading/*` never imports from `src/services/*` — the #290 boundary holds, with one smell (see Finding #4).
- `src/agents/routes/*` imports `ETradeService` from `src/services/etrade` (15 files) — services layer is the integration point for routes.
- `src/server.ts` imports from `./trading` (barrel) — respects the boundary.
- `src/events/screenerPublishers.ts` is the delivery fan-out (Slack A2A / email / webhook) subscribed to the typed event bus.

## 2. Prioritized Findings

### F1. Two divergent RiskPolicyEngines — and the tested one is dead code (HIGH — correctness risk)
- `src/services/riskPolicyEngine.ts` (23KB, 8-rule autopilot envelope: kill-switch, drawdown, orders/day, max-position, cash-reserve, universe allowlist…)
- `src/trading/riskPolicyEngine.ts` (3.4KB, #79: 4-limit pure `check()` — maxPositionNotional, maxDailyLoss, maxPortfolioHeat, allowedActions)
- Verified 2026-10-20: `autopilot.ts`, `etradeBroker.ts`, and `orchestrator.ts` all import the **services** engine. The **trading** engine is exported through `src/trading/index.ts` but imported by **zero** production modules — the pure, tested #79 engine gates nothing.
- **Risk: an operator changes limits in one engine while the other enforces; the 6-test suite on the trading engine verifies code that never runs.**

### F2. No factory / DI for ETradeService (HIGH — testability, DIP)
- 60 `new ETradeService(...)` call sites across routes, agents, services.
- Constructor takes an `ormOrEnv: DatabaseORM | Env` union and sniffs `"trades" in ormOrEnv` at runtime to decide which overload was called (documented workaround in AGENTS.md, but still a runtime type-switch in a constructor).
- Every caller hard-codes the concrete class; there is no `IETradeService` abstraction, no factory, no seam for testing except constructing the real thing with mock env.
- Same pattern for `ETradeRestClient` (constructed inside `ETradeService` and directly in routes).

### F3. fossResearch.ts is a 3,029-line mixed-responsibility module (MEDIUM)
- Contains: Yahoo crumb-session auth, RSI/MACD math (`computeRsi14`, `computeMacd`), three `IFossMarketDataProvider` implementations (Yahoo/Alpaca/Hybrid — good Strategy pattern use), and `FossResearchService`.
- The indicator math is imported by `src/trading/yahooHistory.ts` — a trading module reaching into services for pure math. Indicators belong in `src/trading/` (or `src/shared/`), not in a market-data-provider module.
- The provider Strategy trio is well-designed; the file just also hosts unrelated utilities that grew there by convenience.

### F4. Indicator math lives in services, not trading (MEDIUM — boundary erosion)
- `computeRsi14` / `computeMacd` defined in `src/services/fossResearch.ts`, consumed by `src/trading/yahooHistory.ts`.
- The #290 boundary says trading code goes through `src/trading/index.ts`; this is the reverse — trading depending on services for domain math. Small today, but it sets the precedent that the boundary is permeable for "just a helper."

### F5. scheduledTasks.ts: 7 cron jobs in one 2,059-line class (MEDIUM)
- `ScheduledTasksService` hosts `autoRenewETradeTokens`, `autonomousMarketScreen`, `autonomousOptionsAnalysis`, `autonomousStrategyDiscovery`, `collectDailyIvHistory`, `dispatchReminder`, `expireStaleOrderDraft`.
- Each job is a separate responsibility with separate failure modes; a bug in one job's imports can break the module load for all seven. The class is a job *registry* that also *implements* every job.

### F6. NLQ execution has 3 public entry points (LOW — API clarity)
- `executeNLQQuery` (sync), `executeNLQQueryAsync`, `executeNaturalLanguageQuery` (facade used by callers) in `src/agents/nlq/execution.ts` (1,865 lines).
- Callers correctly use the facade; the other two are historical variants. Not a runtime problem, but the module's public surface suggests three ways to do one thing.

### F7. Orchestrator is now a proper Front Controller (POSITIVE — no action)
- Post-#359: 3,429 lines, but the bulk is 50 route-handler delegations with 171 pinned routes. The dispatch table is the architecture; each route file owns its domain. This is the right shape — do not "fix" the line count.

### F8. types.ts at 1,666 lines / 104 exported types (LOW — watch)
- Central type registry. Acceptable for a Workers codebase (Env type must be centralized), but new domain types should live with their modules and be re-exported, not added here by default.

## 3. Refactor Sketches (top 3 findings)

### F1: Unify the policy engines
1. Decide authority. The evidence says the **services** engine is the live one (3 importers); the **trading** engine is dead code despite its test suite. Either wire the trading engine into the order path (replacing the services engine's overlapping rules) or delete it.
2. Recommended: keep the pure `check()` kernel from the trading engine, port the services engine's 8 autopilot rules into it as named rule modules, and repoint the 3 importers. One file, one verdict.
3. Delete the loser. Add a repo rule: a second file named `riskPolicyEngine.ts` fails CI (or at minimum, a test asserting every `riskPolicyEngine` import resolves to the same module).

### F2: Introduce an ETradeService factory
1. Define `IETradeService` (the subset of methods routes actually call — likely `getQuotes`, `getOptionChains`, `previewOrder`, `placeOrder`).
2. Add `createETradeService({ orm, env, userLogin, overrideEnv })` in `src/services/etrade.ts` — named parameters kill the union-sniffing constructor overload.
3. Keep the constructor for one release; migrate the 60 call sites file-by-file (mechanical).
4. Tests can then substitute a fake `IETradeService` without constructing the real client — this unblocks hermetic route tests.

### F3: Split fossResearch.ts
1. Move `computeRsi14`, `computeMacd`, and any other pure math to `src/trading/indicators.ts` (new) or `src/shared/`; update the two import sites.
2. Move the three providers + `IFossMarketDataProvider` to `src/services/marketdata/` (providers + interface together).
3. Leave `FossResearchService` orchestration in `fossResearch.ts` (~400 lines after the split).

## 4. Decision Record

**Patterns used well (keep):**
- **Strategy** — `IFossMarketDataProvider` (Yahoo/Alpaca/Hybrid), `IPaymentGatewayStrategy` + `PaymentStrategyFactory`, `ITradingPlatform` registry. Each has ≥2 real implementations and the abstraction earns its keep.
- **Observer** — `AuditEventPublisher`/`IAuditObserver` in `src/patterns/observer.ts`; the typed `screenerEvents` bus + `screenerPublishers` fan-out. Delivery channels attach without touching publishers.
- **Facade** — `McpSystemFacade`, `ETradeService` (as integration facade), `executeNaturalLanguageQuery`. Each simplifies a subsystem behind one entry point.
- **Front Controller** — OrchestratorAgent's dispatch table with the 171-route inventory pin (`thin_router_inventory.test.ts`). The pin is load-bearing; every new route must be added there.
- **Repository** — `DatabaseORM` repositories per table over DO-SQLite.

**Considered and rejected:**
- **Abstract Factory for broker clients** — only E*TRADE exists (Alpaca is data-only). Revisit when a second order-execution broker lands.
- **Mediator for agent communication** — the event bus already covers pub/sub; a mediator would add indirection without a second use case.
- **Splitting OrchestratorAgent further** — it's a dispatcher, not a god class, post-#359. Line count alone is not the smell.

**Deliberate gaps (leave alone):**
- **No DI container** — Workers cold-start budget and the codebase's explicit-construction style make a container heavier than the 60-call-site factory fix (F2).
- **types.ts centralization** — the `Env` type must be ambient-central in Workers; splitting it would fight the platform.
- **Client/ (126 files) un-audited here** — UI architecture is a separate audit; the service boundary it consumes is sound.

## 5. Verification notes
- All findings grounded in `grep`/`wc` over the repo at main (2026-10-20). No code was modified.
- Boundary claim (#290) verified: zero imports from `src/services/etrade` inside `src/trading/` (grep, 2026-10-20).
- `new ETradeService(` count: 60 non-test call sites.
- The two `riskPolicyEngine.ts` files differ in content (not copies).
