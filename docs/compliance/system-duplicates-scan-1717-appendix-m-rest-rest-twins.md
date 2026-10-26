# Scan appendix (m) — REST↔REST twins — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. Note: twin spellings that are documented
aliases (R03, R05) are IDENTICAL — do not "unify" them away; an alias is not a
duplication.

## R01 — Alpaca twin routes — DIVERGENT

- `src/agents/routes/alpaca.ts`: `handleAlpacaTradingRoutes`
  (`/trading/alpaca/order|account|positions|orders`) vs `handleAlpacaFossRoutes`
  (`/foss/alpaca/order|account|positions|orders`, plus `/foss/snapshot`).
- Same backend service (`FossResearchService`), different contracts:
  - Order defaults/aliases: `/trading` takes only `body.qty` (default 1), does NOT
    uppercase the symbol, error `"Stock symbol is required"`, audit
    `alpaca.order_placed` `{symbol, qty, side, status}` only. `/foss` accepts
    `qty|quantity`, `side|orderAction`, `type|orderType`, `limit_price|limitPrice`,
    uppercases the symbol, error `"Symbol is required"`, audit adds
    `{type, limitPrice, orderId, success}`.
  - Account/positions/orders: `/trading` returns the raw service result with NO
    audit for account/positions/orders; `/foss` returns the same result WITH
    audits `alpaca.account_queried` / `alpaca.positions_queried` /
    `alpaca.orders_queried` (different payload shapes). Orders `status` default
    `"open"` on both.
  - `/foss/snapshot` (default symbol `NVDA`, audit `alpaca.snapshot_queried`)
    has no `/trading` twin.
- Slice guidance: three-way interaction with appendix (g) F04/F05 (MCP adds a
  third spelling) — reconcile all three, defaulting to the public route behavior
  named per field, not to one twin wholesale.

## R02 — Quote surfaces — DIVERGENT (with one IDENTICAL alias inside)

- `GET /etrade/quote` (`src/agents/routes/etradeBroker.ts`, registry-resolved
  platform + `fetchQuoteLiveStrict`, TEST/PROD from `x-environment`/`?env`,
  `x-user-login` gate, no-cache headers) vs `GET /foss/quote`
  (`src/agents/routes/fossResearch.ts`, `FossResearchService.getQuote`,
  provider default `hybrid`, default symbol `NVDA`, no env selection, no
  no-cache headers) vs Worker batch `GET /api/market/quotes` =
  `GET /api/foss/quotes` (`src/server.ts`, `handleMarketQuotesHttp` over the
  market-stream tick cache, provenance `cached` only —
  `src/services/marketDataService.ts`). Three different providers/provenance
  models, not one quote API.
- IDENTICAL sub-pair: `/api/market/quotes` and `/api/foss/quotes` are literally
  the same Worker branch (same handler, same default symbol list
  NVDA/AAPL/MSFT/TSLA/SPY/QQQ/BTC-USD/ETH-USD/SOL-USD); likewise the WS
  spellings `/api/market/quotes/ws` = `/api/foss/quotes/ws`.
- Cross-ref: the full cross-protocol quote pair (market HTTP vs Foss REST vs
  Foss MCP vs E*TRADE MCP) is M10 in appendix (e); this appendix covers the
  REST↔REST leg only. Do not double-count the batch surface in both slices —
  the (e) slice owns provider/cache semantics, the (m) slice owns route-twin
  spelling/identity/headers.

## R03 — Options strategy aliases — IDENTICAL (narrow)

- `POST /trading/options/strategies` and `POST /trading/options/best-trade`
  are one `if` block in `src/agents/routes/etradeOptions.ts` (same handler;
  `/best-trade` spelling noted inside). This is an alias, not a duplication.
- NOT counted here: `/trading/options/screen` vs `/trading/options/unified`
  vs `/trading/options/recommend|catalog|compare` — all go through
  `UnifiedOptionsService` (screen path verified at
  `src/agents/routes/etradeOptionsScreen.ts:336,354`), but the `unified`
  action/channel/presentation was not diffed line-by-line in this scan;
  treat screen-vs-unified as a follow-up diff, not a verdict.

## R04 — Audit writes: POST /audit vs POST /audit/event — DIVERGENT

- Both `src/agents/routes/audit.ts`, same `mas_events` table, different contracts:
  POST `/audit` defaults `type="autopilot.policy_check"`, `agent="trading"`,
  payload = `body.payload` or the whole body, returns `{success:true,
  message:"Audit event recorded"}` (200), no validation. POST `/audit/event`
  requires non-empty `type` (≤120 chars), agent default `"orchestrator"`
  (≤64 chars), payload must serialize to ≤64 KB, returns the stored record
  with 201. A caller cannot substitute one for the other.
- Slice guidance: audit-write validation differences are attributable-audit
  differences — the slice must pin which contract survives per spelling under
  the switch, and must not silently validate (or un-validate) a previously
  unvalidated write path without naming it.

## R05 — Environment switch aliases — IDENTICAL

- `POST /environment/switch` and `POST /broker/etrade/environment`
  (`src/agents/routes/etradeBroker.ts`) both delegate to the same
  `handleEnvironmentSwitch` (documented as the #314 advertised-spelling alias).

## R06 — Transaction-snap aliases — IDENTICAL at the DO, DIVERGENT at the Worker

- DO: `POST /trading/browser/transaction-snap` =
  `POST /browser/transaction-snap` (one block,
  `src/agents/routes/tradingIntegrations.ts:298`, `BrowserAgent.sendTransactionSnapToSlack`).
- Worker (`src/server.ts`): `/api/browser/transaction-snap`,
  `/browser/transaction-snap`, `/api/browser/snap/transaction` all require a
  session, then set `x-user-login` to the header OR `tx.symbol` OR the
  literal `"browser_trader"` — a caller-asserted identity fallback that the
  DO route itself does not have. Counted divergent overall because the
  externally reachable contract differs by spelling.
- Slice guidance: identity fallback is the safety-relevant delta here. Under the
  Security Guard, a switch must never let a caller assert an identity the
  session does not hold; the slice must name whether the `browser_trader`
  fallback survives, and under what session conditions, before changing it.

## M10 — Unified audit/schema reads (pinned residuals, #1644)

- `GET /audit` executes `get_audit_events` (no limit arg → command default
  50) then session-filters, slices to the 1–100 clamped limit, parses
  payload JSON with `{raw}` fallback, projects 5 fields. `POST /audit` and
  `POST /audit/event` are NOT command-backed (see R04).
- `GET /schema/tables` returns `list_database_tables` output unchanged;
  `POST /schema/query` passes `{tableName, search, limit, offset}` to
  `query_table_data` with a `mas_categories` default table
  (`src/agents/routes/schema.ts`). Neither command audits.
- These are UNIFIED execution with presentation deltas only — pin, don't rebuild.
  They sit in this appendix as residuals because their routes are REST↔REST
  neighbours of the audit/schema surface, not because they are twins.
