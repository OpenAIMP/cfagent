# System-wide duplicate/overlap scan — successor to #1638

## Agent

#CISO-bhdm

## Program

Parent issue: **#1717** — "System-wide duplicate/overlap unification program — successor to #1638 (tracker)".
This document is the published Phase A scan for that program. It is a tracker + scan
publication only; no unification slice is built by this document. Phase C builds land
as one PR per domain sub-issue under #1717.

Location note (owner-directed exception for this program's scan reports ONLY):
this report lives in `docs/compliance/`, not the usual `docs/architecture/security/`.
The file name carries the parent issue number, as directed.

## Predecessors — read, not reopened

- **#1638 (closed, §15 comment 6413119056)** and its slices #1639 (discovery kernel),
  #1640 (ranking/weights/promotion core), #1641 (report pipeline), #1642 (portfolio
  repair contract), #1643 (MarketDataService facade), #1644 (REST→IMcpToolCommand).
  Its inventory doc `docs/compliance/multiple-implementations.md` was read first by
  all three scans; §Reconciliation notes in the appendices state what is already
  unified vs still open.
- **#1690 / #1711 (closed, DONE)**: payments HITL-draft flow + `PAYMENTS_FLOW_MODE`
  (hitl|immediate) configurable pattern. Not rebuilt by this program, except the
  re-scope slice (o) below.
- **Open #1257** (champion/challenger promotion): domain (j) coordinates with it;
  it does not compete with it.

## Scope boundary (owner amendment, 2026-10-26)

IAAA implementation was previously CTO-lane-only with this lane assurance-only.
The owner has now directed remediation of IAAA enforcement gaps AS PART OF THIS
PROGRAM — that is the authorization for this program to carry those slices:
(a) legacy-session PDP exemption (close it or bound it with an explicit
expiry/migration rule; source `docs/architecture/security/authz.md` §6/§8);
(b) numeric revocation-propagation targets per trigger plus tests proving each
(also #945 adoption Q6); (c) obligation/advice channel, or an explicit documented
decision that ad-hoc gates stand; (d) authn gaps — TOTP/WebAuthn/magic links as a
scoped slice (product decision first: IdP-inherited 2FA is the current design, so
the slice must record whether app-level factors are in or out BEFORE building).
If any such slice turns out to be CTO-lane implementation already in flight (live
claim branch or open PR), that slice stands down per branch-as-lock and is reported,
not duplicated. Those IAAA sub-issues are added by a post-Phase-B amendment step;
the (a)–(o) domain list below is therefore NOT the final program scope.

SECURITY GUARD (applies to the whole program, and to every IAAA sub-issue): the
never-either/or/always-configurable rule does NOT mean a caller can configure away
their own enforcement. IAAA gate switches (if any) are admin/platform-controlled,
default fail-closed, and never user- or session-configurable by the subject being
gated. A scoped config that lets a caller disable their own PDP gate is a defect.
Behavior variants may be configurable; enforcement itself may not be opt-out.
Run/session/user scoping applies to BEHAVIOR variants, never to disabling
enforcement for the caller.

## Method and scan head

- Three read-only scans, no branches, issues, PRs, pushes, edits, or deletes made
  by the scans themselves. Fresh read-only clones; the standing clones
  (`~/workspace/cfagent-work` etc.) were NOT touched.
- **Scan head: `23de3ce`** (`23de3ceb4cf9833a55d09f2bcd902c2558332fc9`,
  `feat: Fractal Pivots (n=5) & Fibonacci Retracements (#1654 slice 4/8) #CTO-mbshr`).
  All file paths below are relative to that tree.
- This doc PR's branch base is current main at PR time (`5a35582` at publication);
  the scan evidence itself is pinned to `23de3ce`. If main moved between scan and
  slice build, the slice re-verifies its pairs against its own fresh base.
- Verdict key: **IDENTICAL** = same observable contract for the same operation
  (presentation-only shape deltas are noted, not counted as divergence).
  **DIVERGENT** = the two surfaces differ in id scheme, money default, rounding,
  error semantics, audit, auth gate, update path, provider selection, provenance,
  TTL, or coverage for the same operation. **UNIFIED (#1644)** = execution already
  routed through the MCP command; only presentation deltas remain.
  **UNPAIRED** = no counterpart on the other surface exists at all.
  **DORMANT** = code present with no live route/caller found in the scan — still a
  finding, not a live race.
- A verdict of DIVERGENT does not by itself mean "merge them" — several divergences
  are ratified design decisions (#1642 two-level repair, #1711 payments switch,
  #1257 challenger promotion, WS continuity design); they are recorded so the
  program decides explicitly, not by accident.

## Counts

| Scan | Finding-rows | IDENTICAL | DIVERGENT | UNIFIED (#1644) | Open carry-over |
|---|---:|---:|---:|---:|---:|
| Payments / reports / repair / categories-referrals-ads | 22 | 7 | 15 | 0 | 0 |
| Market-data / discovery / ranking / weights / promotion | 26 | 6 | 20 | 0 | 0 |
| REST routes / MCP registry (51 tools) | 45 | 3 | 37 | 4 | 1 |
| **Raw total** | **93** | **16** | **72** | **4** | **1** |

## Dedupe: 93 rows → 84 unique pairs

Cross-scan overlaps were removed BEFORE defining domains. The tracker reflects
deduped domains, not 93 sub-issues. Each row below was counted in two scans and
is one unique pair:

| # | Overlap | Scans | Unique pair(s) kept |
|---|---|---|---|
| 1 | Categories route vs command | payments C-1 = routes M05 | categories (domain a) |
| 2 | Referrals route vs command | payments C-2 = routes M06 | referrals (domain a) |
| 3 | External ads route vs command | payments C-3 = routes M07 | external ads (domain a) |
| 4 | Revenue summary | payments C-4 = routes M08 | revenue summary, IDENTICAL (domain a) |
| 5 | Payments create/confirm/gateways/transactions | payments P-1..P-4 = routes M02 (one row) | 4 pairs, UNIFIED with presentation deltas (domain h) |
| 6 | Agentic wallet | payments P-5 = routes P03 | wallet/limit (domain h) |
| 7 | Premium paid tools | payments P-6 = routes P01/P02 | paid screener + paid research (domain h) |
| 8 | Quote surfaces (batch/market quotes) | market M10 = routes R02 (partial) | quote-surface pair counted once; M10 → (e), R02 → (m), cross-referenced |
| 9 | Report-generator carry-over | routes R07 = payments R-1..R-7 domain | carry-over row, not a new verdict (domain k) |
| 10 | Foss MCP quote leg | routes F01 (quote leg) ⊂ market M10 / routes R02 | quote leg deduped; F01 row kept for fundamentals + research legs (domain g) |
| 11 | AgentDB jobs projection | routes G04 (jobs.history) ⊂ routes J01 system 3 | projection counted once as a pair in (i); J01 keeps it as one of three systems (domain d) |

**84 unique pair-rows.** Two register splits add rows back against the 11 overlaps:
M2b is carried as its own register row (the market scan's counts table folds it
into M2), and P-6 is split into paid-screener / paid-research rows (the payments
scan's counts table holds it as one row). Arithmetic: 93 − 11 + 2 = 84. Domain row counts (scan rows only; slice (o) is a program
slice, not a scan row): (a) 4, (b) 3, (c) 2, (d) 4, (e) 14, (f) 6, (g) 5, (h) 8,
(i) 4, (j) 10, (k) 10, (l) 4, (m) 6, (n) 4. Total 84.

## Standing rules (owner directives 2026-10-26 — also in the parent and every sub-issue)

- NEVER EITHER/OR, ALWAYS CONFIGURABLE: divergent contracts keep BOTH paths behind
  ONE runtime config switch per pair (the `PAYMENTS_FLOW_MODE` #1711 pattern).
  Never remove an API endpoint. Never delete a code path to settle a divergence.
  No new stores/engines unless the scan proves one is required (say so in the
  issue first).
- SCOPED DEFAULTS (supersedes any single global default): every switch resolves
  per user, per session, per run. Resolution order: run-scoped value >
  session-scoped value > user-scoped value > global env default > built-in default
  (current PUBLIC ROUTE behavior; HITL for payments). Where a scoped override path
  does not exist yet, building it is part of that slice. Record the order in each
  slice's PR body and §15. (Exception per the Security Guard above: scoping
  applies to behavior variants, never to disabling enforcement for the caller.)
- DEFAULT RULE where the owner has not decided: default = current public route
  behavior, recorded explicitly in the PR body and §15 so the owner can overturn
  it later (e.g. ads defaults would default to route behavior cpm 15.0 /
  cpc 1.25 unless the owner says otherwise — record, don't decide).
- SAFETY: no slice may weaken a control. The E*TRADE MCP execute path (f, E04)
  must ADOPT the route's HITL gate — never bypass it. The goal.schedule
  PENDING-vs-LIVE distinction (i) must be preserved, not collapsed. The NLQ
  webhook social-brief withholding (b) must be preserved.
- RUNTIME-CONFIRM BEFORE BAKING A DEFAULT: the M2b HTTP env-drop is a static
  call-site fact; the slice must runtime-confirm it before writing it into a
  program default.
- GITOPS FOR SLICES: branch-as-lock (check live claim branches AND open PRs
  before claiming), Red pins before change (both modes where a switch is added),
  CHANGELOG [Unreleased] entry in the same PR, §9 PR body, READY PR (no drafts),
  rebase-merge ONLY on a green gate on the exact ready head including Policy Gate,
  branch deleted + verified gone, post-merge CI/Deploy verification reported
  honestly (state any unobserved gap, do not claim it), §15 report, close +
  verify. A red check on a slice = diagnose and STOP, never merge around it.
- LANE BOUNDARIES: do not touch any other lane's PR, do not assign to Copilot,
  Dependabot untouched, do not touch #945 implementation except the
  owner-directed IAAA enforcement-gap slices in this program's scope (with
  branch-as-lock stand-down if CTO-lane work is already in flight).

## Pending appendix (docs/architecture/ mining)

A separate mining scan of all of `docs/architecture/` is running in parallel and
will feed the IAAA slices above plus further doc-sourced sub-issues. Its report
file (`~/workspace/tmp-issues/scan-docs-architecture.md`) did NOT exist when this
doc PR was published, so no mining appendix is folded in here. The follow-up
amendment step will add a findings appendix (doc → finding → sub-issue) to this
document via its own gated PR. Do NOT reopen this doc PR to add it.

## Master register — all 84 unique pairs by domain

Detail (implementations, file paths, full contract deltas) is in the per-domain
appendices listed in §Appendix map. This register is the complete index: if a
pair is not listed here, it is not part of the deduped scan.

### (a) Categories / referrals / external ads — 4 pairs

| ID | Pair | Verdict |
|---|---|---|
| C-1 / M05 | REST `/categories` vs MCP `manage_categories` (`src/agents/routes/adsRevenueReferrals.ts` vs `src/mcp/commands.ts`) — id `cat_<slug[0:16]>_<uuid4>` vs caller/deterministic `cat_<name>`; slug 32-trunc + trim (route create) vs no trim/trunc, update never touches slug (MCP); description `Category for ${name} partner links` vs `${name} category tools and services`; sortOrder count+1 vs fixed 10 (`\|\|` swallows 0); update field set (route incl. slug/isActive, MCP name/icon/description/sortOrder only); delete silent-success (route) vs throw (MCP); route audits, MCP none | DIVERGENT |
| C-2 / M06 | REST `/referrals` vs MCP `manage_referrals` — category `AI & Dev Tools` vs `AI Tools`; reward `Community referral reward` vs `$10 Free Credits`; list `created_at DESC LIMIT 100` camelCase vs `clicks DESC` uncapped raw; click silent-success vs throw + new count; route audits create, MCP none; no update on either | DIVERGENT |
| C-3 / M07 | REST `/external-ads` vs MCP `manage_external_ads` — id `ext_<network>_<uuid6>` vs `ext_ad_<uuid8>`; **money: cpm 15.0 vs 2.5, cpc 1.25 vs 0.45** (6× / ~2.8×); create impressions 1 + earnings cpm/1000 vs 0/0; placement `header_leaderboard` vs `in_stream`; network `direct` vs `ethicalads`; rounding impression 3dp vs 4dp, click 2dp vs 4dp; update route-only; list `earnings DESC` vs `created_at DESC`; route audits, MCP none | DIVERGENT |
| C-4 / M08 | REST `GET /revenue` vs MCP `get_revenue_summary` — route passes command output unchanged (`orm.getRevenueSummary()`) | IDENTICAL |

Sponsored `/ads` (`mas_ads`) is NOT the REST half of external ads: different table,
different fields, no MCP mirror — do not merge without a separate decision.

### (b) NLQ unification — 3 pairs

| ID | Pair | Verdict |
|---|---|---|
| M03 | MCP `execute_nlq` vs REST `POST /nlq` — route requires `x-user-login` (401), full ports/stores/runners, LLM validation, sync result, `nlq.executed` audit; MCP over `/mcp` returns an async-job receipt, facade path has NO ports/stores/runners/validation, `userLogin = sessionId`; direct factory path has no options at all | DIVERGENT |
| N01 | NLQ port matrix — 4 execution contexts (REST sync, async job `nlq.execute`, MCP via facade, MCP direct) × scheduling / stock-screen / social-brief / discovery+fit / scan-profile stores / identity / LLM validation — see appendix (b) matrix | DIVERGENT |
| N02 | Webhook NLQ social-brief withholding — webhook origin ⇒ `socialBriefPort = undefined` (honest failure, never a public-post input without human approval); header can only REMOVE the port, never grant it; scheduling + discovery NOT withheld on webhook path | DIVERGENT (by design — preserve) |

### (c) Knowledge + memory unpaired surfaces — 2 pairs

| ID | Pair | Verdict |
|---|---|---|
| M01 | MCP `knowledge_search` vs MCP `query_platform_knowledge` (both `src/mcp/commands.ts`, UNPAIRED vs REST) — AI-Search/Vectorize chunks (≤5) + platform fallback (max 3) + `chunks`/`message` shape + no-throw error shape vs always-platform (max 5, category filter) + `results` shape; unifying changes ranking, 3-vs-5 cap, error contract | DIVERGENT |
| M09 | MCP `manage_session_memory` vs REST `GET|DELETE /memory` — list/delete/clear bridged via `runRestTool` (route caps 100, remaps, adds `memory.deleted/cleared` audits); **gap: `remember` has NO REST route** (MCP-only write); MCP resource `sqlite://memory/facts` uncapped vs REST capped at 100; audit resource session-filtered limit 30 vs `get_audit_events` unfiltered | UNIFIED-partial + UNPAIRED write |

Corpus routes (`POST /knowledge/corpus`, `GET /knowledge/file`, R2 ingest/serve)
are adjacent, NOT duplicates of search: ingesting a corpus doc does NOT make it
searchable by M01 tools by any verified path — a missing index bridge would be a
new feature, not a unification.

### (d) Async jobs systems — 4 pairs

| ID | Pair | Verdict |
|---|---|---|
| J01 | Three job systems all called "jobs": (1) async jobs `mas_async_jobs` (submit → uuid + `statusUrl /api/jobs/{id}`, retry, 12 MB cap, 2 h stale-running auto-fail); (2) job outcomes `mas_job_outcomes` (outcome-event sink, upsert by stable id, limit 1–200 default 50, no retry, not queryable by async jobId); (3) AgentDB shard-job projection (per-chain projected rows, may lag one transition, operator reconcile) — colliding `/api/jobs/*` prefix (history/reconcile are Worker branches running BEFORE the DO `/jobs` handler) | DIVERGENT |
| J02 | Sync-vs-queued delivery split — same route handler is synchronous for `/api/etrade/*`, `/api/trading/*`, `/api/options/*`, `/api/screener/*` etc. but a 202-queued job (`capability:"http.request"`, 8 MB cap, only content-type/accept/`x-environment`/validated `x-user-login` forwarded) for `/api/payments/*`, `/api/categories`, `/api/referrals`, `/api/ads`, `/api/knowledge/*`, `/api/autopilot/*`, `/api/reports/*`, `/api/research/*`, `/api/foss/*`, `/api/watchlists/*`; over `/mcp`, EVERY tool except `get_async_job`/`list_async_jobs` returns a job receipt when `submitJob` is present | DIVERGENT |
| M04 | MCP `get_async_job` / `list_async_jobs` vs REST `GET /jobs[/{uuid}]` — same `mas_async_jobs` table, three envelopes (MCP list `{count, jobs}`, REST list `{jobs}` no count + limit default 50 clamped 1–100, REST single full record incl. `result`); missing job throws / 404 `Async job not found.`; MCP list takes no limit; both EXEMPT from J02 wrapping; REST-only `POST /jobs/{uuid}/retry` (failed-only, 404/409/500, duplicate-retry refusal) | DIVERGENT-minor |
| S5 | Research vs screener task ledgers (`researchTaskLedger.ts` #577 vs `screenerTaskLedger.ts` #607, "the screener mirror") — same lifecycle (create+begin, heartbeat, deterministic outcome, total failure → ESCALATED, #615 stale sweep), different stores (`research_task_store` vs `screener:task:`/`screener:idem:`), different owning agents | IDENTICAL (pattern; separate stores intentional) |

### (e) Market-data / quote unification — 14 pairs

| ID | Pair | Verdict |
|---|---|---|
| M1 | `MarketDataService` facade (#1643) — HTTP read unified ONLY: `handleMarketQuotesHttp` (both `/api/market/quotes` + `/api/foss/quotes` alias) resolves via `resolveMarketDataQuotes()` over `liveMarketCache` (expired → `unavailable`, provenance `cached`/`unavailable`, never `live`); NOT behind it: WebSocket, `quoteCache`, all provider fetchers | DIVERGENT (partial unification, carry-over) |
| M2 | HTTP snapshot vs WebSocket stream — same cache, opposite expiry: HTTP honours `expiresAt` (expired → `unavailable`); WS/`getBatchMarketQuotes` ignores it (last-known-quote continuity by design); shapes differ (HTTP provenance/fetchedAtMs/ageMs vs WS snapshot/ticks with no provenance/age); HTTP unawaited background refresh vs WS 5 s loop | DIVERGENT |
| M2b | HTTP entry point can never use Alpaca — `server.ts:2200` calls `handleMarketQuotesHttp(symbols)` with NO `env`, so the Alpaca leg (requires `env.ALPACA_*` keys) is skipped: HTTP refreshes are Yahoo-only even when Alpaca is configured; WS passes `env` and can use Alpaca. **Static call-site fact — runtime-confirm before baking a default** | DIVERGENT |
| M3 | `marketStream.fetchRealMarketQuote()` Alpaca leg vs Yahoo leg — Alpaca mid `(bid+ask)/2` 2dp (both > 0), prev-tick change, real NBBO bid/ask, volume literal `"—"`, name = raw symbol, 20 s TTL, exception → Yahoo fallthrough; Yahoo wire price unrounded, wire prev-close change, SYNTHETIC spread (0.0006 equities / 0.0004 crypto), string volume, `longName\|shortName\|symbol`, 30 s TTL | DIVERGENT |
| M4 | Yahoo Finance, three implementations — (a) marketStream v8 chart 1d, 30 s, synthetic bid/ask, string volume; (b) Foss single v8 1mo, 5-min `quoteCache`, wire bid/ask or omitted, numeric volume, `open = (high+low)/2`, RSI/MACD, crumb enrichment, throw on failure; (c) Foss batch v7 quote endpoint, crumb-required, wire open, NO RSI/MACD, omission on missing symbols | DIVERGENT |
| M5 | Alpaca, three implementations — (a) marketStream (prev-tick change, volume `"—"`, Yahoo fallback, 20 s); (b) Foss `AlpacaMarketDataProvider` (change 0/0 always, volume 0, all OHLC = mid, `companyName "<SYM> Asset"`, no cache, throws, never falls back); (c) `AlpacaTradingPlatform` wrapping (b) into `ETradeQuote` (name overwritten `<SYM> (Alpaca Real-Time)`, fresh ISO timestamp, NO `quoteStatus`, explicit `userLogin` required #1185) | DIVERGENT |
| M6 | "Is Alpaca configured?" — three rules: hybrid Foss requires `_ID` + `_SECRET_KEY` spellings ONLY; marketStream + platform accept either spelling on both sides. Same env, different provider | DIVERGENT |
| M7 | E*TRADE quote chain, five surfaces — wire client (`fetchQuoteDetailed`/`fetchQuote`/`fetchQuotes`), platform `getQuote` (live → cached → curated → throw `AUTH_REQUIRED`, stub-quote rejected via shared `isStubQuote`), service sync `getQuote` (NEVER live; unknown → zero-price object, NOT a throw), service async `getQuoteAsync`/`fetchQuoteRemote` (inline stub-heuristic copy, live → throw, non-live → platform fallback), policy `fetchQuoteLiveStrict` (live + no good quote → throw; what MCP `etrade_get_quote` uses). Curated non-live default `defaultPrice ?? 100.0` | DIVERGENT |
| M8 | Two quote caches, never shared — `liveMarketCache` (bare key, 20/30 s, `MarketTickData`, epoch-ms) vs `quoteCache` (namespaced `yahoo:<SYM>` keys, fixed 5 min, 500-entry cap, `FossQuote`/listings, ISO timestamp). A symbol can be fresh in one and stale/missing in the other | DIVERGENT |
| M9 | DataProvider adapters vs direct Foss providers — same fetch, different envelope (tag/capture/outcome records, Yahoo-only batch); registry (`DataProviderRegistry` #1118) routed primary + gap-fill, NO silent fallback (`DataProviderNotFoundError`, tier errors) — a THIRD selection semantic vs hybrid-env gate (M6) vs marketStream silent fallthrough (M3) | DIVERGENT (envelope/selection; payload identical) |
| M10 | Quote surfaces across protocols — market HTTP (no auth, no audit, 200 always incl. all-unavailable, facade provenance, `MarketTickData`) vs Foss REST `/foss/quote` (no session check, default `NVDA`, provider default `hybrid`, failure → 500, no quote audit) vs Foss MCP `foss_get_quote` (symbol 1–20 zod, audited `foss.quote.fetched`, throws) vs E*TRADE MCP `etrade_get_quote` (symbol 1–10 zod, session-bound login, LiveStrict, audited `etrade.quote_fetched` with different fields, `ETradeQuote`); NO dedicated REST E*TRADE quote route exists | DIVERGENT |
| M11 | Public.com quote-row mapping (`publicData.ts` `extractPublicQuoteRows`/`mapPublicQuoteRow`) — PARTIAL `ETradeQuote` (only carried fields set, absent fields OMITTED never zero-filled, no `quoteStatus`, no provenance stamp); NOT behind #1643 facade or DataProvider registry (Public is a seeded registry descriptor, not a servable adapter) | DIVERGENT |
| M12 | Screener quote acquisition — E*TRADE leg + Yahoo leg share ONE evaluator (`screenWithQuotes`); filter semantics identical, only quote source changes; Yahoo failure throws → qualified-partial or 502, never E*TRADE fallback | IDENTICAL (evaluator) |
| S4 | Research-provider seam vs DataProvider registry — single E*TRADE provider with honestly-empty degradation vs config-driven routed/tiered registry with capture + throw-on-unservable; same provider classes underneath, different selection/auth/error/capture | DIVERGENT |

### (f) E*TRADE MCP vs REST — 6 pairs (SAFETY-CRITICAL: E04)

| ID | Pair | Verdict |
|---|---|---|
| E01 | MCP `etrade_market_scan` vs REST `/etrade/screen` — MCP `screenMarketsAsync` (listings screen, audit `etrade.market_scanned`) vs REST `ScreenerAgent` tracked pipeline + canonical report + `etrade.screened` audit | DIVERGENT |
| E02 | MCP `etrade_get_quote` vs REST `GET /etrade/quote` — same `fetchQuoteLiveStrict` + platform; MCP no TEST/PROD override, sessionId-as-login, adds audit; REST `x-environment`/`?env`, `x-user-login` gate, no-cache headers, missing symbol → `NVDA` | DIVERGENT-minor |
| E03 | MCP `etrade_preview_order` vs REST `POST /etrade/order/preview` — MCP local draft (equity only, no option legs/stopPrice/asset-class validation, silent action fallback) vs REST broker preview (equity + option legs, validation, autopilot policy-verdict 409/503 gates, 15-min expiry schedule, payload-hash audit, `x-user-login` gate) | DIVERGENT (safety-relevant) |
| E04 | MCP `etrade_execute_order` vs REST `POST /etrade/order/execute` — MCP `executeOrder(orderId, sessionId, decision)` ONLY; NO 403 `did:agent:` HITL gate, NO draft-exists 404, NO `previewed`-status check, NO payload-hash comparison, NO remote `placeOrderRemote`, NO Slack snap, NO autopilot-orders-today increment, NO expiry-timer cancellation — all present on REST. **The slice must make MCP adopt the route's HITL gate, not bypass it** | DIVERGENT (SAFETY-CRITICAL) |
| E05 | MCP `etrade_get_positions` vs REST `GET /etrade/positions` — MCP `fetchPortfolioRemote()` + `fetchAccountsRemote()` reshaped envelope vs REST `fetchPortfolioRemote(undefined, true)` spread + `error` field only when unconnected; second remote call on MCP | DIVERGENT-minor |
| E06 | MCP `etrade_auth_status` / `etrade_account_discovery` vs REST — same `getStatusAsync`/`fetchAccountsRemote`; MCP no gate/env handling, REST `x-user-login` gate + `requestedEnv`; discovery envelope `{count, accounts, asOf}` vs `{count, accounts}` + 502 on empty-with-upstream-error | DIVERGENT-minor |

### (g) FOSS MCP vs REST — 5 pairs

| ID | Pair | Verdict |
|---|---|---|
| F01 | MCP `foss_get_quote` / `foss_company_fundamentals` / `foss_market_research` vs REST — same service calls; MCP research audit `foss.research.generated` vs REST `foss.research_generated` (dot vs underscore — different event names, same operation); REST defaults symbol `NVDA`, MCP requires it; REST no audit on quote/fundamentals, MCP audits inconsistently (snapshot/bars/research but not quote/fundamentals) | DIVERGENT-minor |
| F02 | MCP `foss_historical_bars` vs REST `GET /foss/bars` — same `getHistoricalBars`; REST explicit provider (default `yfinance`), fuller envelope, no bars audit; MCP no provider arg (service default), smaller envelope, audits `foss.bars.fetched` | DIVERGENT-presentation |
| F03 | MCP `foss_alpaca_snapshot` vs REST `GET /foss/snapshot` — same `getAlpacaSnapshot`; audit `foss.alpaca.snapshot` vs `alpaca.snapshot_queried` with different payloads; REST defaults `NVDA`, MCP requires symbol | DIVERGENT-minor |
| F04 | MCP `foss_alpaca_account` / `positions` / `orders` vs REST twins — same service calls; MCP audits `alpaca.account.query` etc. (verb `query`, no result payload) vs `/foss` REST `alpaca.account_queried` etc. with result payloads vs `/trading` REST no read audits; orders status MCP schema `open\|closed\|all` (no default) vs both REST twins default `open` | DIVERGENT |
| F05 | MCP `foss_alpaca_place_order` vs REST order twins — same `placeAlpacaOrder`; MCP verbatim input (no qty default, no uppercasing, no aliases, `limit_price` only), audit `alpaca.order.place` full field set; REST twins default qty 1, normalise case/aliases, audit `alpaca.order_placed` different payloads | DIVERGENT |

### (h) Agentic payments + premium gating — 8 pairs

| ID | Pair | Verdict |
|---|---|---|
| P-1 / M02 | REST `POST /payments/create` (HITL) vs MCP `draft_payment` — shared core (id `pay_<uuid8>`, `awaiting_confirmation`, `""` checkoutUrl/gatewayRef, amount finite > 0 #524, DID attestation, #932 draft-owner, `payment.awaiting_confirmation` audit); transport deltas: route rejects unsupported gateway 400 BEFORE row write, command does not validate gateway (zod enum not parsed at execution); omitted description → `""` (route, #514 pin) vs generic `Payment intent for ${customer}` (direct MCP); customer-required declared vs effective; route HTTP 400/500 vs MCP throw | DIVERGENT (narrow, delegated core) — UNIFIED execution, presentation/transport deltas to pin |
| P-2 / M02 | REST `POST /payments/confirm` (HITL) vs MCP `confirm_payment_draft` — shared transition (approved charge/invoice → unconditional facade checkout; approved refund → refund; note defaults; `payment.confirmed`/`payment.rejected` audits); deltas: missing draft 404 (REST) vs throw (MCP); REST envelope `{success, status, draftId, checkoutUrl, gatewayRef, authorizerDid}` vs MCP adds `executorDid`/`decision`/full transaction. **Shared gap (both layers): neither checks facade `createCheckout`/`executeRefund` success flag before writing `status: "completed"`** — a failed checkout at confirm can mark a draft completed with empty checkoutUrl/gatewayRef (limitation already recorded against #1690/#1711, confirmed on current main) | DIVERGENT (error + shape; transition shared) |
| P-3 / M02 | REST `GET /payments/transactions` vs MCP `get_transactions` — route executes via `runRestTool`, fixes limit 50, ignores `status` filter, re-maps rows (string coercions, `gateway` default `stripe`, `proposerDid` default `AGENT_DIDS.PAYMENTS`), adds `summary` (totalVolume/completedCount/pendingCount/verifiedDidCount); command accepts limit + status, raw rows + `count`, no summary | DIVERGENT (presentation + filter) |
| P-4 / M02 | REST `GET /payments/gateways` + `/payments/status` vs MCP `get_payment_gateways` — same `PaymentGatewayService.getGatewayStatuses()` + `AGENT_DIDS`; command's extra `count` field dropped by route (3 fields) | IDENTICAL (core) |
| P-5 / P03 | Agentic wallet REST vs MCP `agentic_wallet_status` — shared core (simulated $50 local-ledger balance, per-identity persisted limit `agentic:autoApproveLimitUSD:<sessionId>`, env default `X402_AUTO_APPROVE_LIMIT` 0.05, network `base-sepolia`); deltas: route accepts `limitUSD` OR `limit`, command only `limitUSD`; route POST neither → 400, command undefined → silent fall-through to status read; route rejects negative/NaN 400, command passes through (service throws, uncaught → error not 400); route audits `agentic_payment.limit_updated`, command audits nothing; shapes differ (raw vs `{success: true, ...}` vs message string); payer-bound (`x402:<payer>`) vs session wallet reads differ by construction (#183) | DIVERGENT |
| P-6a / P01 | Premium gated REST vs MCP `paid_options_screener` — shared price $0.05, x402 challenge (15-min nonce), claim verification, replay guard, `agentic_payment.tool_executed` audit; deltas: MPP end-to-end on REST (`handleMppRequest`, `WWW-Authenticate`, receipt) vs MCP `verifyPayment` explicitly rejects MPP (x402-only in practice); real HTTP 402 vs 402-shaped object; MCP `channel:"mcp"`/`userLogin=sessionId`/no capture vs REST `channel:"webhook"`/`callerTier:"premium"`/platform deps/capture+run-linking; MCP single `underlying` vs REST also GET query-string spelling | DIVERGENT |
| P-6b / P02 | Premium gated REST vs MCP `paid_market_research` — same tier $0.10, same `generateResearchReport` core, same gate/channel/identity/capture deltas as P-6a; **REST-only: `/premium/stock-signals` ($0.02, ScreenerAgent + Yahoo adapter) has NO MCP counterpart** | DIVERGENT |
| P-7 | Agentic ledger REST vs PaymentsAgent ledger client — client is a TRANSPORT to the same route over the `SEARCH_AGENT` DO channel (fail-loud when unbound); one mapping pair (cents ↔ dollars, idempotencyKey ↔ gatewayRef), one duplicate rule (existing → 409 `{duplicate: true}`), one budget derivation (`deriveBudgetGuardState`, today-only, `seenKeys` capped 2000, inbound never counts); route clamps list limit 1–500 (default 50), insertion-order tie-break | IDENTICAL (single ledger of record) |

Single-surface payment items (no counterpart — listed, not counted as pairs):
`POST /payments/capture` (route-only, PayPal/Stripe capture, audits `payment.captured`
only on success), `POST /payments/webhook` (route-only, HMAC, default-deny incl.
sandbox #148, #932 draft-owner forwarding, loud-unmatched settlements),
`GET /payments/dids` (route-only DID document resolver).

### (i) Goal chain + AgentDB jobs/audit/reports vs live routes — 4 pairs

| ID | Pair | Verdict |
|---|---|---|
| G01 | MCP `goal.compile` — UNPAIRED: compiles a goal over the Phase 1 registry via the SAME `compileGoal`/`compileGoalWithMemory` the planner uses (no second compiler); output data-only, unrecognized goal → `chain:null`, never an error; NO REST compile endpoint exists | UNPAIRED |
| G02 | MCP `goal.schedule` vs REST `POST /schedules/create` — OPPOSITE safety postures for the word "schedule": MCP returns a PENDING record only ("never goes live without human confirmation… creates no scheduled job, no goal-list entry, no async job", refuses non-pending synthesis) vs REST creates a LIVE SDK schedule restricted to a callback allow-list (400 naming the list). **A unification must keep the PENDING-vs-LIVE distinction, not collapse it** | DIVERGENT by design |
| G03 | MCP `chain.run` vs schedules/async execution — re-validates chain, executes legs inline via supplied executors (failed/budget-blocked leg skips later legs), NEVER creates a scheduled job (`scheduledJobCreated: false`); REST schedules + async jobs are persistent, retryable, stage-projected. NO REST endpoint runs a compiled chain inline | DIVERGENT |
| G04 | AgentDB tools vs REST reads — `agentdb.jobs.history` + REST `GET /api/jobs/history` share the `readJobHistory` port, but REST is session-gated (`requireAuth`), IAAA tenant, 503 when unbound, via `handleJobHistoryRoute`; MCP resolves tenant from env only, no session gate, MCP-shaped projection; both read the PROJECTION (may lag one transition), never DO state. `agentdb.audit.history` reads the AgentDB audit projection for a chain; `GET /audit` reads live `mas_events` — different sources, different rows. `agentdb.reports.list` returns projection metadata ONLY ("report bodies are never included"); `GET /reports` serves full canonical reports. `agentdb.chain.status` is UNPAIRED (schedules list + `/api/chains/reconcile` are different operations; reconcile is a platform-admin operator action, not a status read) | DIVERGENT |

### (j) Discovery / ranking / weights / promotion remainders — 10 pairs

| ID | Pair | Verdict |
|---|---|---|
| D1 | `discoveryService` vs kernel fit path — (a) scope/delta-oriented (`runDiscovery`: characterise → signals → thesis → fit gate with discovery composite floor → panel expression → delta classification per `scopeKey`, `configHash` djb2, `profileBias` pick-only points; live callers incl. `asyncJobs.ts:973` side-by-side with `fitDiscoveryRunner`, NLQ routes, `UnifiedOptionsService`); (b) fit-oriented (bidirectional name↔strategy, falsification evidence, re-gate from same provider session, mapping that THROWS on source-less candidates). Different request shapes, stores, ranking hooks. **Principal remaining §1 overlap after #1639; the kernel did NOT absorb `discoveryService`** | DIVERGENT |
| D2 | `researchDiscovery` as kernel source — called by kernel builders AND by `fitDiscoveryRunner` as the pre-kernel step (run once, then re-gated/ranked through kernel); `runDiscoveryMode()` has NO direct production caller outside this chain (orphaned entry = cleanup note, not a live race) | IDENTICAL (layered, not parallel) |
| D3 | Weight application, three semantics over the same v2 store — (a) kernel `PassthroughWeightsRankDecorator`: reorder WITHIN tier only, no scaling; (b) `fitDiscoveryRunner.applyWeightsV2Ranking` (flag-gated, default OFF): BOUNDED MULTIPLIERS on scores, non-negative-cells-only, tier-first ordering, per-weight notes; (c) discovery profile bias: configured points added FOR PICK SELECTION ONLY (recorded scores unaffected). Plus a fourth reorder, `portfolioContextRanking` (stable partition demoting already-held symbols — a portfolio-context modifier, not a weight system, named not counted) | DIVERGENT |
| D4 | LLM overlay — (a) `rankingCore.annotateQuantRanking` (#1640): single enforced contract, order/length/references preserved, unknown judgments dropped, missing → null; (b) kernel `LlmRankPolicy`/`LlmScorePolicy`: REORDER by injected LLM order/scores — documented in `rankingCore.ts` itself as the single exception ("llm/hybrid arm ONLY … never alters a production ranking"); (c) `llmComparison.rankCandidatesWithLlm` + `strategyReviews` are judgment INPUTS, not rankers | DIVERGENT (by exception) |
| DF | Fit gate — single `evaluateFitGate()` (`opportunityScanner.ts`: fit/borderline/no_fit, inclusive thresholds, research-only blockers with stale-quote nuance) + chain adapter `OpportunityScannerFitHandler` (caps only demote, kernel takes most restrictive tier) + `resolveDiscoveryFitGate` floor overlay only. Research stage gates (`researchGates.ts`) are a DIFFERENT gate family, not a second fit gate | IDENTICAL |
| W1 | Strategy weights v1 vs v2 — v1 regime-blind raw win-rate, bounds [0.25, 2.0], step ≤ 0.10/run, min sample 20, deadband 0.02, round4, ISO-week guard, kill switch + #755 seam; v2 regime-conditioned (`strategy\|regime`), after-cost risk-adjusted, decay `0.5^(age/90d)` → 1.0, versioned append-only `mas_strategy_weights_v2`, same bounds + #755 seam + kill switch reused. Live: GET weights returns v2, POST run runs v2 only; NO live route/scheduled caller of v1 adjustment remains (only bounds/evaluation-builder imports). **DORMANT — retirement, not a live race; deleting v1 outright breaks v2's bounds import + GET evaluation builder — unwind those couplings first** | DIVERGENT (dormant) |
| W2 | v2 reads, same store three semantics — full map vs per-regime (no cross-regime leak) vs collapsed MEAN (regime-blind aggregate for legacy consumers). {bull 2.0, bear 0.25} reads as 1.125 collapsed / 2.0 bull / 0.25 bear — documented (C5, #1361/#1257), but observable | DIVERGENT |
| P1 | Promotion: champion/challenger live vs staged drain-only — new staged creation REFUSED ("file a challenger…"), promote/rollback via `championChallenger` (promoter = approver of record); `GET /adaptation/promotions/active` still lists in-flight STAGED promotions; `stagedPromotion.advancePromotion` live ONLY for in-flight (advance or roll back on regression). Two record stores + two GET shapes coexist. **Retirement condition (module header): delete when GET `promotions/active` is empty.** Bridge `proposalChallengerBridge` is a migration seam, not a third engine | DIVERGENT (drain era) |
| P2 | Candidate evaluation, four methods — (a) challenger walk-forward over FROZEN dataset (live); (b) `candidateEvaluation` track-record-window replay (dormant, staged/drain chain only); (c) `promotionGate` held-out counterfactual replay + z-test + INFORMED human approval (dormant); (d) `recommendationBundle` internal `evaluateCandidate` scenario-grid evaluation — a NAMESAKE in a different domain, must NOT be merged into (a)/(b)/(c) | DIVERGENT |
| S3 | Panel agents vs kernel — `panelPipeline.runPanelPipeline`/`runPanelWithAgents` (verbatim-moved retired `OptionsAgentPipeline` body) delegates to kernel `RecommendationService.discoverPanel`, then the same three agents over kernel candidates; defaults shared (`balanced`, 3 alternatives). Agents remain directly constructible (live seam, not dead code) | IDENTICAL (panel path) |

Coordinate (j) with open #1257 (challenger promotion, v2 weights routes, kernel
ranking policies verified on main, not rebuilt here). #1640's gap is closed for
production ranking; the D4 exception remains a live second ordering semantic that
any unification must preserve behind its comparison-only scope.

### (k) Report generator remainders — 10 pairs

| ID | Pair | Verdict |
|---|---|---|
| R-1 | Three PDF renderers remain parallel generators — `screenerReportPdf` (411 lines, margins 36pt, word-wrap, glyph cleaning incl. ▲/▼), `optionsReportPdf` (253 lines, margins 48pt, truncates to 120 chars no wrap, glyph cleaning), `researchReportPdf` (361 lines, margins 48pt, word-wrap, NO glyph replacement). All reached ONLY through the single dispatch in `unifiedReportPipeline.ts` (no direct call site remains) — routing unified, renderers NOT merged; duplicated machinery (print palette #473, page helpers, glyph cleaning); content models differ by type, so a merged renderer would be a redesign, not a dedup | DIVERGENT |
| R-2 | Goal-screen artifacts bypass the unified pipeline — `goalScreenReports.ts` (`generateGoalScreenPdf/Xlsx/Csv`, `generateAndStoreGoalScreenArtifacts`): fourth self-contained pdf-lib renderer (own pagination y<56, 100-hit cap, Yahoo-fallback provenance #1571), called directly never through `generatePdfAsset`/`generateReportStage`; own key family (`goal_screen:<format>:<uuid8>`, R2 `goals/`); per-format `REPORT_001` failure with run still succeeding. Blob store shared; store leg unified via `storeReportStage` in the scheduled path, generate leg NOT | DIVERGENT |
| R-3 | Tabular (XLSX/CSV) generation, two orchestration sites over shared generators — `screener-agent.ts` (per-run + `latest` keys, `putReportPdf`) vs `shardExecutors.ts` `generateTabular` shard (single per-run key, explicit content types, read-back verification before `mas_reports` row). Underlying tabular generators shared per type (`screenerReportXlsx/Csv`, `optionsReportXlsx`); duplicated is the generate-and-store orchestration. Goal-screen tabular generators are a third, type-specific set (see R-2) | DIVERGENT |
| R-4 | Canonical store — `storeReportAtGeneration` (`scheduledReports.ts`, idempotent on generation id, #308) vs ORM `storeCanonicalReport` (direct wrapper) vs `storeReportStage` (null-safe adapter over ORM). Caveat (caller-level, not store divergence): generation ids derived differently per caller (pipeline `type:trigger:timestamp`, report-dispatch `sha256Hex(bodyJson)`, scheduled `generationIdOf(input)`) — two callers can mint different ids for the same logical report and store two rows; the store cannot dedupe across id schemes | IDENTICAL |
| R-5 | Blob store — one seam (`reportBlobStore.ts` `putReportPdf`/`getReportPdf`, R2 when bound else legacy DO-storage base64, key-family mapping `screener:`→`stocks/`, `options:`→`options/`, `goal_screen:`→`goals/`, `knowledge:`→`knowledge/`) used by all producers; R2-vs-DO fallback inside the seam | IDENTICAL |
| R-6 | Semantic index — one index path (`reportSemanticIndex.ts` `indexReport`, best-effort, never fails the run) + one search path (`semanticSearchReports`/`mergeSearchHits`, `GET /reports/semantic-search`); research publish, and only research publish, indexes at generation; no second indexing pipeline found | IDENTICAL |
| R-7 | Report-confirm delivery, canonical vs legacy paths inside one handler — `POST /trading/reports/confirm` (own state machine: pending → approved/rejected/expired; missing 404, decided 409, expired 410 + `research_report.confirmation_expired` audit; NOT a mirror of `POST /payments/confirm` — different resource/states/effects). Approved branches three ways: (a) `kind: "screener"` resubmits held follow-up delivery; (b) rows with `report_id` deliver the STORED canonical copy (audits with `reportId`); (c) legacy pre-#308 rows deliver from embedded `payload_json` (same audit names, `fileName`/sheets count instead of `reportId`; error mapping differs: missing stored → 500, email unavailable → 503, webhook unconfigured → 503 vs webhook failure → 502). Legacy path is a compatibility shim, not a second delivery system | DIVERGENT |
| R07 | Routes-scan carry-over — `/screener/report.{pdf,xlsx,csv}`, `/options/report.{pdf,xlsx,csv}`, `/research/report.pdf`, `/screening/goal-screen/report.{pdf,xlsx,csv}` vs `GET /reports` / `/reports/research/browse` / `/reports/semantic-search` vs `agentdb.reports.list`: old doc §5 names four parallel PDF generators + `unifiedReportPipeline.ts` (#1209); the routes scan did NOT diff the generators, so no new verdict was claimed there — the item stays open, and is covered here by R-1..R-7 (not a separate pair) | OPEN CARRY-OVER (resolved into R-1..R-7) |
| S1 | Two research-report engines — (a) `FossResearchService.generateResearchReport` (single-symbol equity report, Yahoo fundamentals + quote + bars, DID attestation, Foss provenance); (b) `ResearchAgent` + `researchPipeline` governed options-research OODA loop (E*TRADE-backed provider, settings/runs/evaluations tables, task ledger #577, schedule guard, stored PDFs `research:pdf:*`). Different inputs (symbol vs strategy/universe), engines, stores, provenance vocabularies; no shared report builder found. Engine-level pair — distinct from the R-1 renderer pair; do not merge naively | DIVERGENT |
| S2 | Goal/scenario screen — `goalDrivenScreen.ts` (plan + ledger orchestration ONLY, "there is no second screening implementation here", executes through the Phase 0 `ScreeningProviderRegistry` / M12 pipeline, mirrors screener task ledger for idempotency/heartbeat/escalation) + `goalScenarioEngine.ts` (scenario/taxonomy language, not a competing screener) + ResearchAgent `run_goal_discovery` (PROPOSED goals for human confirmation — a different stage from screening against them) | IDENTICAL (unified pipeline) |

`POST /trading/reports/confirm` vs `POST /payments/confirm` is name similarity only
(different tables, state machines, effects) — not counted. `GET /reports` /
`/reports/research/browse` / `GET /runs` / `GET /trading/reports/pending|confirmations`
are read views over the same canonical rows, not parallel generators.

### (l) Portfolio repair remainders — 4 pairs

| ID | Pair | Verdict |
|---|---|---|
| PR-1 | Position-level ratio repair vs structural composition repair — position level (`repairProposals.ts`: underwater long stock only, ≥100 shares, cost basis, spot < pricePaid; 1×2 call ratio, K1 nearest strike to spot, K2 lowest ≥ half-gap floor, ~35 DTE within 21–90, cost tolerance 0.5% spot, `round2`, capped upside, NO downside protection, DRAFTS ONLY) vs structural level (`strategyComposition.ts`: losing two-leg vertical → butterfly, gated by quant gates, max 8 legs, undefined-risk rejected). Unifying contract `repairPolicies.ts` (`RepairOption`: `ratio_repair` \| `composition`, `costDollars`, `riskRemovedDollars`, `rankScore`, `rankBasis`): ratio `riskRemoved` ALWAYS null, `rankScore = −cost`; composition `riskRemoved` = measured max-loss reduction when known, `rankScore = riskRemoved − cost` else `−cost`; combined rank `rankScore desc, label asc`. **Ratified #1642 design: explicit two-level contract over one proposal contract — NOT a single merged model. Treat as decided, not as an open duplication to merge without a new decision. Boundary honored: `repairPolicies.ts` never imports `strategyComposition.ts`** | DIVERGENT (coexistence confirmed, by design) |
| PR-2 | Composition policy dormant in production — `DEFAULT_REPAIR_POLICIES` always includes `CompositionRepairPolicy`, but NO production caller supplies `compositionRepairs` (tests only; bundle route passes only `repairAnalysis`). The composition leg always contributes zero options in production while the ratio leg contributes live proposals; a bundle consumer cannot tell from output alone that one policy level is structurally empty. Dormant-by-design per #1642 ("until its first producer lands"), not dead code | DIVERGENT (dormant) |
| PR-3 | Shared producer, divergent caller error semantics — `POST /etrade/portfolio-repair/analyze` vs `POST /etrade/portfolio-risk/bundle`, both calling `generateRepairProposals`: analyze surfaces producer failure as HTTP 500; bundle swallows it (`.catch(() => null)` → `repairAnalysis: null` → bundle built without repair options, still returned). Same producer, different failure visibility | DIVERGENT (narrow) |
| PR-4 | Builder vs pipeline inside `repairProposals.ts` — `buildRepairProposals` (pure) vs `generateRepairProposals` (live E*TRADE fetch → same builder): one implementation with a fetch wrapper, deterministic given inputs, skipped symbols named with reasons in both paths | IDENTICAL |

### (m) REST↔REST twins — 6 pairs

| ID | Pair | Verdict |
|---|---|---|
| R01 | Alpaca twin routes — `/trading/alpaca/*` vs `/foss/alpaca/*` (same `FossResearchService`): `/trading` order takes only `body.qty` (default 1), no uppercasing, error `Stock symbol is required`, audit `alpaca.order_placed` `{symbol, qty, side, status}` only, NO audit for account/positions/orders; `/foss` accepts `qty\|quantity`, `side\|orderAction`, `type\|orderType`, `limit_price\|limitPrice`, uppercases symbol, error `Symbol is required`, audit adds `{type, limitPrice, orderId, success}`, audits `alpaca.account_queried`/`positions_queried`/`orders_queried`; orders `status` default `open` on both; `/foss/snapshot` (default `NVDA`) has no `/trading` twin | DIVERGENT |
| R02 | Quote surfaces (REST↔REST leg) — `GET /etrade/quote` (registry platform + LiveStrict, TEST/PROD from `x-environment`/`?env`, `x-user-login` gate, no-cache headers) vs `GET /foss/quote` (Foss service, provider default `hybrid`, default `NVDA`, no env selection, no no-cache headers) vs Worker batch `GET /api/market/quotes` = `GET /api/foss/quotes` (same Worker branch, same handler, same default symbol list). Three providers/provenance models, not one quote API. IDENTICAL sub-pair: the two batch spellings (and their `/ws` spellings) are literally the same branch. Cross-ref: full cross-protocol quote pair is M10 in (e) | DIVERGENT (with one IDENTICAL alias inside) |
| R03 | Options strategy aliases — `POST /trading/options/strategies` = `POST /trading/options/best-trade` (one `if` block in `etradeOptions.ts`, same handler) | IDENTICAL (alias, not duplication) |
| R04 | Audit writes — `POST /audit` vs `POST /audit/event` (same `mas_events` table): `/audit` defaults `type="autopilot.policy_check"`, `agent="trading"`, payload = `body.payload` or whole body, 200 `{success, message}`, no validation; `/audit/event` requires non-empty `type` (≤120 chars), agent default `orchestrator` (≤64), payload ≤64 KB serialised, returns stored record with 201. Not substitutable | DIVERGENT |
| R05 | Environment switch aliases — `POST /environment/switch` = `POST /broker/etrade/environment` (same `handleEnvironmentSwitch`, documented #314 advertised-spelling alias) | IDENTICAL |
| R06 | Transaction-snap aliases — DO: `POST /trading/browser/transaction-snap` = `POST /browser/transaction-snap` (one block, `BrowserAgent.sendTransactionSnapToSlack`); Worker: `/api/browser/transaction-snap`, `/browser/transaction-snap`, `/api/browser/snap/transaction` all require a session, then set `x-user-login` to the header OR `tx.symbol` OR the literal `"browser_trader"` — **a caller-asserted identity fallback the DO route itself does not have**. Counted divergent overall because the externally reachable contract differs by spelling | DIVERGENT (at the Worker; IDENTICAL at the DO) |

Also UNIFIED (from routes M10, pinned residuals, not separate domain pairs):
`GET /audit` executes `get_audit_events` (route keeps 1–100 clamp, session filter,
payload-JSON parse, 5-field projection); `GET /schema/tables` passes
`list_database_tables` through; `POST /schema/query` passes to `query_table_data`
(route keeps `mas_categories` default table). `POST /audit` / `POST /audit/event`
are NOT command-backed (see R04). Screen-vs-unified (`/trading/options/screen` vs
`/trading/options/unified` vs `/recommend|catalog|compare`) was NOT diffed
line-by-line in the routes scan — follow-up diff, not a verdict.

### (n) Cloudflare / browser / misc MCP unpaired + divergent tools — 4 pairs

| ID | Pair | Verdict |
|---|---|---|
| N-browser | MCP `browser_inspect_page` + `browser_screenshot` (`cloudflareAgentCommands.ts`) — UNPAIRED: no REST inspect/screenshot route. Nearest neighbours are different operations (Worker `POST /api/browser/snapshot` = capture + Slack post, session-gated; DO transaction-snap, R06) | UNPAIRED |
| N-webhook | MCP `dispatch_trading_webhook` — UNPAIRED: HMAC-signed OUTBOUND dispatch via `ETradeWebhookService` (`success:false` without `OUTBOUND_WEBHOOK_SECRET`). `POST /trading/reports/webhook` is report delivery and `/nlq/webhook` is INBOUND NLQ — neither is this tool | UNPAIRED |
| N-sandbox-twap | MCP `run_sandbox_command` + `execute_durable_twap` — UNPAIRED: no REST counterparts. `run_sandbox_command` returns `executed:false` under the MCP facade (no container backend bound) — never present that as executed output. `execute_durable_twap` is preview-only (per-slice `previewOrder`, `executed:false`, no fills), NO REST TWAP route; its slices call the LOCAL `previewOrder` (E03's draft), not the REST remote preview — so they also bypass the policy gate/expiry | UNPAIRED |
| N-backtest-think-aisearch | MCP `run_quant_backtest` + `think_trade_validation` + `ai_search_financial_docs` — pair candidates, UNVERIFIED: backtest uses a SYNTHETIC price series (labelled `dataSource:"synthetic"`) via `ETradeSandboxService`; nearest REST neighbour `POST /screening/backtest` was not diffed — do NOT assume it is the same backtest (synthetic-vs-real is the delta to verify). `think_trade_validation` nearest neighbour `POST /etrade/think/evaluate` was not diffed — pair candidate, unverified. `ai_search_financial_docs` overlaps `knowledge_search` (M01) in purpose but uses a different search backend/shape (no `AI_SEARCH_ENDPOINT` + platform fallback, no `chunks` envelope) | DIVERGENT / UNVERIFIED pairs |

### (o) PAYMENTS RE-SCOPE — program slice, not a scan finding

The existing global `PAYMENTS_FLOW_MODE` stays as the global fallback; this slice
re-scopes its resolution per user/session/run under the scoped-defaults order
(run > session > user > global env > built-in default), HITL still the built-in
default. Payments #1690/#1711 is otherwise DONE — no rebuild slice for it.
Where a scoped override path does not exist yet, building it is part of this slice.

## Cross-cutting contract deltas (all domains)

- **Provenance vocabularies (four, unmapped):** facade `cached|unavailable`; Foss
  `live|cached` (+ weakest-of-legs for hybrid, `fromCache/cacheAgeMs/note`);
  E*TRADE `quoteStatus REALTIME|STATIC_FALLBACK|SIMULATED_LEVEL1|AUTH_REQUIRED` +
  free-text `source`; DataProvider `tag(providerId, capability)` + capture rows.
  No mapping table between them exists in-tree.
- **Symbol/id normalisation:** uppercase+trim everywhere, BUT crypto differs —
  marketStream maps `BTC/USD→BTC-USD` (generic `/→-`); Foss Alpaca detects crypto
  by `/` or substring `btc|eth`; Foss Yahoo takes the symbol as given (uppercased);
  E*TRADE takes the bare equity symbol. A crypto pair has no single canonical id
  across paths.
- **Money defaults / rounding:** marketStream Alpaca mid 2dp; Foss Alpaca mid 2dp
  with all-OHLC = mid; Foss Yahoo wire price, change 2dp, `vwap = price`,
  single-quote `open = (high+low)/2`; E*TRADE wire passthrough, curated
  `defaultPrice ?? 100.0` (non-live only); sync unknown = zero-price object vs
  platform throw; weights round4 in v1/v2; fit weights printed `toFixed(2)` in
  notes only; ads cpm/cpc and rounding per (a); payments per (h).
- **Error semantics:** market HTTP = 200 + `unavailable[]`; Foss REST = 500
  `{error}`; Foss/MCP/E*TRADE-MCP = throw; E*TRADE platform unknown = throw,
  service sync unknown = zero object; batch Yahoo = throw on empty/no-crumb,
  batch E*TRADE non-live = `[]`, batch Foss = omission (caller falls back);
  REST = HTTP JSON, MCP = throw, no status mapping; silent-success vs throw
  splits on categories/referrals/ads click/delete, report-confirm paths,
  repair-producer callers.
- **Audit:** REST routes audit; MCP commands audit NOTHING for
  categories/referrals/external-ads; Foss MCP + Foss REST research/screen
  audited; market quotes (HTTP+WS) NOT audited; Foss REST quote NOT audited;
  E*TRADE MCP audited with different fields from Foss; DataProvider captures are
  audit-adjacent (capture/outcome rows), not the same audit events. Audit event
  NAME splits exist for the same operation (`foss.research.generated` vs
  `foss.research_generated`; `alpaca.*.query` vs `alpaca.*_queried`).
- **Auth gates:** no per-handler auth check inside payments/categories/referrals/
  external-ads handlers or their MCP commands (both inherit the dispatcher
  session); two explicit exceptions: `POST /etrade/portfolio-risk/bundle` and
  `POST /etrade/portfolio-repair/analyze` require `x-user-login`. Market/Foss
  quote reads unauthenticated; Foss screen + E*TRADE MCP + DataProvider routes
  session-bound. MCP command execution (`McpToolFactory.executeTool`) calls
  `command.execute()` directly — declared `zodSchema` constraints (enums,
  `min(1)`, defaults) are NOT parsed at execution time, so zod-only constraints
  are not enforced on the execute path (this is why several "zod says X,
  execute does Y" deltas are real, not theoretical).
- **Provider selection (four semantics):** marketStream try-Alpaca-then-Yahoo
  (silent fallthrough); hybrid env-key gate (M6); registry routed primary +
  gap-fill with no silent substitution (M9); research-provider single-E*TRADE
  with honestly-empty degradation (S4). Under NEVER-EITHER/OR-ALWAYS-CONFIGURABLE,
  each pair needs its own switch with the current public-route behaviour as
  default — the HTTP quote default today is Yahoo-only by the M2b call-site fact
  (runtime-confirm first), not silently "fixed" to Alpaca-first.

## What was NOT verified (limits of these read-only scans)

- No live execution, no tests run, no staging/production behavior probed. All
  verdicts are from source on the stated head. "Live" means "has a live
  route/caller in-tree", verified by grep + reading call sites — not by runtime
  probing.
- M2b env-drop is a static call-site fact (`server.ts:2200` vs `:2188`); runtime
  behaviour under the real Worker env must be confirmed before it is written
  into a program default.
- ORM `Repository.create/update/delete` return semantics for missing rows
  (relevant to C-1/C-2 delete/update wording) were read only at the call sites;
  the ORM internals were not traced to a definitive "throws vs null" claim.
- Whether any external caller depends on the divergent defaults (e.g. ads
  created via REST vs MCP in production data) was not checked — the money deltas
  are code-level facts, not usage claims.
- NOT diffed line-by-line (follow-up diffs, not verdicts): `/trading/options/screen`
  vs `/trading/options/unified`; `/screening/backtest` vs `run_quant_backtest`;
  `/etrade/think/evaluate` vs `think_trade_validation`; discovery/fit NLQ failure
  mode without runners; per-route sync-vs-queued status for every `/api/*`
  spelling (J02 gives the rule — apply it per route at build time, do not assume).
- Reconciliation vs the old #1638 inventory: §1 discovery PARTIALLY unified
  (panel = kernel delegate, NLQ fit-discovery via kernel; `discoveryService` +
  `researchDiscovery`-as-mode still open); §§2–4 PARTIALLY unified (`rankingCore`
  one LLM contract, v2 live, champion/challenger live; v1 dormant, staged
  drain-only, kernel LLM-arm exception, three weight-application semantics open);
  §5 report PARTIALLY unified (dispatch/generate-owner/store/blob/index single;
  three renderers + goal-screen bypass + two tabular sites open); §6 repair
  RATIFIED AS TWO LEVELS (only dormant producer + caller error asymmetry open);
  §7 market-data PARTIALLY unified — READ layer only (WS, quoteCache, fetchers,
  E*TRADE chain, REST-vs-MCP quote surfaces open; the old doc's "1-minute TTL"
  matches NEITHER live regime); §8 REST-vs-MCP PARTIALLY unified via #1644
  (payments/revenue/audit-read/schema/memory-list-delete-clear delegated;
  categories/referrals/ads, NLQ, etrade/foss/paid/goal/agentdb/cloudflare
  commands NOT reduced).

## Appendix map

Per-domain appendices (same directory, each filename carrying the parent number)
carry the full per-finding detail — implementations, file paths, contract deltas,
verdict — for their domain:

- `system-duplicates-scan-1717-appendix-a-categories-referrals-ads.md` — (a)
- `system-duplicates-scan-1717-appendix-b-nlq.md` — (b)
- `system-duplicates-scan-1717-appendix-c-knowledge-memory.md` — (c)
- `system-duplicates-scan-1717-appendix-d-async-jobs.md` — (d)
- `system-duplicates-scan-1717-appendix-e-market-data-quotes.md` — (e)
- `system-duplicates-scan-1717-appendix-f-etrade-mcp-rest.md` — (f)
- `system-duplicates-scan-1717-appendix-g-foss-mcp-rest.md` — (g)
- `system-duplicates-scan-1717-appendix-h-agentic-payments-premium.md` — (h)
- `system-duplicates-scan-1717-appendix-i-goal-chain-agentdb.md` — (i)
- `system-duplicates-scan-1717-appendix-j-discovery-ranking-weights-promotion.md` — (j)
- `system-duplicates-scan-1717-appendix-k-report-generators.md` — (k)
- `system-duplicates-scan-1717-appendix-l-portfolio-repair.md` — (l)
- `system-duplicates-scan-1717-appendix-m-rest-rest-twins.md` — (m)
- `system-duplicates-scan-1717-appendix-n-cloudflare-browser-misc.md` — (n)
- `system-duplicates-scan-1717-appendix-o-payments-rescope.md` — (o)

Sub-issue numbers for domains (a)–(o) are recorded in the index comment on #1717,
not here, so this document never carries stale issue numbers. IAAA
enforcement-gap slices (see Scope boundary above) are added by the post-Phase-B
amendment step with their own sub-issues; the mining appendix for
`docs/architecture/` findings will be added by a follow-up gated PR.
