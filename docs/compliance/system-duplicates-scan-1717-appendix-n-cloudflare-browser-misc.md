# Scan appendix (n) — Cloudflare / browser / misc MCP unpaired + divergent tools — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. Registry accounting: 51 registered tools
total — 9 execute through / are bridged to REST, 31 paired-but-divergent,
11 UNPAIRED vs REST (see main doc register for the full map).

## N-browser — browser_inspect_page + browser_screenshot — UNPAIRED

- `browser_inspect_page`, `browser_screenshot`
  (`src/mcp/cloudflareAgentCommands.ts:26,53`): NO REST inspect/screenshot route.
- Nearest neighbours are different operations: Worker
  `POST /api/browser/snapshot` (capture + Slack post, session-gated) and
  DO transaction-snap (appendix (m) R06). UNPAIRED — do not file snapshot as the
  REST pair of inspect/screenshot.

## N-webhook — dispatch_trading_webhook — UNPAIRED

- `dispatch_trading_webhook` (`cloudflareAgentCommands.ts:76`, HMAC-signed
  OUTBOUND dispatch via `ETradeWebhookService`, `success:false` without
  `OUTBOUND_WEBHOOK_SECRET`): NO REST outbound-dispatch route.
- `POST /trading/reports/webhook` is report delivery, and the Worker
  `/nlq/webhook` is an INBOUND NLQ entry — neither is this tool. UNPAIRED.

## N-sandbox-twap — run_sandbox_command + execute_durable_twap — UNPAIRED

- `run_sandbox_command` (`cloudflareAgentCommands.ts:109`): NO REST counterpart;
  and by its own description it currently returns `executed:false` under the MCP
  facade (no container backend bound) — never present that as executed output.
- `execute_durable_twap` (`cloudflareAgentCommands.ts:258`): preview-only TWAP
  plan (per-slice `previewOrder`, `executed:false`, no fills). NO REST TWAP route.
  Note it calls the LOCAL `previewOrder` (appendix (f) E03's draft), not the REST
  remote preview — so its slices also bypass the policy gate/expiry. Any TWAP
  slice must adopt the E03/E04 gate posture, not inherit the local draft's.

## N-backtest-think-aisearch — pair candidates, UNVERIFIED

- `run_quant_backtest` (`cloudflareAgentCommands.ts:136`): SYNTHETIC price series,
  labelled `dataSource:"synthetic"`, via `ETradeSandboxService`. Nearest REST
  neighbour `POST /screening/backtest` was not diffed; do NOT assume it is the
  same backtest — synthetic-vs-real is the delta to verify.
- `think_trade_validation` (`cloudflareAgentCommands.ts:173`,
  `ETradeThinkHarness.evaluateTradeWithThinking`): nearest REST neighbour
  `POST /etrade/think/evaluate` was not diffed; pair candidate, unverified.
- `ai_search_financial_docs` (`cloudflareAgentCommands.ts:223`,
  `{query, limit default 5}` → `totalMatches` result): overlaps
  `knowledge_search` (appendix (c) M01) in purpose but uses a different search
  backend/shape (no `AI_SEARCH_ENDPOINT` + platform fallback, no `chunks`
  envelope). DIVERGENT search pair — cross-reference M01, do not double-count
  the knowledge-search finding.

## Slice guidance for (n)

Most of (n) is UNPAIRED surface, not divergent pairs: the slice work is
pairing decisions (add a REST counterpart reusing the same command, or record
explicitly that the tool stays MCP-only), not merging two implementations.
Under "no new stores/engines unless proven", a new REST route for an unpaired
tool must be justified in its issue first. Never present `executed:false`
surfaces as executed output in any new envelope.
