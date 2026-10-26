# Scan appendix (q) — Cloudflare-coupling inventory — parent #1717

## Agent

#CISO-bhdm

Main doc: `docs/compliance/system-duplicates-scan-1717.md`. Parent issue: **#1717**
(system-wide duplicate/overlap unification program, successor to #1638).
This appendix is the follow-up the main doc promised: the coupling-inventory
scan (`~/workspace/tmp-issues/scan-cloudflare-coupling.md`, read-only, no repo
changes) did not exist when the scan doc PR (#1719, merged `ba75988`)
published, so the main doc PR was not reopened for it. This appendix publishes
that inventory here, with every site mapped to its remediation slice.

Location note (owner-directed exception for this program's scan reports ONLY):
this report lives in `docs/compliance/`, not the usual
`docs/architecture/security/`. The file name carries the parent issue number.

## Directive (owner, 2026-10-26, verbatim in substance)

CLOUD-NATIVE BUT CLOUD-AGNOSTIC. No direct use of Cloudflare infrastructure
in application code — always layered with adapters. Application code must not
import or call provider SDKs/bindings directly; all provider access lives in
adapter modules. One interface per capability, Cloudflare as ONE adapter
behind it. Migration is incremental per slice — explicitly NOT a big-bang
re-platforming and NOT a hosting change: deployment stays on Cloudflare
(wrangler, deploy.yml) unless the owner separately directs a migration. This
does not override the program's Security Guard (enforcement fail-closed,
admin-controlled) or the never-either/or configurable rule. Adapter selection
follows the same execution-context scoping (run > session > user > global env
> built-in default) where a capability has multiple adapters; scoped selection
never lets a caller disable its own enforcement.

## Scan provenance

- Repo: OpenAIMP/cfagent. Base scanned: `c06da3b6063e7824ccc425389bb0c9315ab4ec28`
  (`feat: HH/HL Regime Classification (UP/DN/RNG) gate (#1654 slice 5/8)`),
  shallow read-only clone, 2026-10-26.
- Method: grep over `src/**/*.ts` for every binding declared in
  `wrangler.jsonc` and `src/types.ts` (`Env`), plus `cloudflare:workers`
  imports, `agents`-SDK surface, `scheduled`/`queue`/`email` handlers, and
  R2/AI/Vectorize/D1/DO-SQLite call shapes. Each hit was read in context
  before classification. `src/client/**` UI adapters are NOT Cloudflare
  coupling and are excluded. Tests are excluded.
- Counting unit: one site = one call block / operation (one dispatch, one RPC
  acquisition+call, one put/get/delete op, one handler), not one source line.
  A dispatch spanning `idFromName` + `get` + `fetch` lines counts once and
  cites the block's start line. Line numbers are scan-base lines; file paths
  are the stable identifiers for slice scoping — re-verify lines at slice
  start, as later merges may have shifted them.

## Classification rules (applied uniformly)

- **ADAPTER-IMPLEMENTATION (not a finding):** binding use INSIDE the module
  that implements the capability's interface (e.g. R2 calls inside
  `reportBlobStore.ts`, D1 calls inside `src/data/d1*Adapter.ts`, DO-SQL
  inside `SessionStore`, `ai.run` inside `VectorMemory`). The module IS the
  Cloudflare implementation of the interface.
- **ALREADY-BEHIND-ADAPTER (not a finding, listed in §D):** a call site that
  only passes a binding as a constructor/factory argument to an existing
  adapter, with every subsequent operation going through that adapter's
  interface. The binding still textually appears at these wiring sites, so
  they are listed — a future thin "env wiring" slice could centralise them —
  but they are not direct-use findings.
- **DIRECT-USE (a finding):** application/route/service/DO code that invokes
  the provider API itself (`idFromName`/`get`/`fetch`, `.run`, `bucket.put/
  get/delete`, `ASSETS.fetch`, `runWorkflow`/`sendWorkflowEvent`,
  `scheduled`/`queue`/`email` handlers, inline `sql.exec` outside a store).

## Existing adapter patterns REUSED (no new framework invented)

Remediation reuses only patterns already in the tree:

- **Ports pattern** — `src/data/*Ports.ts` + `d1*Adapter.ts` +
  `inMemory*Adapter.ts` (domain code depends only on the port interface; D1
  is one implementation).
- **`DoNamespaceLike` / `KvLike`** — `src/security/durableKv.ts` (DO-backed
  KV behind a provider-neutral `get/put/delete/list` shape).
- **`SqlStorage`-style store injection** — `src/orm/index.ts` plus
  `SqlScanRunStore`, `SqlStrategyProfileStore`, etc. (DO SQL passed as a
  constructor argument; 45 such constructions counted).
- **`VectorMemory`** — `src/memory/vector-memory.ts` (AI + Vectorize behind
  `remember` / `recallForPlan`).
- **`getWorkersAIModel`** — `src/agents/model.ts` via `workers-ai-provider`
  (`createWorkersAI({ binding: env.AI })`); plus `runWithRouting` in
  `src/models/router.ts`.
- **`IPaymentGatewayStrategy` / `PaymentGatewayService`** —
  `src/patterns/interfaces.ts`, `src/services/payments.ts` (covers EXTERNAL
  gateways only — Stripe/PayPal/LemonSqueezy — NOT the internal
  PaymentsAgent-DO `budgetCheck` RPC; see slice S5).
- **`IFossMarketDataProvider` / `FossResearchService`** and the
  `MarketDataService` facade (`resolveMarketDataQuotes`,
  `src/services/marketDataService.ts`): these abstract MARKET DATA, not
  Cloudflare bindings — no Cloudflare binding was found inside the market
  data path except R2 via `captureStore` (counted under blob storage). They
  are not Cloudflare adapters and need no change for this program.
- **`serveStaticAsset`** — `src/security/staticAssets.ts` (wraps
  `ASSETS.fetch`; used at `src/server.ts:316` for the pre-route check).

## Counts table by capability

| Capability | DIRECT-USE sites | ALREADY-BEHIND-ADAPTER sites | Adapter interface today | Remediation slice |
|---|---:|---:|---|---|
| DO dispatch — `stub.fetch` addressing (SEARCH/SCREENER/SESSION/SCHEDULED_AGENT) | 29 | 0 | NONE | #1779 (S5) |
| DO RPC — typed stub method calls (budgetCheck, getPdfByKey, getScreener/ResearchAgent) | 6 | 0 | NONE | #1779 (S5) |
| DO-SQLite — inline `sql.exec` outside a store | 2 | 45 store constructions (pattern) | PARTIAL (`SqlStorage` + `*Store` classes) | #1776 (S2) |
| Workers AI inference — direct `env.AI.run` | 3 | 2 call paths (guards + `getWorkersAIModel`) | SINGLE EXISTS (`getWorkersAIModel`), bypassed 1× | #1775 (S1) |
| AI Search HTTP endpoint — direct `fetch` | 1 | 0 (client module exists, bypassed) | ONE CLIENT MODULE (`services/aiSearch.ts`), bypassed | #1775 (S1) |
| Vectorize — direct `upsert`/`query` (via `reportSemanticIndex`) | 2 | 4 `VectorMemory` constructions | SINGLE EXISTS (`VectorMemory`), bypassed 1 module | #1775 (S1) |
| Blob / object storage — R2 `put`/`get`/`delete` inline | 6 | 9 `reportBlobStore` consumer call sites | SEVERAL COMPETING (see §R2) | #1777 (S3) |
| Static assets — `ASSETS.fetch` | 2 | 1 helper use (`server.ts:316`) | HELPER EXISTS (`serveStaticAsset`), bypassed 2× | #1775 (S1) |
| Email sending — `EMAIL.send` | 1 | 0 | NONE | #1778 (S4) |
| Browser rendering — `BROWSER.fetch` | 1 | 0 | NONE | #1778 (S4) |
| Durable workflows — `runWorkflow` / `sendWorkflowEvent` | 2 | 0 | NONE | #1780 (S6) |
| Platform entrypoints — `scheduled` / `queue` / `email` handlers | 3 | 0 (handlers are the seam) | NONE POSSIBLE (see S8) | No slice (§E) |
| Session/credential/API-key store — `SESSION_STORE` | 0 | 8 handoff lines | SINGLE EXISTS (`durableKv` `KvLike`) | No slice; wiring only in #1781 (S7, decision) |
| Relational projection — D1 `AGENT_DB` | 0 | 7 factory/call sites | SINGLE PORT FAMILY EXISTS (`*Ports` + D1/inMemory adapters) | No slice (§E) |
| **TOTAL (counted sites)** | **56** | — | — | — |

## Bindings inventory (deployment, not application coupling)

Declared in `wrangler.jsonc` (deployment fact only): `SEARCH_AGENT`,
`OPTIONS_SCANNER_MCP`, `PAYMENTS_AGENT`, `SCHEDULED_AGENT`,
`SCREENER_AGENT`, `RESEARCH_AGENT`, `SESSION_STORE`, `REPORT_ASSET_AGENT`,
`TRADING_AGENT`, `ORCHESTRATOR_AGENT`, `AGENT_DB` (D1 `agentdb`),
`REPORTS_BUCKET` (R2 `screener`), `AI`, `VECTOR_MEMORY` (Vectorize
`vector-memory`), `ASSETS`, `TRADE_WORKFLOW` (workflow
`trading-trade-workflow`), cron triggers `0 3 * * *`, `*/30 * * * *`,
`0 4 * * *` (the 21:00 UTC research run and weekly jobs deliberately ride
the `*/30` tick — Workers Free 5-trigger ceiling, error 10072).
`wrangler.jsonc` and `.github/workflows/deploy.yml` (wrangler deploy,
Vectorize provisioning, legacy KV-ID sed) are deployment, not findings.

Declared ONLY in `src/types.ts` (`Env`), NOT in `wrangler.jsonc`:
`EMAIL`, `BROWSER`, `KV` (`KVNamespace`), `BROWSER_AGENT`,
`SLACK_AGENT`, `TASKS_AGENT`, `MEMORY_AGENT`, `VECTORIZE`, plus
`ORCHESTRATOR_AGENT` (optional; `src/types.ts` notes no code reads it —
the agents SDK resolves via `ctx.exports`, not `env`).

Bindings with NO `env.*` read found in `src/` (class exists; SDK-resolved
or dormant): `REPORT_ASSET_AGENT`, `TRADING_AGENT`,
`OPTIONS_SCANNER_MCP`, `ORCHESTRATOR_AGENT`, `BROWSER_AGENT`,
`SLACK_AGENT`, `TASKS_AGENT`, `MEMORY_AGENT`, `KV` (see KV note below),
`VECTORIZE`.

Notable negatives (verified by grep, not assumed):

- **No `getAgentByName` anywhere** in `src/` — DO addressing is via
  `env.<NS>.idFromName` / `idFromString` + `.get`, and via the agents SDK
  (`routeAgentRequest` in `src/server.ts:96`, `ctx.exports`).
- **No live Workers KV use:** only `KV_…_KEY` key-name constants and the
  dormant `legacy` option in `durableKv.ts`; `env.KV` is never read.
  KV is a dead declaration, not a capability to adapt (hygiene note only).
- **No Queues producer binding:** no `env.<QUEUE>.send` exists. The
  `queue()` handler in `src/server.ts` is a consumer only; queue
  producers, if any, are outside this repo's Worker code.
- **No direct D1 `.prepare`/`.batch` outside `src/data/`** — all D1 access
  goes through the `create*Ports` factories (behind-adapter).

## (A) Full DIRECT-USE site table (findings)

### D1. DO dispatch — `idFromName`/`idFromString` + `get` + `stub.fetch` (29) → #1779 (S5)

All in `src/server.ts` `handleFetch` unless noted. Each row is one forward
block; the route label is the nearest route guard above the block.

| File:line | Binding / API | Notes |
|---|---|---|
| `src/server.ts:269` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | NLQ webhook → `/nlq` |
| `src/server.ts:1242` | `env.SEARCH_AGENT.get(idFromName(SHARED_ORCHESTRATOR_INSTANCE))` | Shared-orchestrator stub, `/api/governance/seed-halt` block |
| `src/server.ts:1412` | `env.SEARCH_AGENT.get(idFromName(SHARED_ORCHESTRATOR_INSTANCE))` | Shared-orchestrator stub, `/api/jobs/reconcile` block |
| `src/server.ts:1602` | `env.SEARCH_AGENT.get(idFromName(SHARED_ORCHESTRATOR_INSTANCE))` | Shared-orchestrator stub, `/api/reports/seed-canonical` block |
| `src/server.ts:1840` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/mcp` forward block |
| `src/server.ts:1928` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/payments/agentic/*` |
| `src/server.ts:1963` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/premium/*` (incl. `PREMIUM_GATEWAY_INSTANCE` branch) |
| `src/server.ts:1981` | `env.SEARCH_AGENT.get(id)` + `fetch` | `/api/payments/webhook`, `system_webhook_receiver` instance |
| `src/server.ts:2000` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/trading/email/inbound` |
| `src/server.ts:2033` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/trading/email/approve` (GET) |
| `src/server.ts:2060` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/trading/slack/test` |
| `src/server.ts:2099` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/trading/voice/turn`, `/api/trading/voice/test` |
| `src/server.ts:2111` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/trading/voice/greeting` |
| `src/server.ts:2129` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/trading/options/*`, `/trading/options/*` |
| `src/server.ts:2146` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/schedules` |
| `src/server.ts:2239` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/browser/transaction-snap` (+ aliases) |
| `src/server.ts:2262` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/slack/commands`, `/slack/slash` (`slack_<teamId>` instance) |
| `src/server.ts:2293` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | Slack events (`slack_<teamId>` instance) |
| `src/server.ts:2393` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/slack/interactions` (`slack_<teamId>` instance) |
| `src/server.ts:2456` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/trade/approve` |
| `src/server.ts:2478` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/clear`, `/reset`, `/api/clear`, `/api/reset` |
| `src/server.ts:2610` | `env.SEARCH_AGENT.idFromName` + `get().fetch` | `/api/*` fallthrough |
| `src/server.ts:2743` | `env.SEARCH_AGENT.idFromName` + `get` | `scheduled()` — shared orchestrator for research/reflection/weights/retention dispatches |
| `src/server.ts:2749` | `env.SCHEDULED_AGENT.idFromName("default")` + `get().onCron()` | `scheduled()` — `*/30` tick |
| `src/server.ts:2841` | `env.SEARCH_AGENT.idFromName` + `get` | `queue()` — `options_analysis` messages → `/schedules/trigger-options-analysis` |
| `src/agents/routes/payments.ts:764` | `ctx.env.SEARCH_AGENT.get(idFromString(owner))` + `fetch` | Webhook settlement routing to owning instance |
| `src/trading/email/agent.ts:1116` | `env.SEARCH_AGENT` + `idFromName` + `fetch` | Inbound-email forward to owning orchestrator (fail-loud without binding, #815) |
| `src/trading/voice/agent.ts:1062` | `env.SEARCH_AGENT` + `idFromName` + `fetch` | Voice-turn forward to orchestrator (`/trading/voice/turn`) |
| `src/services/cloudflareWalletsScanner.ts:222` | `this.env.SEARCH_AGENT.idFromName` + `get().fetch` | `OptionsScannerMCP.forwardToOrchestrator` (own ctx id) |

### D2. DO RPC — typed stub method calls (6) → #1779 (S5)

| File:line | Binding / API | Notes |
|---|---|---|
| `src/agents/scheduled-agent.ts:284` | `env.PAYMENTS_AGENT.idFromName("default")` + `get().budgetCheck()` | Goal tick budget check (inline stub type, no interface) |
| `src/agents/scheduled-agent.ts:983` | `this.env.PAYMENTS_AGENT.idFromName("default")` + `get().budgetCheck()` | Chain-fire budget check (duplicate of above — same RPC, second call site) |
| `src/agents/orchestrator.ts:332` | `this.env.SCREENER_AGENT.idFromName` + `get()` → `ScreenerAgent` | `getScreenerAgent()`; callers invoke `getPdfByKey`, `sweepStaleScreenerTasks`, etc. (`orchestrator.ts:246,250,556`) |
| `src/agents/orchestrator.ts:356` | `this.env.RESEARCH_AGENT` + `idFromName` + `get()` → `ResearchAgent` | `getResearchAgent()`; callers at `orchestrator.ts:549,564` |
| `src/services/scheduledTasks.ts:411` | `(this.env as any).SCREENER_AGENT.idFromName` + `get()` | Second `getScreenerAgent()` implementation (duplicates orchestrator's — also a duplication finding for the other lane) |
| `src/events/screenerPublishers.ts:66` | `(deps.env as any).SCREENER_AGENT` + `get().getPdfByKey()` | `fetchScreenerPdf` — stub method call, not `fetch` |

### D3. DO-SQLite inline exec (2) → #1776 (S2)

| File:line | Binding / API | Notes |
|---|---|---|
| `src/agents/orchestrator.ts:491` | `this.ctx.storage.sql.exec` | `liftLegacyChatMessages` — `sqlite_master` probe + legacy message lift |
| `src/agents/orchestrator.ts:1375` | `this.ctx.storage.sql.exec` | Session-memory resolve — `SELECT key, value FROM mas_memory …` |

Not findings (same capability, already injected): 45 `new Sql*Store(...)`
constructions pass `this.ctx.storage.sql` / `ctx.agentCtx.storage.sql`
into store classes; `src/data/governedHalt.ts:79,83` takes `doSql` as a
parameter; `src/security/sessionStore.ts` IS the SessionStore DO
implementation (its own `storage.sql.exec` is the adapter body).

### D4. Workers AI + Vectorize direct (5: 3 AI + 2 vector) → #1775 (S1)

| File:line | Binding / API | Notes |
|---|---|---|
| `src/models/verifier.ts:75` | AI inference, `env.AI.run(model, { messages })` | `verifyWithLLM` — bypasses `getWorkersAIModel`/`runWithRouting` |
| `src/services/reportSemanticIndex.ts:48` | AI inference + Vectorize, `embed(env.AI, …)` + `env.VECTOR_MEMORY.upsert` | `indexReport` — own `embed()` duplicating `VectorMemory`'s; bypasses `VectorMemory` |
| `src/services/reportSemanticIndex.ts:121` | AI inference + Vectorize, `embed(env.AI, …)` + `env.VECTOR_MEMORY.query` | `semanticSearchReports` — same bypass, read side |

### D5. AI Search direct (1) → #1775 (S1)

| File:line | Binding / API | Notes |
|---|---|---|
| `src/agents/mas.ts:54` | AI Search, `fetch(env.AI_SEARCH_ENDPOINT + "/search")` | Knowledge search — bypasses `src/services/aiSearch.ts` client (which itself fetches the endpoint and IS the client implementation, not a finding) |

### D6. R2 inline (6) → #1777 (S3)

| File:line | Binding / API | Notes |
|---|---|---|
| `src/services/knowledgeCorpus.ts:172` | Object storage, `env.REPORTS_BUCKET.put(r2Key, …)` | Corpus ingest — bypasses `reportBlobStore`; binding read at :163 |
| `src/services/knowledgeCorpus.ts:403` | Object storage, `env.REPORTS_BUCKET.get(meta.r2Key)` | Corpus read — bypasses `reportBlobStore`; binding read at :395; throws when unbound |
| `src/services/scheduledReports.ts:321` | Object storage, `env.REPORTS_BUCKET.put(key, rec.body, …)` | Canonical report body write (`reports/<id>.json`) |
| `src/services/scheduledReports.ts:370` | Object storage, `env.REPORTS_BUCKET.delete(hit.bodyR2Key)` | Canonical report delete |
| `src/services/scheduledReports.ts:418` | Object storage, `env.REPORTS_BUCKET.put(key, hit.body, …)` | Backfill copy to R2 |
| `src/services/scheduledReports.ts:451` | Object storage, `env.REPORTS_BUCKET.get(hit.bodyR2Key)` | Canonical report read |

Not findings (same capability, adapter bodies): `src/services/reportBlobStore.ts:93`
(`put`), `:121`/`:136` (`get`) — the `putReportPdf`/`getReportPdf`
implementation; `src/trading/dataProviders/captureStore.ts:316` (`put`),
`:343` (`get`) — the capture-blob implementation. The finding is that
FOUR modules touch R2 (`reportBlobStore`, `captureStore`,
`knowledgeCorpus`, `scheduledReports`) with no single `BlobStore`
interface; the first two are store modules, the latter two inline it.

### D7. Static assets, email, browser, workflows, entrypoints (9)

| File:line | Capability | Binding / API | Notes | Slice |
|---|---|---|---|---|
| `src/server.ts:2689` | Static assets | `env.ASSETS.fetch(request)` | Landing-page injection (reads asset HTML, injects `window.__USER__`) | #1775 (S1) |
| `src/server.ts:2711` | Static assets | `env.ASSETS.fetch(request)` | Fallthrough asset serve | #1775 (S1) |
| `src/trading/email/agent.ts:939` | Email sending | `this.env.EMAIL.send(…)` | Guard at :939, send at :992 — one send site; no `EmailSender` interface; `EMAIL` not in `wrangler.jsonc` | #1778 (S4) |
| `src/services/browserAgent.ts:87` | Browser rendering | `this.env.BROWSER.fetch(renderReq)` | Guard at :87, fetch at :100 — one render site; no browser interface; `BROWSER` not in `wrangler.jsonc` | #1778 (S4) |
| `src/agents/trading-agent.ts:975` | Durable workflow | `this.runWorkflow(TRADE_WORKFLOW_BINDING, params)` | `startTradeApproval` (binding-presence guard at :954) | #1780 (S6) |
| `src/agents/trading-agent.ts:1015` | Durable workflow | `this.sendWorkflowEvent(TRADE_WORKFLOW_BINDING, workflowId, …)` | `decideTradeApproval` | #1780 (S6) |
| `src/server.ts:2730` | Entrypoint | `async email(message, env, ctx)` | → `handleCloudflareEmailMessage` (platform seam) | No slice (§E) |
| `src/server.ts:2733` | Entrypoint | `async scheduled(event, env, ctx)` | Cron dispatch (`*/30`, `0 3`, `0 4` branches) | No slice (§E) |
| `src/server.ts:2840` | Entrypoint | `async queue(batch, env, ctx)` | Queue consumer dispatch | No slice (§E) |

## (B) Per-capability remediation grouping (dependency order)

No new adapter framework: every slice follows the existing Ports pattern
(`*Ports.ts` interface + one Cloudflare implementation + the existing
in-memory/test double where one exists), or extends an existing adapter.
Slices are independent except where noted; order is by blast-radius (narrow
bypass fixes first, the big dispatch interface last).

- **S1 — Bypass fixes (no new interface; route through existing adapters).
  6 sites, no dependency → #1775.** `verifier.ts:75` →
  `getWorkersAIModel` / `runWithRouting`; `reportSemanticIndex.ts` (2
  sites) → `VectorMemory` (delete its duplicate `embed()`); `mas.ts:54` →
  `services/aiSearch.ts`; `server.ts:2689,2711` → `serveStaticAsset`
  (extend the helper for the injection case or accept the helper as the
  asset port). Smallest, safest first slice(s).
- **S2 — DO-SQLite remainder (2 sites, no dependency) → #1776.**
  `orchestrator.ts:491,1375` → move the two queries into `*Store`
  classes behind the existing `SqlStorage` injection (same pattern as the
  45 existing constructions). Then DO-SQLite has zero direct sites.
- **S3 — Blob store unification (6 direct sites + 2 adapter bodies).
  Depends on S1 only in sequencing, not technically → #1777.** One
  `BlobStore` port (following `*Ports.ts`); Cloudflare R2 implementation
  generalised from `reportBlobStore.ts`; migrate `knowledgeCorpus.ts` (2)
  and `scheduledReports.ts` (4) onto it; fold `captureStore.ts` R2 logic
  behind the same port (keep its `CaptureBlobStorage` metadata shape as
  the caller-facing type if needed — never either/or deletion). After
  S3, R2 is touched in exactly one module.
- **S4 — Email + browser ports (2 sites, independent) → #1778.** One
  `EmailSender` port (CF `EMAIL` impl) for `trading/email/agent.ts`;
  one `BrowserRenderer` port (CF `BROWSER` impl) for
  `services/browserAgent.ts`. Note both bindings are types-only today
  (absent from `wrangler.jsonc`) — the slice also records the binding
  declaration as a deployment follow-up, not a code change.
- **S5 — Actor-gateway port (29 dispatch + 6 RPC = 35 sites; the main
  slice; depends on nothing, but largest) → #1779.** One `ActorGateway` /
  `DoRouter` port in the `*Ports.ts` style: `address(instance)`,
  `dispatch(instance, request)`, and typed stub access for the RPC
  methods (`budgetCheck`, `getPdfByKey`, screener/research acquisition).
  Cloudflare implementation = the current `idFromName`/`get`/`fetch`
  logic, centralised from `server.ts` (22 blocks) first, then the route/
  service forwarders, then the RPC acquisitions. This also collapses the
  duplicated `getScreenerAgent()` pair (`orchestrator.ts:332` vs
  `scheduledTasks.ts:411`) — that dedup belongs to the duplication lane,
  surfaced here only as shared-slice context. The internal
  `PaymentsAgent.budgetCheck` RPC rides this port; it is NOT covered by
  `IPaymentGatewayStrategy` (external gateways only) and must not be
  conflated with it.
- **S6 — Durable-workflow port (2 sites; after S5) → #1780.** One
  `ApprovalWorkflow` port (start/decide) with the Cloudflare Workflows
  implementation behind it (`trading-agent.ts:975,1015`). Sequenced
  after S5 because workflow addressing shares the actor-gateway's
  instance-naming decisions; it is also the hardest to test outside CF,
  so it goes last among code slices.
- **S7 — Wiring centralisation (optional, last, no new interface) →
  #1781 (DECISION ONLY, not a build slice).** Centralise the B1 (8
  `SESSION_STORE` handoffs) + B2 (4 `VectorMemory` constructions) + B4
  factory wiring behind one env-to-adapter wiring module, so route/DO
  code never names a binding. Purely cosmetic after S1–S6; do first only
  if the owner wants zero `env.<BINDING>` tokens outside adapter modules
  as the headline metric. The scan evidence does NOT by itself justify a
  build — #1781 records the build/decline decision first.
- **S8 — No slice (documented, not built).** D1 projections (B4 — already
  ported, in-memory twins exist); KV (zero live sites — delete the
  `KV?: KVNamespace` declaration and the dormant `legacy` fallback as
  hygiene, not an adapter slice); entrypoint handlers
  (`scheduled`/`queue`/`email` in `server.ts`) — the Worker runtime
  requires these exact handler names, so they stay as thin dispatchers
  (they already dispatch to DO `fetch`; S5 makes those dispatches go
  through the gateway); agents-SDK base classes + `this.schedule` —
  framework coupling, out of incremental scope (see §C).

## (C) Framework coupling (NOT counted in the 56; the runtime itself)

8 classes extend the Cloudflare `agents`-SDK / DO base
(`SearchAgent`/`OrchestratorAgent` via `Agent`, `PaymentsAgent`,
`ScheduledAgent`, `ScreenerAgent`, `ReportAssetAgent`, `TradingAgent`;
`BrowserAgent`/`SlackAgent` via `AIChatAgent`; `OptionsScannerMCP` via
`McpAgent`; `SessionStore` via `DurableObject` from `cloudflare:workers`;
`src/agents/trading-trade-workflow.ts` via `cloudflare:workers`
`WorkflowEvent`/`WorkflowStep` types). SDK `this.schedule` /
`getScheduleById` inside DO classes is the same category; route code in
`src/agents/routes/schedules.ts:90-93` already goes through a schedule
port interface. Abstracting the Agent base class itself would be a
re-platform, not an incremental slice — recorded here so a later slice
does not mistake it for an ordinary finding. No slice filed for this.

## (D) ALREADY-BEHIND-ADAPTER list (not findings)

### B1. Session/credential/API-key store — 8 handoff lines into `durableKv`

| File:line | Handoff | Adapter |
|---|---|---|
| `src/security/session.ts:51` | `sessionStore(env)` → `createStoreKv({ namespace: env.SESSION_STORE, namespaceName: "sessions" })` | `durableKv` `KvLike` |
| `src/security/apiKeys.ts:53` | `apiKeyStore(env)` → `createStoreKv({ …, namespaceName: "api_keys" })` | `durableKv` `KvLike` |
| `src/security/etradeOAuth.ts:69,484,553` | `createStoreKv({ namespace: env.SESSION_STORE, … })` (3 call sites) | `durableKv` `KvLike` |
| `src/security/publicOAuth.ts:124,306` | `createStoreKv({ namespace: env.SESSION_STORE, … })` (2 call sites) | `durableKv` `KvLike` |
| `src/agents/orchestrator.ts:227` | `createSocialBriefStoreFromNamespace(this.env.SESSION_STORE …)` | Social brief store factory over the same namespace |

All storage ops after these lines go through `KvLike`; the DO `fetch`
protocol lives only in `durableKv.ts`. No slice needed for the interface;
an optional wiring-only slice could centralise the 8 handoffs (see S7).

### B2. Vector memory — 4 constructions of `VectorMemory`

| File:line | Construction |
|---|---|
| `src/server.ts:801` | `new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined)` — `/api/memory/recall`-family route |
| `src/agents/orchestrator.ts:1537` | `new VectorMemory(this.env.AI, vectorizeBinding, undefined)` |
| `src/agents/orchestrator/chatTurnHelpers.ts:148` | `new VectorMemory(ctx.env.AI, vectorizeBinding, undefined)` |
| `src/mcp/goalChainCommands.ts:190` | `new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined)` (guarded on both bindings present) |

### B3. LLM inference via adapter — 2 call paths (guard lines only)

| File:line | Path |
|---|---|
| `src/agents/nlq/llmPlanning.ts:47,146,178` | `hasAi` guards; actual LLM via `getWorkersAIModel(env)` (`model.ts`) |
| `src/trading/options/flows/newsSentiment.ts:136` | `hasAi` guard; actual LLM via `getWorkersAIModel(env, NEWS_SENTIMENT_TASK)` |

### B4. D1 projection — 7 factory/call sites

| File:line | Factory / call |
|---|---|
| `src/data/createAuditReportPorts.ts:33` | `new D1AuditReportAdapter(createD1AuditReportDb(env.AGENT_DB))` |
| `src/data/createChainSchedulePorts.ts:36` | `createD1ChainScheduleDb(env.AGENT_DB)` |
| `src/data/createGovernancePorts.ts:24` | `createD1GovernanceDb(env.AGENT_DB)` (+ `readAgentDbHalt` at :37, the D1 read body) |
| `src/data/createRetentionPorts.ts:33` | `new D1ShardJobAdapter(createD1ShardJobDb(env.AGENT_DB))` |
| `src/data/createShardJobPorts.ts:26` | `new D1ShardJobAdapter(createD1ShardJobDb(env.AGENT_DB))` |
| `src/agents/scheduled-agent.ts:272,969` | `readAgentDbHalt(this.env, …)` — passes env to the factory function; the D1 read is inside `createGovernancePorts` |

Each factory has an in-memory twin (`inMemory*Adapter.ts`) behind the same
port — the Ports pattern working as intended. No D1 slice needed.

### B5. Blob store consumers via `reportBlobStore` — 9 call sites

`src/agents/report-asset-agent.ts:68` (`put`), `:88` (`get`);
`src/agents/research-agent.ts:611,612` (`put`), `:630` (`get`);
`src/agents/screener-agent.ts:1166,1177,1188` (`get`);
`src/services/goalScreenReports.ts:204` (via `putReportPdf`).
These prove `reportBlobStore` is already the de-facto blob adapter for
report PDFs — the R2 slice generalises it rather than replacing it.

## (E) Not in this program

- `wrangler.jsonc` / `deploy.yml` (deployment).
- `MarketDataService` / `FossResearchService` / `PaymentGatewayService`
  (non-CF capabilities, no change).
- Client-side adapters (`src/client/**`).
- S8 items above (D1 projections, KV hygiene, entrypoint handler names,
  agents-SDK base classes).
- Program slice (n) #1734 (cloudflare/browser/misc MCP unpaired + divergent
  tools) is a SEPARATE program slice about MCP tool surfaces; S4's
  `BROWSER` rendering binding port coordinates with it but does not
  duplicate it.

## (F) Caveats and limits

- Counts are for `src/**/*.ts` at base `c06da3b6` (shallow clone,
  2026-10-26). Later merges may shift lines; file paths are stable
  identifiers for slice scoping.
- `server.ts` dispatch blocks were counted once per forward block even
  where a block spans 2–4 lines (`idFromName` + `get` + `fetch`); raw
  `env.SEARCH_AGENT` line hits in `server.ts` number 55, collapsing to
  the 22 blocks + scheduled/queue sites above.
- `src/orchestrate.ts` (`binding: "TASKS_AGENT"` etc.) is a static
  capability catalogue (strings), not a binding read — excluded.
- `EMAIL`/`BROWSER` send/fetch paths are fail-soft (guarded, warn +
  `false`) — adapter slices for them must preserve the fail-soft
  contract, not fail loud.
- This scan did not execute the Worker, probe production bindings, or
  verify which optional bindings are actually bound in production
  (`REPORTS_BUCKET`, `AGENT_DB`, `EMAIL`, `BROWSER` all have unbound
  fallbacks in code) — production binding presence is an owner-side
  dashboard fact, not established here.
- **No branches, issues, PRs, pushes, deletions, or edits to the repo were
  made by the coupling scan itself.** The coupling clone was read-only
  scratch. The amendment PR publishing this appendix is a separate,
  gated step.
