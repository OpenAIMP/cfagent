# Scan appendix (f) — E*TRADE MCP vs REST — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. SAFETY-CRITICAL: E04 below — the slice must
never weaken controls; the MCP execute path must adopt the route's HITL gate.

All seven tools use `ETradeService` (`src/mcp/etradeCommands.ts`); none is bridged
from REST. Deltas are vs `src/agents/routes/etradeBroker.ts` (+
`etradeBrokerOrders.ts`, `etradeBrokerScreen.ts`).

## E01 — etrade_market_scan vs REST /etrade/screen — DIVERGENT (different pipeline)

- MCP: `ETradeService.screenMarketsAsync` (Nasdaq/NYSE/AMEX listings screen).
- REST: delegates to `ScreenerAgent` (#261) with the tracked screen pipeline,
  canonical report persistence, and `etrade.screened` audit. MCP audits
  `etrade.market_scanned` and returns the listings result directly.
- Same word "screen", different engine and different output shape.

## E02 — etrade_get_quote vs GET /etrade/quote — DIVERGENT-minor

- Same `fetchQuoteLiveStrict` + registry platform (appendix (e) M7e).
- Deltas: MCP uses `resolveEnvironmentConfig(env).isLive` (no TEST/PROD override,
  no `x-environment`/`?env` handling), `sessionId` as login (no `x-user-login`
  401 gate), adds `etrade.quote_fetched` audit; REST adds no-cache headers and
  defaults a missing symbol to `NVDA` (MCP requires a symbol, zod ≤10).

## E03 — etrade_preview_order vs POST /etrade/order/preview — DIVERGENT (safety-relevant)

- MCP: local `etrade.previewOrder` draft (equity only, no option legs, no
  stopPrice, no asset-class validation, action silently falls back
  `action || orderAction`).
- REST: `previewOrderRemote` (broker preview, equity + options legs with
  leg/asset-class validation, invalid action coerced to BUY, `stopPrice`),
  then autopilot policy-verdict evaluation (409/503 gates when autopilot is
  running), a 15-minute expiry schedule (`expireStaleOrderDraft`), payload-hash
  audit, and `x-user-login` gate. The MCP draft never reaches the broker
  preview, the policy gate, or the expiry timer.

## E04 — etrade_execute_order vs POST /etrade/order/execute — DIVERGENT (SAFETY-CRITICAL)

- MCP: `etrade.executeOrder(orderId, sessionId, decision)` only, audit
  `etrade.order_executed|rejected`. No 403 `did:agent:` HITL gate, no
  draft-exists 404, no `previewed`-status check, no payload-hash comparison,
  no remote `placeOrderRemote` when broker keys are present, no Slack
  transaction snap, no autopilot-orders-today increment, no expiry-timer
  cancellation — all present on the REST path (`etradeBrokerOrders.ts`).
- An MCP caller and a REST caller executing the "same" draft do not pass the
  same gates. **Slice rule: the MCP execute path must ADOPT the route's HITL
  gate (403 `did:agent:` gate, draft-exists 404, `previewed` check, payload-hash
  comparison, remote placement, snap, counter, expiry cancellation) — never
  bypass it, never re-implement a weaker gate, never make the gate itself
  user/session-configurable (see main doc Security Guard).** Pin every gate in
  both switch modes before any other E04 change.

## E05 — etrade_get_positions vs GET /etrade/positions — DIVERGENT-minor

- MCP: `fetchPortfolioRemote()` (no args) + `fetchAccountsRemote()`, returns a
  reshaped `{account, accounts, positions, totalPortfolioValue, totalCash,
  positionsCount, asOf}` envelope. REST: `fetchPortfolioRemote(undefined,
  true)`, spreads the holdings object, adds an `error` field only when the
  account is `unconnected`. Different envelope; second remote call on MCP.

## E06 — etrade_auth_status / etrade_account_discovery vs REST — DIVERGENT-minor

- Status: same `getStatusAsync()`; MCP adds no gate/env handling, REST gates
  `x-user-login` and passes `requestedEnv`.
- Discovery: same `fetchAccountsRemote()`; MCP returns `{count, accounts,
  asOf}`; REST returns `{count, accounts}` and, on an empty list with a
  recorded upstream error, 502 naming the cause instead of 200.
