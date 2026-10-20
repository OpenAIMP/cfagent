# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release discipline

- **How to cut a release:** open a PR that moves the `## [Unreleased]` entries into a
  versioned `## [X.Y.Z] - YYYY-MM-DD` section. CI's *Test & Build* job
  (typecheck + vitest + build) is the required gate on every release PR.
- **Tagging:** after the release PR merges, place the tag `vX.Y.Z` on its merge
  commit (e.g. `git tag -a v0.1.0 <merge-sha> && git push origin v0.1.0`).
- **Semver rules:** MAJOR = breaking contract or API changes; MINOR = new
  capabilities, backward-compatible; PATCH = fixes with no contract change.

## [Unreleased]

### Fixed

- **Deploy job no longer segfaults on secret refresh (#590):** `Build & Deploy [PROD]` failed on every main merge with exit 139 at "Set core secrets on Cloudflare Worker". The retry wrapper added for #560/#561 called `put_secret` from inside `put_secret`, so bash recursed until it crashed; the same body was copied into all three secret steps. Each wrapper now runs `npx wrangler secret put "$name"`, reads the piped value once, and re-feeds it on every retry (a retry used to find stdin drained), still capped at three attempts. The Worker itself had been deploying — the crash happened afterwards, so Tag Release and Post-deploy QA never ran during the failure window. Pinned by `tests/deploy_workflow_secret_retry.test.ts`.
- **Secret pushes are bounded and unmistakable (#590):** every `wrangler secret put` attempt now runs under a 90s timeout and retries back off 10s → 20s (still three attempts). An exhausted push emits a `Secret push failed` check annotation naming the secret, and the deploy job is capped at 30 minutes — so a stuck Cloudflare API call can neither stall a deploy nor be read as a flake. The wrapper is exercised against the real step body with a stubbed broker: two injected failures land on the third attempt with a byte-identical value, and an all-fail run exits non-zero with the annotation.
- **Worker secrets sync is one implementation, one job, no silent skips (#590):** `put_secret` now lives in `scripts/ci/put-secret.sh` instead of three copies inside `deploy.yml`, and the three secret steps moved out of the code-deploy job into a separate `sync-secrets` job (`continue-on-error`, 20-minute cap) that runs after the Worker is live — so a Cloudflare secrets blip can no longer read as "the code deploy failed" or block the release tag and post-deploy QA. Required secrets (GitHub OAuth, session, dashboard token, E*TRADE key/secret) now fail the step when empty instead of being skipped; gateway and notification secrets stay optional but emit a warning and a job-summary line, so an absent value is never silent. The three steps also declare `-euo pipefail` explicitly instead of relying on the runner's shell flags.
- **Research Think-turn fallback is no longer silent (#543):** when the Think child turn in `OrchestratorAgent.runResearchAndPublish` does not produce a fresh report and the deterministic pipeline fallback runs instead, the orchestrator now emits a structured `console.warn` carrying trigger, userLogin, child status/error, and previous/latest run ids — so Workers Logs can distinguish a Think-path success from a bypass (cloudflare.md §8C/F, §9E). Fallback behavior and the publish flow are otherwise unchanged; pinned by `tests/think-fallback-observability.test.ts`.
- **Floating `latest` dependencies pinned (#540):** `@ai-sdk/react`, `@cloudflare/ai-chat`, `ai`, and `workers-ai-provider` (plus devDeps `@cloudflare/workers-types` and `wrangler`) no longer float on the `latest` tag — they are pinned to the exact versions already resolved in `package-lock.json` (no upgrades, no resolved-version changes), so the conformance baseline in `docs/agents/cloudflare.md` §4–5 compares declared against a reproducible installed tree. Guarded by `tests/dependency-pinning.test.ts`, which fails if any spec becomes a floating tag again or package.json drifts from the lockfile root entry.
- **CI red on main — etrade read-error tests made hermetic** (#490): `tests/etrade_read_error_surfacing.test.ts` (#466) failed in CI while passing locally — `resolveEnvironmentConfig()` falls back to `process.env` for E*TRADE credentials, and CI injects the real `ET_API_KEY`/`ET_API_SECRET` secrets into the test job, so the 16 "missing credentials" fixtures silently resolved ambient credentials and never took the not-configured path. The file now stubs every credential alias the resolver reads to empty for each test and restores them afterwards. Same hermeticity class as #401/#404.
- **Stock screener quote reliability (#495):** the E*TRADE-only screener now quotes a universe through the broker's batch quote endpoint (50 symbols per request) instead of one authenticated request per symbol. A NASDAQ100 screen makes two broker calls — plus bounded per-symbol retries for symbols a batch omits — instead of 100+ calls that exhausted the Worker subrequest budget and E*TRADE's rate limit (the run that reported 47 of 100 symbols quoted as `other=53`). Failure diagnostics now distinguish `request-budget` and `batch-omitted`, and a screen that still falls short publishes the qualified partial report (#462) rather than failing outright.
- **Strategy opportunity screening expiry coverage:** the shared scanner now derives bounded near/far expiry bands from the selected strategy catalog and applicable per-symbol sentiments. Both “best strategy per name” and “names that fit my strategy” can generate PMCC, LEAPS, calendar, and other long-dated strategy candidates without expanding ordinary near-expiry eligibility. Bump the scan model version because the additional eligible strategy results change scan semantics.
- **Searchable research reports and Think dispatch (#186/#278/#307/#319):** autonomous options research now runs through a read-only Think agent tool with deterministic pipeline fallback; manual and scheduled options scans save one canonical `mas_reports` row with searchable results and the generated PDF key/URL before delivery. AI Search cache keys include the result limit to avoid cross-limit cache collisions.
- **E*TRADE screener quote retries and provenance (#294):** retry the JSON quote representation when E*TRADE returns an empty HTTP 200 response, preserve broker errors, and prevent live screening from substituting cached or curated prices after a failed E*TRADE quote.
- **Stock/options screener Slack reports (#421/#423/#424):** publish manual and scheduled stock and options screen results with their generated per-run PDFs through the Slack A2A agent, label stock notifications with the selected universe and actual/expected counts, suppress repeated scheduled runs per universe/hour, and notify Slack when runs fail.
- **options_flows test no longer calls live Yahoo Finance** (#404): the flows tests resolved a real crumb session against Yahoo hosts, stretching past the 25s timeout in CI (it reddened PR #403's run and deploy test steps). `fetch` is now stubbed for the suite — Yahoo hosts fail fast so the live-flow path yields [] deterministically, and any other URL throws so a new network dependency fails loudly. Same hermeticity class as #401 (Stripe) and #408 (NLQ LLM).
- **Slice 03/04 characterization tests no longer contradict on main** (#405): the ads/revenue/referrals extraction test anchored its position check to the `// Audit logs endpoint` comment, which slice 04 (#367) legitimately moved into `routes/audit.ts` — the landmark resolved to -1 and the assertion failed every CI/deploy test run. The check now anchors to the `handleAuditRoutes(...)` delegation call. (Rule for remaining #359 slices: anchor positions to delegation calls, never a neighboring domain's inline comments.)
- **payments_did test no longer calls the live Stripe API** (#401): the checkout unit test resolved the mock key into a real `fetch` to `api.stripe.com` (~5.3s standalone, past the 25s timeout under suite load — it failed PR runs and blocked the 63443d6 production deploy's test step), and its assertions silently passed on the 401 error path. `fetch` is now stubbed hermetically for the checkout-sessions endpoint and the test asserts the actual success contract (success, checkout URL, gateway ref).
- **mas_reports DDL single-sourced (SQLITE_ERROR: no such column: generation_id)** (#389): the ORM's `initializeSchema()` carried its own duplicate `mas_reports` DDL that created the unique index on `generation_id` without a column guard, so any Durable Object whose table predated #308 threw on every schema init (the Strategy/Symbol Scanner failure). The block now delegates to `ensureScheduledReportsTable()` in `src/services/scheduledReports.ts` (PRAGMA-checked additive migration); the unguarded duplicate is deleted. Regression test: a pre-#308 table migrates without throwing and keeps its rows.

### Fixed

- **Reports/Schedules tabs render their panels** (#388): the #309 navigation items were missing from Chat's `TRADING_TABS` and `mapTabToTradingSubTab`, so selecting Reports or Schedules hid the trading hub and rendered a blank main view. Both tabs are now trading tabs with explicit subtab mappings and breadcrumb labels; a regression test pins the wiring.
- **Research section default view restored** (#387): the Trading hub research section landed on the new Autonomous runs panel (empty state) instead of the per-symbol research panel it showed before #319. The toggle now defaults to Symbol research; Autonomous runs remains one click away.

### Added

- **Autonomous options runs are readable after the fact (#223):** `autonomousOptionsAnalysis` now appends each run to `options:last_runs` (newest first, capped at 20, storage failure never fails the run) and `GET /api/options/latest` serves that history. The options schedule panel lists the five most recent runs with symbols, setup count, trigger/thesis, and the failure reason when one exists. Scheduling stays on the existing user-owned `/api/schedules` path — no baseline seeder was added back, because `removeUnownedBaselineSchedules` deliberately deletes unowned `autonomousOptionsAnalysis` jobs. The old `feat/options-scheduled-223` branch's `onStart` seeder would have recreated exactly those jobs.
- **Heartbeat emission during long research and screener runs (#624, phase-2 P2-3.4):** live runs now keep their task record's heartbeat fresh, so the #615 staleness signal means *abandoned*, not *slow*. Research: `runResearchAndPublish` heartbeats the task every 2 minutes while dispatch is in flight (covering both the Think turn and the fallback run) via the new `ResearchAgent.heartbeatResearchTask`, with the timer cleared in a `finally` on every exit. Screener: `runScreen` heartbeats its own task at phase checkpoints and during the technicals phase — via a new optional `onBatch` progress callback on `fetchTechnicalsBatch` — throttled to one ledger write per minute through `ScreenerAgent.heartbeatScreenerTask`. Heartbeat failures are best-effort and never break a run.
- **Stale-task sweep now runs automatically (#618, phase-2 P2-3.3):** the orchestrator's maintenance path sweeps both task ledgers for each authenticated user — `onStart` closes any already-stale research/screener task records and arms a persistent 6-hourly interval schedule (`sweepStaleLedgerTasks` callback), so abandoned records are failed → escalated within ~6.5 hours worst case even with no user traffic. Each ledger is swept in isolation; sweep failures log and never block startup or the other ledger.
- **Stale-task detection and sweep for both task ledgers (#615, phase-2 P2-3.2 / architecture risk R4):** the research (#577) and screener (#607) task ledgers now detect abandoned work — active tasks (queued/claimed/running) whose heartbeat is older than a threshold (default 30 minutes, overridable) — via read-only `findStale`, and close it honestly via `sweepStale`: failed → escalated with the heartbeat age and threshold recorded in the task's error and history. No auto-rerun and no deletion; the work may have partially happened, so a human reviews the escalation. ResearchAgent and ScreenerAgent expose `findStale*` / `sweepStale*` operations; nothing invokes the sweep automatically yet (the trigger/cadence is a separate decision). Also corrects the #607 storage terminology (#611): ScreenerAgent persists via Durable Object storage (`ctx.storage`), not Cloudflare KV.
- **Durable task records for screener runs (#607, phase-2 P2-3.1):** every `ScreenerAgent.runScreen` execution — manual, scheduled, and every `runSharded` shard — now writes a task record in the agent's own Durable Object storage (`screener:task:` prefix), via the new SDK-free `src/services/screenerTaskLedger.ts` (async injected-store idiom mirroring the research ledger, #577). Scheduled runs dedup their record on the same minute-slot identity as `claimScheduledExecution`; suppressed duplicates close as `cancelled`; failures fail + escalate; completions carry the run's timestamp identity, counts, and a deterministic honesty evaluation (zero-scan success fails the check per #462; partial runs must carry their qualification). Results gain an additive `taskId`; ledger failures warn and never break a screen.
- **Removed unreferenced standalone agent classes (#597, phase-2 P2-0.3 / finding F5):** `src/agents/search.ts`, `tasks.ts`, `memory.ts`, and `payments.ts` were dead `AIChatAgent` classes (250 lines, zero references in src/tests/config) whose names collided with live classes — `SearchAgent` (the orchestrator's export alias) and `PaymentsAgent` (the payments Durable Object). Live behavior for those domains is the `mas.ts` tool factory. A new guard suite (`tests/dead-agent-classes.test.ts`, written red-first per gitops.md §7) pins their absence and the unchanged `src/server.ts` export surface.
- **Durable research task ledger — phase-2 vertical slice (#577):** every delegated research run now leaves a durable, queryable task record in the ResearchAgent's DO (`research_task_store`), via the new SDK-free `src/services/researchTaskLedger.ts` (injected-store idiom). `runResearchAndPublish` creates + begins a task before dispatch (record deduped by idempotency key while active), completes it with the execution path actually taken (`think`/`fallback`, building on #543) and a deterministic outcome evaluation (fresh runId, trigger/login match, summary present, sane counts — never model self-grading), and escalates the task on total failure instead of the failure vanishing. Results gain additive `taskId`/`executionPath` fields; ledger failures warn and never break the research flow. Design: `docs/agents/agentic-architecture.md` §5/§7.
- **Agentic target architecture (#576, phase-2/P1):** `docs/agents/agentic-architecture.md` delivers the transformation mandate's architecture stage — re-baseline at `e6d80a0`, a §4 capability-allocation table (zero new agent classes: the change is contractual/coordinative, not a larger agent count), target topology and contracts, a §6 durable-coordination design (task state model, DO-serialized claiming, idempotency dedup, heartbeat/stale policy), the §7 memory mapping onto existing stores, and the implementable Phase 2 slice specification (research task ledger, #577) with its before/after gate evidence.
- **Think roles decision record (#545):** `docs/agents/think-roles-decision.md` inventories every agent class against the cloudflare.md §2 designation question — ResearchAgent recommended as the designated Think role; OrchestratorAgent as the only serious (optional) migration candidate with a 5-step sequenced path; non-chat DOs as not planned / not applicable. It also records that the standalone `search/tasks/memory/payments.ts` AIChatAgent classes are unreferenced anywhere in `src/` or `tests/` and recommends removal or prototype marking instead of migration. Owner decision table is included; recommendations are not requirements until the owner marks them.
- **Think conformance regression tests (#542):** `tests/think-conformance.test.ts` pins the adoption evidence from `docs/agents/think-conformance.md` — exact `@cloudflare/think`/`agents` pins, `ResearchAgent extends Think` with `getModel`/`getSystemPrompt`/`getTools`, the `src/server.ts` Durable Object export, the `RESEARCH_AGENT` binding + SQLite migration in `wrangler.jsonc`, and the orchestrator's `runAgentTool(ResearchAgent)` dispatch — because vitest aliases Think to a stub, a refactor that unwired any of these previously failed no test. Verified by mutation: removing the Think base class fails the suite.
- **Think conformance assessment (#541):** `docs/agents/think-conformance.md` publishes the `docs/agents/cloudflare.md` §14 assessment for this repo — separate verdicts (Think adoption PARTIAL: only ResearchAgent is Think-based), the §4 baseline at main `f063104` (declared == resolved versions after #540), architecture/identity map, conformance matrix, and findings F1–F6 in §13 format with the remediation sequence (#540 done, #542, #543, #545) and acceptance criteria. It also records that `ResearchAgent.getModel()` returning a string was verified as a valid `ThinkModel` against the installed `@cloudflare/think` 0.19.0 types.
- **cfpay email-with-attachments A2A helper** (#384): `cfpaySendEmailWithAttachments()` in cfpayA2A.ts wraps cfpay's `email.sendWithAttachments` A2A op, enabling options-report PDF delivery by email (wiring into the scheduled options analysis follows).

### Changed

- **Thin-router wiring — orchestrator breakup COMPLETE** (#359/#380): the
  last two inline route blocks in `OrchestratorAgent.routeRequest` moved
  into `src/agents/routes/` — the schema introspection block (GET
  `/schema/tables`, POST `/schema/query`) into `routes/schema.ts` as
  `handleSchemaRoutes` (between the MCP/chat/NLQ and ads/revenue/referrals
  delegations), and the Cloudflare Agentic Payments block (x402 & MPP:
  GET `/payments/agentic/wallet`, GET|POST
  `/payments/agentic/auto-approve-limit`), deliberately left inline by
  slice #359-07, into `routes/agenticPayments.ts` as
  `handleAgenticPaymentsRoutes` (between the payments and premium
  delegations); the `ETradeAgenticPaymentService` import moved with it.
  `routeRequest` is now a thin ordered dispatcher: the request prelude
  (url/path, `ensureTables`, `sessionKey`, the `requestedEnv` binding
  passed via context), 22 guarded delegation calls, and the Not-found
  fallthrough — no inline path-matched handlers remain. Landmark swaps
  (#405) in the slice-03/07/08 tests: their anchors into the then-inline
  schema-query condition and agentic-payments banner now anchor to the
  new delegation calls. A scripted full-router scan confirms all 150
  path-matching conditions in unchanged order; both moves are
  byte-identical under reverse transform. Characterization:
  `tests/schema_routes_extraction.test.ts` (8 tests),
  `tests/agentic_payments_routes_extraction.test.ts` (12 tests),
  `tests/thin_router_inventory.test.ts` (4 tests, pins the delegation-only
  shape and the full 150-condition inventory). orchestrator.ts: 6,803 →
  2,802 lines across the 17 slices. Pure move, no behavior change.

- **FOSS research routes extracted from orchestrator.ts** (#359/#377): the
  non-alpaca FOSS route blocks moved to `src/agents/routes/fossResearch.ts`
  as TWO handlers, each invoked from `routeRequest` at its exact original
  position — `handleFossQuoteResearchRoutes` (GET `/foss/quote`,
  `/foss/fundamentals`, `/foss/bars`, `/foss/research`, before the
  handleAlpacaFossRoutes delegation) and `handleFossCompareScreenRoutes`
  (POST|GET `/foss/compare`, GET `/foss/providers`, POST|GET
  `/foss/screen`|`/yfinance/screen`, after it). The `FossResearchService` /
  `fossBarsSourceLabel` and `YFinanceMarketScreener` imports moved with the
  blocks; audit events stay funneled through the single-owner `recordAudit()`
  via the context. Slice #359-13's test landmark (the
  FossResearchService-import-stays-inline anchor) was swapped to the new
  ownership per the #405 rule. Pure move, no behavior change.

- **Schedules routes extracted from orchestrator.ts** (#359/#379):
  the contiguous schedules block (GET `/schedules`, POST
  `/schedules/cancel`, DELETE `/schedules/:id`, GET `/schedules/:id`,
  POST `/schedules/create` + its `/schedules` create alias, POST
  `/schedules/trigger-screen|/trigger-renew|/trigger-options-analysis|/trigger-retention|/trigger-iv-collection`)
  moved to `src/agents/routes/schedules.ts` as a single handler,
  `handleSchedulesRoutes`, invoked from `routeRequest` at the exact
  original position (after the screener + research delegation, before the
  Not-found fallthrough - this block was the last one before it). The
  `resolveEnvironmentConfig`, `getStoredTokens`, `isTokenExpiredEt`,
  `runStorageRetention` and `UNIVERSES` imports moved with the block; the
  Agents SDK scheduling port (`listSchedules`, `cancelSchedule`,
  `getScheduleById`, `schedule`, `scheduleEvery` - the `as keyof this`
  assertion pattern from the #109 NLQ scheduling port), `audit`,
  `getOrm`, `agentCtx` (for the SqlStorage-backed stores),
  `autonomousMarketScreen`/`autoRenewETradeTokens` and
  `getScreenerExecutionContext` arrive via the context object with
  identical arguments (#111 allow-list/honest-503 semantics and #447
  account-stamping unchanged). The #111 `CREATABLE_SCHEDULE_CALLBACKS`
  / `ACCOUNT_SCOPED_SCHEDULE_CALLBACKS` constants stay module-owned by
  `orchestrator.ts` (the former is a public export) and arrive via the
  context; the #447 `onStart` schedule-reconciliation code is untouched
  outside the route block. A scripted scan confirms the 15-condition
  inventory and order are unchanged. Characterization:
  `tests/schedules_routes_extraction.test.ts` (18 tests).

- **Alpaca routes extracted from orchestrator.ts** (#359/#376): the
  alpaca-named route blocks moved to `src/agents/routes/alpaca.ts` as TWO
  handlers, each invoked from `routeRequest` at its exact original position —
  `handleAlpacaTradingRoutes` (POST `/trading/alpaca/order`, GET
  `/trading/alpaca/account|/positions|/orders`, after the watchlists
  delegation) and `handleAlpacaFossRoutes` (GET `/foss/snapshot`, GET
  `/foss/alpaca/account|/positions|/orders`, POST `/foss/alpaca/order`,
  between the `/foss/research` and `/foss/compare` blocks). The non-alpaca
  foss routes were slice #359-14's (foss research) domain and are now
  extracted to `src/agents/routes/fossResearch.ts` (two handlers flanking
  this delegation). `FossResearchService` was constructed with the same
  env (no credential/auth semantics change); the import has moved to the
  fossResearch module with the blocks (slice #377 swapped the test
  landmark). Audit events stay funneled through the single-owner
  `recordAudit()` via the context. Slice #359-12's test needs no landmark
  swap (it already anchored to the watchlists delegation call). Pure move,
  no behavior change.

- **Watchlists routes extracted from orchestrator.ts** (#359/#375): the
  E*TRADE watchlists block (GET `/etrade/watchlists`,
  GET `/etrade/watchlist/details`, POST `/etrade/watchlist/create`,
  POST `/etrade/watchlist/save-screen`, DELETE|POST
  `/etrade/watchlist/delete`) moved to `src/agents/routes/watchlists.ts` as a
  single handler, `handleWatchlistsRoutes`, invoked from `routeRequest` at the
  exact original position (between the E*TRADE options delegation and the
  Alpaca block). The `ETradeService` import moved with the block;
  `requestedEnv` stays inline and is passed through the context; dependencies
  arrive via an explicit context object. Slice #359-11's test landmark (the
  watchlists banner anchor) was swapped to the new delegation call per the
  #405 rule. Pure move, no behavior change.

- **Trading integrations routes extracted from orchestrator.ts** (#359/#373):
  the omnichannel trading channel block (POST `/trading/email/inbound`,
  POST `/trading/slack/event|/interaction|/command`, POST
  `/trading/browser/transaction-snap` (also `/browser/transaction-snap`),
  POST `/trading/voice/turn`, GET `/trading/voice/greeting`) moved to
  `src/agents/routes/tradingIntegrations.ts` as a single handler,
  `handleTradingIntegrationsRoutes`, invoked from `routeRequest` at the
  exact original position (between the E*TRADE broker block and the broker
  activity delegation). ETrade*TradingService imports stay behind the
  `src/trading/index.ts` boundary (#290); dependencies arrive via an
  explicit context object. A characterization test pins route order and
  behavior.
- **E*TRADE broker routes extracted from orchestrator.ts** (#359/#372): the
  "Environment & E*TRADE Trading APIs" block (the #314 environment switcher
  with both `/environment/switch` and `/broker/etrade/environment` spellings
  delegating to the single-owner `handleEnvironmentSwitch`, broker status,
  diagnostics, accounts, the equity screener, quote, order preview/execute
  with the autopilot policy envelope, expiration scheduling and pre-trade
  Slack approval ticket, positions, portfolio-risk aggregate/evaluate/
  correlation/size, think evaluation, hedge analysis, and orders
  listing/remote-fetch/cancel) and the account-activity block
  (transactions, transaction details, alerts inbox/details/delete, product
  lookup) moved to `src/agents/routes/etradeBroker.ts` as TWO handlers —
  `handleEtradeBrokerRoutes` and `handleEtradeBrokerActivityRoutes` — each
  invoked from `routeRequest` at the exact original position (the blocks
  were non-contiguous). Handlers take dependencies via an explicit context
  object; the options blocks stay inline for sibling slice #359-11. A
  characterization test pins route order and behavior.
- **Payments routes extracted from orchestrator.ts** (#359/#370): the
  Multi-Gateway Payments & DID Management API (GET `/payments/gateways|/status`,
  GET `/payments/dids`, the transactions ledger, POST `/payments/create`,
  POST `/payments/confirm` (HITL), POST `/payments/capture`, POST
  `/payments/webhook`) moved to `src/agents/routes/payments.ts`, invoked from
  `routeRequest` at the exact original position (between the referrals+ads
  handler and the Cloudflare Agentic Payments block). All money-adjacent
  guards preserved exactly (#156 gateway 400-before-checkout, #148 webhook
  provider default-deny, signature verification, the payment.created/
  confirmed/rejected/captured/settled_webhook audit events); a
  characterization test pins route order and behavior.
- **Memory + reset routes extracted from orchestrator.ts** (#359/#369): the
  Persistent Memory facts routes (GET/DELETE `/memory`) and the session reset
  routes (POST|DELETE|GET `/clear|/reset`) moved to
  `src/agents/routes/memoryReset.ts`, invoked from `routeRequest` at the exact
  original position (between the autopilot handler and the referrals+ads
  handler). Reset guards preserved byte-for-byte in behavior (the
  `?purge=false` opt-out, the abort reason string, the
  memory.deleted/memory.cleared/history.purged/history.cleared audit events);
  a characterization test pins route order and behavior.
- **Reports + HITL routes extracted from orchestrator.ts** (#359/#363): the
  report generation/dispatch routes (`/trading/reports/email`,
  `/trading/reports/webhook`), the #277 HITL confirmation routes
  (`/trading/reports/pending`, `/trading/reports/confirm`) and report-settings
  routes (`/trading/settings/report-dispatch-hitl`), plus the #309
  `GET /reports` list route, now live in `src/agents/routes/reports.ts` as
  `handleReportsRoutes()`. Pure move — same paths, same matching order in
  `routeRequest` (verified: no other handler in the region matches these
  paths), same response shapes/statuses/auth. Handlers reach OrchestratorAgent
  state only through an explicit `ReportsRouteContext`. Characterization:
  `tests/reports_routes_extraction.test.ts` pins the 7-route inventory and
  relative order. orchestrator.ts: 6803 → 6490 lines.

- **MCP + chat + NLQ routes extracted from orchestrator.ts** (#359/#364): the
  MCP server endpoint (`/mcp`), `POST /api/chat`, and `POST /nlq` now live in
  `src/agents/routes/mcpChatNlq.ts` as `handleMcpChatNlqRoutes()`. Pure move —
  same paths, same matching order in `routeRequest` (the three blocks were
  contiguous, so a single delegation at the region's original position preserves
  order), same response shapes/statuses/auth. The NLQ webhook spellings were
  already extracted to `src/server.ts` by #313 and are untouched. Characterization:
  `tests/mcp_chat_nlq_routes_extraction.test.ts` pins the 3-route inventory,
  relative order, and the NLQ pipeline argument contract.

- **Ads / revenue / referrals routes extracted from orchestrator.ts** (#359/#366):
  the referral-categories ORM CRUD (`/categories`), the revenue summary
  (`GET /revenue`), and the external ad network placements with impression/click
  tracking (`/external-ads`, `/external-ads/impression`, `/external-ads/click`),
  plus the community referrals (`/referrals`, `/referrals/click`) and sponsored
  ads (`/ads`, `/ads/click`), now live in
  `src/agents/routes/adsRevenueReferrals.ts`. Pure move — same paths, same
  matching order in `routeRequest`, same response shapes/statuses. The domain's
  blocks are not contiguous in the original file (inventory group sat between
  /schema/query and /audit; community group between /memory and the payments
  block), so the module exports two handlers — `handleAdsRevenueReferralsRoutes()`
  and `handleReferralsAdsRoutes()` — each invoked at its original position in
  the sequential matching sequence. Handlers reach OrchestratorAgent state only
  through an explicit `AdsRevenueReferralsRouteContext`.
  Characterization: `tests/ads_revenue_referrals_routes_extraction.test.ts`
  pins both handlers' route inventories and relative order, the two call-site
  positions, and behavior (null for non-owned paths, validation, audit events,
  SQL writes). A scripted scan of the full 120-condition route inventory
  confirms the matching order is unchanged. orchestrator.ts: 6364 → 5998 lines.

- **Audit routes extracted from orchestrator.ts** (#359/#367): the audit-log
  read route (`GET /api/audit`), the generic audit write (`POST /api/audit`)
  and the strictly-validated event append (`POST /api/audit/event`, issue
  #270/PR #302) now live in `src/agents/routes/audit.ts` as
  `handleAuditRoutes()`. Pure move — same paths, same matching order in
  `routeRequest` (the three blocks were contiguous between the
  ads/revenue/referrals handler and the autopilot block, so a single
  delegation at that position preserves order), same response
  shapes/statuses. Audit writes stay funneled through the single-owner
  `recordAudit()` via an explicit `AuditRouteContext`; nothing is inlined.
  Characterization: `tests/audit_routes_extraction.test.ts` pins the 3-route
  inventory and order, the single call-site position, and behavior (null for
  non-owned paths, GET parsing/limit clamp, POST defaults, event-append
  validation + 201 delegation). The source pin in
  `tests/audit-event-endpoint.test.ts` now points at the new ownership.

- **Autopilot routes extracted from orchestrator.ts** (#359/#368): the
  Autopilot control center routes (autopilot Phase 1) — `GET /autopilot`,
  `POST /autopilot/state`, `POST /autopilot/kill-switch`,
  `POST|PUT /autopilot/limits`, `POST /autopilot/evaluate` — now live in
  `src/agents/routes/autopilot.ts` as `handleAutopilotRoutes()`. Pure move —
  same paths, same matching order in `routeRequest` (the five blocks were
  contiguous between the audit handler and the Persistent Memory endpoint, so
  a single delegation at that position preserves order), same response
  shapes/statuses. The policy-verdict pipeline stays behind the orchestrator's
  `evaluateAndRecordAutopilotVerdict()` via an explicit
  `AutopilotRouteContext`; nothing is inlined. Characterization:
  `tests/autopilot_routes_extraction.test.ts` pins the 5-route inventory and
  order, the single call-site position, and behavior (null for non-owned
  paths, state/kill-switch/limits updates with audit events, evaluate
  validation + pipeline delegation). A scripted scan of the full 92-condition
  route inventory confirms the matching order is unchanged. orchestrator.ts:
  5928 → 5842 lines.
- **Premium routes extracted from orchestrator.ts** (#359/#371): the three
  Paid Trading Service blocks — `/premium/options-scan` (Institutional Options
  & Greeks Screener, $0.05 USDC), `/premium/market-research` (Autonomous Equity
  Research Report, $0.10 USDC), `/premium/stock-signals` (Real-Time Quantitative
  Anomaly Signals, $0.02 USDC), each GET|POST and payment-gated — moved to
  `src/agents/routes/premium.ts` as `handlePremiumRoutes()`. Pure move: same
  paths, same matching order in `routeRequest` (the three blocks were
  contiguous between the Cloudflare Agentic Payments block and the Environment
  & E*TRADE Trading APIs block, so a single delegation at that position
  preserves order — scripted scan of the full 90-condition inventory confirms
  it), same response shapes/statuses, canonical-copy reporting (#307/#308)
  preserved. Handlers reach OrchestratorAgent state only through an explicit
  `PremiumRouteContext` (env + getOrm). Characterization:
  `tests/premium_routes_extraction.test.ts` pins the 3-route inventory and
  order, the single call-site position, and behavior (null for non-owned
  paths; unpaid requests get the 402 payment-required challenge without
  running the fulfill callback, so no canonical-report row is written).
  orchestrator.ts: 5435 → 5280 lines.
- **E*TRADE options routes extracted from orchestrator.ts** (#359/#374): the
  contiguous options block (GET `/etrade/options/chains|/expire-dates|/scans|`
  `/scans/diff|/iv-history|/profiles`, POST `/etrade/options/profiles|`
  `/strategy` (the #314 advertised spelling), POST
  `/trading/options/llm-ideas|/compare|/recommend|/strategies|/best-trade`,
  GET `/trading/options/catalog`, POST|GET `/trading/options/screen|`
  `/unified|/config`) moved to `src/agents/routes/etradeOptions.ts` as a
  single handler, `handleEtradeOptionsRoutes`, invoked from `routeRequest` at
  the exact original position (between the E*TRADE broker account-activity
  delegation and the watchlists block). The #314 single-owner
  `handleOptionsStrategyRecommend` moved with its block (both strategy
  spellings delegate to it; byte-identical contract); the `requestedEnv`
  binding stays inline and is passed through the context. All trading access
  stays behind the `src/trading/index.ts` boundary (#290); a scripted scan
  confirms the 18-condition inventory and order are unchanged.
  Characterization: `tests/etrade_options_routes_extraction.test.ts` pins the
  route inventory and order, the single call-site position, and behavior
  (null for non-owned paths; 400s on invalid llm-ideas symbol and strategy
  requests before any backend call). orchestrator.ts: 4432 → 3454 lines.

- **Screener + research routes extracted from orchestrator.ts** (#359/#378):
  the contiguous screener/research block (GET `/screener/latest`,
  `/screener/report.pdf`, `/options/report.pdf`, POST `/research/run`,
  `/research/scheduled-tick`, GET `/research/latest|/history|/settings`,
  POST `/research/settings|/evaluate`) moved to
  `src/agents/routes/screenerResearch.ts` as a single handler,
  `handleScreenerResearchRoutes`, invoked from `routeRequest` at the exact
  original position (after the FOSS compare/screen delegation, before the
  task schedules block). The `triggerManualResearch` /
  `triggerScheduledResearch` and `shouldFireResearchTick` /
  `RESEARCH_SCHEDULED_LAST_RUN_KEY` imports moved with the blocks; the
  orchestrator-owned `getScreenerAgent`, `getResearchAgent`,
  `runResearchAndPublish` (the #308 canonical store lives inside it),
  `readSettingRaw` and `writeSetting` helpers arrive via the context object
  with identical arguments (store-first, fail-closed semantics unchanged).
  A scripted scan confirms the 10-condition inventory and order are
  unchanged. Characterization:
  `tests/screener_research_routes_extraction.test.ts` pins the route
  inventory and order, the delegation position (anchored to the
  `handleFossCompareScreenRoutes(...)` delegation call per the #405 rule),
  and behavior (null for non-owned paths; 404/400 contracts on the PDF and
  evaluate paths). orchestrator.ts: 3317 → 3146 lines.

### Added

- **Options PDF stored to KV for download** (#361, PR #362): generated options-scanner PDFs are stored in KV (`options:pdf:{filename}` plus an `options:pdf:latest` pointer), mirroring the stock screener pattern, so the download endpoint can serve them.

- **Manual options scans → Slack via A2A** (#358): the `/trading/options/unified`
  endpoint now honors a `pushToSlack` request-body param. After the scan
  completes (action `opportunities`), the summary text goes via
  `cfpayPostToSlack()` and the options PDF report (`generateOptionsPdf()`) via
  `cfpayPostFileToSlack()` — same pattern as the scheduled path in
  `scheduledTasks.ts:autonomousOptionsAnalysis()`. Optional `slackChannel`
  param overrides `SCREENER_SLACK_CHANNEL`.

- **Scheduled research run restored via the */30 tick** (#354): the account's
  Workers Free 5-cron-trigger ceiling (error 10072) makes the dedicated
  `0 21 * * 1-5` trigger impossible, so its `scheduled()` branch was dead
  code. The daily options-research run now rides the `*/30` tick instead:
  after the ScheduledAgent tick, the handler POSTs
  `/research/scheduled-tick`, and a pure guard
  (`src/services/researchScheduleGuard.ts`) fires the run exactly once per
  weekday at/after 21:00 UTC. Idempotency is durable — the last-fired date
  is stored in the orchestrator's `mas_settings` (survives ticks and
  isolates); the marker is written only after a successful run, so a failed
  21:00 run retries at 21:30. Skips return an explicit
  `skipped: true` with the reason.

- **PMCC reachable in the research pipeline** (#352/#353): `getChain` now
  selects expirations across two bounded windows — the 30–45 DTE near band
  the short-dated structures use and a >=180 DTE LEAPS band — instead of the
  first four expirations only, which made the `pmccEnabled` flag inert. The
  PMCC long-leg requirement drops from >=300 to the catalog's >=180 DTE
  (`farMinDte`), and the thesis/range gates admit PMCC for `range_bound`
  outlooks as the catalog tags it (`[bullish, range_bound]`). The calibrated
  fallback builder's DTE grid extends to LEAPS (180/270/365) so synthetic
  chains mirror the same two windows.
- **Canonical report store** (#308, #307): every generated report is stored
  once at generation into `mas_reports` (idempotent on generation id);
  UX, email, Slack, webhook, and HITL approval all deliver that single
  stored copy. Research-report dispatch stores first and fails closed if
  the store fails.
- **`POST /api/nlq/webhook`** (#313): the advertised `/api` spelling of the NLQ
  inbound webhook is now implemented. All three spellings — `/nlq/webhook`,
  `/api/trading/nlq/webhook`, `/api/nlq/webhook` — delegate to one single-owner
  handler (`handleNlqWebhookRequest` in `src/server.ts`), so the throttle,
  HMAC signature verification, replay protection, and NLQ forwarding behave
  identically for every spelling. Previously the advertised `/api` form 404'd.
- **Reports tab + schedule management UI** (#309): browse/search persisted
  reports and manage schedules from the UX, reading the same store.
- **AI Search result cache + scheduled-report persistence** (#278):
  TTL cache over AI Search results (scope-bound keys, hits audited); all
  scheduled-run reports (market screens, IV collection, retention runs)
  persist for later retrieval.
- **Report-dispatch HITL setting** (#277): Settings toggle
  `reportDispatchHitl` (default off — dispatch stays autonomous); when on,
  report email/webhook dispatch holds for approve/reject with a 24h
  pending window.
- **Advertised `POST /api/chat` route** (#312): the route the UX/docs
  advertised is implemented, delegating to the platform's canonical chat
  handler.
- **Documented `POST /api/chat` response contract** (#325): the endpoint
  catalog entry no longer advertises a streaming route — it documents the
  real synchronous response (`reply`, `route`, `model`, `streaming: false`)
  with a rendered sample in the API explorer, and
  `docs/async-capabilities.md` now lists the immediate-sync `/api/*`
  exceptions (chat included) instead of claiming every request returns
  `202`.
- **Judge + NLQ golden evaluation sets** (#258): 105 labeled judge-routing
  queries and 29 NLQ questions with accuracy/regression thresholds in CI.
- **Per-run PDF naming** (#297): screener PDFs are stored per run as
  `{screener}_{universe}_{schedule}_{timestamp}_{jobId}`.
- **Auto-tag every deploy** (#321): the deploy workflow tags each
  successful production deploy `v0.1.<patch>` (auto-incrementing),
  pointing at the deployed commit for rollback and release tracking;
  milestones bump minor/major manually.

- **Autonomous options research + trade-idea validation agent** (#319): a new
  `ResearchAgent` Durable Object runs a daily after-close pipeline (OODA loop
  with budget) — market regime, screened universe, live E*TRADE quotes and
  option chains, Yahoo technicals — and publishes a canonical report via the
  `options_research` seam into `mas_reports` (one stored copy; Reports tab and
  AI Search read it). Stage gates (§5) enforced as code with the spec's
  failure actions (data integrity → Unverified; contract/thesis/strategy/risk
  → Rejected with reason; soft quote-quality → Watchlist-only); every
  shortlisted idea carries the seven-question falsification (§4), a pre-mortem
  (§7), five scenario rows with fees/slippage/assignment limitations (§8), and
  an independently recomputed economics table (SDK-free Black-Scholes
  module — PMCC modeled on the long call's residual value; the
  width-minus-debit trap is pinned by test). Max 5 Qualified ideas;
  "No qualifying opportunities" is a valid published outcome. Filters and
  thresholds live in a typed config service (spec defaults as fallback) with a
  filter editor + run controls + trade-card view (`ResearchRunsPanel`);
  every run embeds its effective config snapshot; §9 evaluation replays later
  prices against the pinned stored record (versioned rules, no retrospective
  edits). Read-only: no order path exists from any research module (boundary
  test pins it). Routes: `POST /research/run`, `POST /research/scheduled-tick`
  (21:00 UTC weekdays via new wrangler cron), `GET /research/latest`,
  `GET /research/history`, `GET/POST /research/settings`, `POST
  /research/evaluate`.
- The options subtab gains an "Autonomous runs" toggle next to the existing
  per-symbol "Symbol research" view; manual and scheduled runs are thin
  triggers over the single pipeline entry and surface in the same views
  labeled by trigger source (manual | scheduled).

### Changed

- **Trading boundary** (#290): all trading code is imported solely through
  `src/trading/index.ts` (enforced by a boundary test); secret namespacing
  audited — trading secrets are read only inside `src/trading/`, with the
  `ET_*` convention documented in `docs/COMPLIANCE.md`.
- **Options scanner defaults** (#296): scans default to the NASDAQ-100
  universe instead of 4 symbols; scanner delivery tries the cfpay A2A
  Slack/Email path first with local fallback (#303).
- **Reports/Schedules panels wired into navigation** (#324): the #309
  panels are reachable from the app navigation (NavigationMenu +
  ETradeTradingHub) instead of existing as orphan surfaces.

### Security

- **Advertised `POST /api/audit/event` implemented** (#270): strict
  validation, tenant-scoped writes into `mas_events` via the single
  `recordAudit()` owner; the advertised surface is real, per the
  no-fabrication rule.
- **SECURITY.md + threat model** (#276): security policy, threat model,
  and disclaimer documents added.
- **NLQ execution observability** (#257): every NLQ execution writes a
  timed structured event (no raw query text); wrangler log observability
  made explicit.

### Fixed

- **Storage lifecycle** (#255): nightly retention pass enforces the
  advertised 90-day window on `mas_messages` (configurable, batched,
  audited per run).
- **Screener data quality** (#294, #295): E*TRADE quote failures fail fast
  on auth instead of returning zero-price stubs; Yahoo history fetch
  carries diagnostics so empty technicals are explainable.
- **Advertised E*TRADE routes** (#314): `POST /api/broker/etrade/environment`
  (the `ETradeDynamicMenu.tsx` fallback) delegates to the same single-owner
  environment-switch handler as `/api/environment/switch`, and the
  doc-advertised `POST /api/etrade/options/strategy` (Workflow A2) delegates
  to the same strategy-discovery handler as `/trading/options/recommend` —
  E*TRADE chain snapshot, screened contracts, and the real
  `recommendOptionStrategies` engine (Black-Scholes Greeks, model-implied
  POP, EV, payoff curves) with byte-identical responses across spellings.
  Also resolves leftover merge markers in this changelog from the #325
  rebase.

## [0.1.0] - 2026-10-18

First tagged release. Assessment P0 hardening wave (#143).

### Security

- **NLQ table allowlist** (#245): a 25-table allowlist derived from the NLQ
  planner's real targets; every other table is refused at the execution seam.
  Classic SQL injection was already closed by parameter binding — verified
  before the fix.
- **Webhook replay cache + `emailTo` domain allowlist** (#249): provider-derived
  nonces with 24h TTL; duplicate TradingView / E\*TRADE / NLQ deliveries are
  rejected 409 before any order mutation. `EMAIL_TO_ALLOWED_DOMAINS` restricts
  email delivery targets (inert until configured).
- **SSRF guard + rate limiting** (#242): URL validator on outbound webhook
  dispatch; token-bucket throttling (429 + Retry-After) on the NLQ webhooks and
  the memory search route.
- **Secret scanning** (#239, #251): gitleaks workflow installed and active;
  its pull-request scan path was broken by a missing `GITHUB_TOKEN` env and is
  now fixed — every PR is scanned.

### Added

- **Storage retention** (#262): nightly pass in the scheduler deleting
  `mas_messages` rows older than `MAS_MESSAGES_RETENTION_DAYS` (default 90,
  `<=0` disables), with a per-run cap and a `mas_events` summary record.
  This enforces the 90-day retention the UI advertises.

### Docs

- **Collaboration protocol** (#252): branch-as-lock shared rule for
  multi-agent coordination, documented in `docs/collaboration.md`.
