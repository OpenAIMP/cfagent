# Scan appendix (h) — Agentic payments + premium gating — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. Payments #1690/#1711 core is DONE — this
domain covers the remaining presentation/transport deltas, the agentic plane,
and premium gating; the re-scope of `PAYMENTS_FLOW_MODE` itself is appendix (o).

## Payment flow map (one ledger, three money planes)

All REST payments and all agentic payments land in the same table,
`mas_transactions`, but through three distinct planes that are NOT interchangeable:

1. **Gateway plane** — `src/services/payments.ts` (`PaymentGatewayService`:
   Stripe/PayPal/LemonSqueezy/sandbox strategies via
   `src/patterns/paymentStrategies.ts`; `SUPPORTED_GATEWAYS` = stripe, paypal,
   lemonsqueezy, sandbox; webhook gateways exclude sandbox). Units: dollars,
   `pay_<uuid8>` draft ids.
2. **Agentic plane (x402/MPP)** — `src/services/agenticPayments.ts`
   (`ETradeAgenticPaymentService`): provider (402 challenges, on-chain claim
   verification, replay guard via `consumeStoreKey`) and consumer (simulated,
   unsigned outbound proofs — `SIMULATED_PROOF_SIGNATURE`, never redeemable by
   its own verifier). Wallet balance is a simulated local-ledger figure: `$50.00`
   starting credit ± ledger entries (`AGENTIC_WALLET_STARTING_CREDIT_USD`,
   `source: "local-ledger"`), never an on-chain balance. Rows: `action`
   `agentic_payment` (inbound) / `micropayment` (outbound), `gateway` x402/mpp,
   `status` `completed` (verified) or `simulated`.
3. **PaymentsAgent/BudgetGuard plane** — `src/payments/ledger.ts` +
   `src/payments/budget-guard.ts` + `src/agents/payments-agent.ts`: cents, agent
   ids, idempotency keys. Rows are marked `session_id = payments-agent:<agentId>`,
   `gatewayRef` = idempotency key, `action = micropayment`, `gateway = x402`,
   `status = completed`. The old serialized blob ledger is retired (migration
   only in `PaymentsAgent.migrateLegacyLedger()`); `BudgetGuard` state is now
   derived from `mas_transactions` on every read (`deriveBudgetGuardState`).

## P-1 / M02 — REST create (HITL) vs MCP draft_payment — DIVERGENT (narrow, delegated core)

- Implementations: `src/agents/routes/payments.ts` (`POST /payments/create`, HITL
  branch) delegates via `executeMCPTool` to `src/mcp/commands.ts`
  (`DraftPaymentCommand`, `draft_payment`). Core is therefore shared: id
  `pay_<crypto.randomUUID().slice(0,8)>`, status `awaiting_confirmation`,
  `checkoutUrl`/`gatewayRef` `""`, amount must be finite and > 0 (#524), DID
  attestation, `#932` `registerDraftOwner`, audit `payment.awaiting_confirmation`.
- Deltas (all at the transport layer, all observable):
  - Gateway validation: the route rejects an unsupported gateway with 400
    `UNSUPPORTED_GATEWAY` BEFORE any row is written. The command's `execute()`
    does not validate the gateway at all (it casts `input.gateway || "stripe"`);
    its zod enum is not parsed at execution (see main doc auth-gate note). A
    direct MCP caller with an unsupported gateway proceeds where the REST caller
    gets a 400.
  - Description default: the route always passes `description` explicitly (even
    `""`), so an omitted REST description stores an empty note (#514 pin). A
    direct MCP caller that OMITS `description` gets the command's generic default
    `` `Payment intent for ${customer}` `` — same field, different value for the
    same "no description supplied" input.
  - Customer requiredness: the command's zod declares `customer` `min(1)` and its
    JSON schema requires it, but `execute()` trims it to `""` and proceeds; the
    route likewise allows `""` (no invented name, #514). Declared contract and
    effective contract differ on both layers; they agree only in the effective
    outcome.
  - Error shape: route maps failures to HTTP 400/500 JSON; direct MCP throws (no
    HTTP status mapping).

## P-2 / M02 — REST confirm (HITL) vs MCP confirm_payment_draft — DIVERGENT (error + shape; state transition shared)

- Implementations: `src/agents/routes/payments.ts` (`POST /payments/confirm`, HITL
  branch) delegates to `src/mcp/commands.ts` (`ConfirmPaymentDraftCommand`).
  Shared: approved charge/invoice creates a checkout UNCONDITIONALLY via the
  facade (overwriting any existing `checkoutUrl`/`gatewayRef`); approved refund
  executes a refund; note defaults `"Approved by human authorizer"` /
  `"Rejected by human reviewer"`; audits `payment.confirmed` (with
  `decision`/`status` fields) / `payment.rejected`.
- Deltas: missing draft — REST maps the command's throw to HTTP 404; direct MCP
  surfaces the throw (`Draft <id> not found in transactions repository`) with no
  status. The pre-#1690 REST silent-success-on-missing-draft survives only in
  immediate mode (see #1711), not in HITL. Response shape — REST returns
  `{success, status, draftId, checkoutUrl, gatewayRef, authorizerDid}`; MCP
  returns `{draftId, status, decision, checkoutUrl, gatewayRef, authorizerDid,
  executorDid, executedAt, transaction}` — the `executorDid` / `decision` / full
  transaction row are MCP-only.
- Shared gap (both layers, not a delta between them): neither the command nor
  the immediate-mode route checks the facade `createCheckout`/`executeRefund`
  success flag before writing `status: "completed"`. A failed checkout at confirm
  can therefore mark a draft completed with an empty `checkoutUrl`/`gatewayRef`.
  This is the limitation already recorded against #1690/#1711; it is confirmed
  present on current main, not newly introduced. The slice must decide (recorded)
  whether fixing it rides with this domain or as its own follow-up — it must not
  be silently re-described as fixed by a presentation unification.

## P-3 / M02 — REST transactions list vs MCP get_transactions — DIVERGENT (presentation + filter)

- Implementations: `src/agents/routes/payments.ts` (`GET /payments/transactions`)
  executes `get_transactions` via `runRestTool`
  (`src/agents/routes/restToolBridge.ts`), then re-maps every row (string
  coercions, `gateway` default `"stripe"`, `proposerDid` default
  `AGENT_DIDS.PAYMENTS`) and adds a `summary` (`totalVolume` over
  completed/authorized, `completedCount`, `pendingCount`, `verifiedDidCount`).
- Deltas: the route fixes `limit: 50` and ignores the command's `status` filter;
  the command (`GetTransactionsCommand`) accepts `limit` and `status` and returns
  raw rows with `count` and no summary. Same rows, different query surface and
  different response contract.

## P-4 / M02 — REST gateways vs MCP get_payment_gateways — IDENTICAL (core)

- `GET /payments/gateways`, `/payments/status` delegates via `executeMCPTool` to
  `GetPaymentGatewaysCommand`, which reads the same
  `PaymentGatewayService.getGatewayStatuses()` plus `AGENT_DIDS`.
- Delta (presentation only): the command returns an extra `count` field that the
  route drops (route returns 3 fields: `gateways`, `agentDids`, `userDid`). No
  contract divergence. Pin, don't rebuild.

## P-5 / P03 — Agentic wallet REST vs MCP agentic_wallet_status — DIVERGENT

- Implementations: `src/agents/routes/agenticPayments.ts`
  (`GET|POST /payments/agentic/auto-approve-limit`,
  `GET /payments/agentic/wallet`) and `src/mcp/agenticPaymentCommands.ts`
  (`AgenticWalletStatusCommand`), both over the same
  `ETradeAgenticPaymentService` (`src/services/agenticPayments.ts`). Shared core:
  simulated `$50` local-ledger balance, per-identity persisted limit
  (`agentic:autoApproveLimitUSD:<sessionId>` in `mas_memory`), env default
  `X402_AUTO_APPROVE_LIMIT` (0.05), network default `base-sepolia`.
- Deltas: set-limit input — route accepts `limitUSD` OR `limit`; command accepts
  only `limitUSD`. Route POST with neither → 400 `"Invalid limitUSD"`; command
  with `limitUSD` undefined silently falls through to a status read (no error,
  no write). Set-limit validation — route rejects negative/NaN with 400 before
  calling the service; command passes the value straight to `setAutoApproveLimit`,
  which throws on negative (uncaught in the command → error, not a 400). Audit —
  route audits `agentic_payment.limit_updated`; the command audits nothing on
  set-limit (its status path also audits nothing). Response shape — route GET
  returns the raw wallet status; command status returns `{success: true,
  ...status}`; route POST returns `{success, autoApproveLimitUSD}`; command
  set-limit returns a human message string
  (`` `Agentic payment auto-approval limit set to $X.XX USD.` ``).
- Wallet-status scoping caveat (same service, different readers):
  `getWalletStatusSync()` counts only rows stamped with the service's own
  `sessionId`; in payer-bound (anonymous premium gateway) mode, persisted rows
  are stamped `x402:<payer>`, so a payer-bound wallet read and a session wallet
  read over the same store report different totals by construction (#183).
- REST-only, no MCP pair: `/payments/agentic/ledger/record` (409 on replayed
  idempotency key, `amountCents` floored), `/ledger/budget-state`,
  `/ledger/payments` (limit clamped 1–500, newest-first with insertion-order
  tie-break). The MCP wallet's "balance" is a simulated local-ledger figure ($50
  starting credit), stated in the tool description — not an on-chain read.

## P-6a / P01 — Premium gated REST vs MCP paid_options_screener — DIVERGENT

- Same price tier (`TRADING_PAID_SERVICES.OPTIONS_SCREENER`, $0.05 USDC) and same
  engine (`UnifiedOptionsService` screen), different contracts:
  - Gate: MCP returns a 402 challenge object inside a 200 tool result and
    verifies `PAYMENT-SIGNATURE` itself; REST uses `handleGatedEndpoint`
    (real HTTP 402 path) on the shared `premium-gateway` instance, with
    anonymous-payer identity (`payerScopeId(receipt.payer)`) when no
    `x-user-login` is present.
  - Execution: MCP `channel:"mcp"`, `userLogin=sessionId`, no platform deps,
    no canonical capture/run-linking. REST `channel:"webhook"`,
    `callerTier:"premium"`, platform deps (sql/blob) when available, premium
    scans captured and run-linked like REST scans.
  - Filter validation: both use the shared options-filter schema, but REST
    also accepts a GET query-string spelling; MCP takes only JSON fields
    (single `underlying`, not a list).
  - Envelope: MCP `{status:200, paid, receipt, matchesCount, totalMatches,
    screenStatus, contracts, …}`; REST returns the service screen result
    (plus receipt handling inside the gate).

## P-6b / P02 — Premium gated REST vs MCP paid_market_research — DIVERGENT

- Same tier ($0.10 USDC) and same `generateResearchReport` core, same
  gate/channel/identity/capture deltas as P-6a (MCP `channel:"mcp"` vs REST
  gated premium endpoint).
- MPP: the REST gate handles MPP end-to-end via mppx (`handleMppRequest`,
  `WWW-Authenticate` challenge, receipt via `withReceipt`). The MCP `verifyPayment`
  path explicitly rejects MPP credentials from headers
  (`"MPP credentials must be verified through the mppx gateway"`), so MCP paid
  tools are x402-only in practice.
- Coverage: `STOCK_SIGNALS` ($0.02) exists as a REST gated tier
  (`TRADING_PAID_SERVICES`) with NO MCP paid counterpart — there is no
  `paid_stock_signals` command. MCP paid surface = 2 tools; REST gated surface =
  3 tiers.
- 402 contract: REST returns a real HTTP 402 `Response` with `PAYMENT-REQUIRED` /
  `WWW-Authenticate` headers; MCP returns a 402-shaped OBJECT
  (`{status: 402, paid: false, challenge, ...}`), not an HTTP response.
- Post-payment execution: MCP screener runs through `UnifiedOptionsService`
  (the REST engine) with the shared options-filter schema (#959/#982) — that leg
  is unified; MCP research runs `FossResearchService.generateResearchReport`,
  the same service the REST research gate fulfills through.

## P-7 — Agentic ledger REST vs PaymentsAgent ledger client — IDENTICAL (single ledger of record)

- `src/agents/routes/agenticPayments.ts` (`POST /payments/agentic/ledger/record`,
  `GET /payments/agentic/ledger/budget-state`,
  `GET /payments/agentic/ledger/payments`) and the client in
  `src/payments/ledger.ts` (`recordLedgerPayment`, `fetchLedgerBudgetState`,
  `listLedgerPayments`), consumed by `src/agents/payments-agent.ts`.
- Why identical, not parallel: the client is a transport to the same route over
  the `SEARCH_AGENT` DO channel (fail-loud when unbound); the mapping is one
  function pair (`buildLedgerTransaction` / `toPaymentRecord`, cents ↔ dollars
  via `/100` and `Math.round(*100)`, `idempotencyKey` ↔ `gatewayRef`);
  duplicate-key handling is one rule (existing row → HTTP 409 `{duplicate: true}`
  / client `{duplicate: true}`); budget state is one derivation
  (`deriveBudgetGuardState`, today-only spend, `seenKeys` capped at 2000, inbound
  `agentic_payment` rows never count, outbound `micropayment` x402/mpp rows
  attribute to `orchestrator`). No second ledger of record remains on current main.
- Minor presentation deltas (not divergence): the payments-list route clamps
  `limit` to 1–500 (default 50) and tie-breaks same-millisecond rows by insertion
  order (newest first); the client defaults limit 50.

## Auth-gate note (applies across this domain)

No per-handler auth check was found inside the payments route handlers or inside
their MCP commands — both layers inherit the orchestrator dispatcher's session.
MCP command execution (`McpToolFactory.executeTool`, `src/mcp/commands.ts`) calls
`command.execute()` directly — the declared `zodSchema` on commands is NOT parsed
at execution time, so zod-only constraints (enums, `min(1)`, defaults) are not
enforced on the execute path.
