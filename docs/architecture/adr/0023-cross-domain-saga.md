# ADR 0023: Cross-domain saga — paid screener run → trade, coordinated as a linear leg sequence

- Status: Proposed (not accepted; awaits owner ruling on the open questions in the companion design on #2041)
- Date: 2026-10-31
- Deciders: owner, #CTO-mbshr
- Issue: #2041
- Implementing PR: TBD (slices S1–S4, one PR each, after design approval; S1 — skeleton + Leg 0/1 — is the first slice)
- Related: docs/architecture/adr/0017-workflowport-is-not-a-dag.md,
  `src/workflows/paymentWorkflow.ts`,
  `src/workflows/paymentWorkflowFlow.ts`,
  `src/workflows/screenerWorkflow.ts`,
  `src/agents/trading-trade-workflow.ts`,
  `src/trading/channels/approval.ts`,
  `src/services/nativeMonetization.ts`
- Companion design + gap register: issue #2041 (design comment, gap register + close-rule comment; the design carries the leg detail, the register carries Q1–Q10 and gaps G-OBS through G-OUTCOME-NOTICE)

## Context

Three workflows already exist, each durable and each complete inside
its own domain, and none of them crosses domains:

- `PaymentWorkflow` gates payment and starts a screener
  (`src/workflows/paymentWorkflowFlow.ts`: gate → approval-before-
  capture → `step.do("start-screener")` through the screener workflow
  port). Its outcome is `{ status: "started", screenerWorkflowId }`:
  it returns the moment the screener starts and never observes what
  the screener does next. It is a handoff, not a saga.
- `ScreenerScreenWorkflow` runs the screen
  (`src/workflows/screenerWorkflow.ts`), with parent → child fan-out
  already built (`workflowChildOps`: `createChild` via
  `startWorkflowInstance`, `getChildStatus` via `instance.status()`,
  polled on a durable sleep + poll loop). That fan-out is
  screener-shard-scoped; the saga's cross-workflow leg observation
  port is new work (gap G-OBS in the companion gap register).
- `TradingTradeWorkflow` wraps one previewed order
  (`src/agents/trading-trade-workflow.ts`): proposal → 24h approval
  wait → approver verification → claim-then-execute through the
  order owner's approval door (`executeApprovedOrder` →
  `settleTradingOrder`). Timeout settles nothing. The #1262 engine
  (`src/trading/channels/approval.ts`) supplies the tier gate, draft
  lookup, and executeOrder behind it, and `trade_stock` /
  `trade_options` (`src/agents/trading-agent.ts`) are preview-only by
  construction: they never place an order.

What does not exist is the journey across them: a paid run whose
screen is observed to completion, whose user is then asked — once,
at journey level — whether to enter trading at all, and whose paid
screen is compensated when it fails after starting. Today a paid
screen that starts and then fails mid-run yields no credit, because
nothing observes the screener outcome after `"started"`; the only
credit path in the payment leg covers failure to start
(`startScreenerOrCredit` catch → `issueFailureCredit`, DO ledger row
deduped per run, D1 redeemable claim). And there is no gate between
"screen delivered" and "trading begins" other than the per-order
approvals themselves, which answer a different question ("execute
this order?") than the journey question ("enter trading on the
strength of this screen?").

Two corrections to the brief's assumptions, both verified on main,
shape this decision:

- The live payment gate is `NativeMonetizationGate`
  (`src/services/nativeMonetization.ts`); the cfpay gate
  (`src/services/cfpayMonetization.ts`) is deprecated and superseded.
  The saga designs against the native gate.
- The gate is no longer testnet-only: Base mainnet was admitted by
  owner direction 2026-10-28 (Phase 6, #2016), default network still
  `base-sepolia`. The saga's PROD/mainnet exclusion is therefore a
  scope decision this ADR makes, not a capability limit it reports.

## Decision

Build the cross-domain journey as a **new ThinkWorkflow that
coordinates the three existing workflows as children in a linear leg
sequence with human gates** — never as a DAG, never by re-implementing
a leg:

1. **Leg 0 — Payment gate (child: PaymentWorkflow).** The gate is
   the native gate (`NativeMonetizationGate`; CBO lane's gate
   lineage — the cfpay gate it supersedes is deprecated). Flagship flag
   `"monetization"` (#2043), default OFF, fail-closed. Payment
   outcomes that are not `"started"` end the saga with no screen,
   no credit, and no trading leg. `"started"` carries the
   `screenerWorkflowId` forward; the saga does not start a second
   screener.
2. **Leg 1 — Observe the paid screen (poll).** The saga polls the
   screener child on the existing durable sleep + poll pattern until
   a terminal status or a deadline. Completed → journey gate.
   Failed, or deadline with no terminal status → issue the one-time
   failure credit through the payment leg's dep shape (DO ledger
   row, deduped per run, fail-loud; D1 claim best-effort) and end.
   No trading leg.
3. **Leg 2 — Journey gate (human, saga-level).** `waitForEvent`
   before any trading leg begins. Deny or timeout ends the saga with
   no trades and no proposals, and no credit by default: the paid
   good (the screen) was delivered. Approval proceeds to Leg 3.
4. **Leg 3 — Trading leg (existing pieces only).** Propose via the
   preview-only `trade_stock` / `trade_options` surfaces, then hand
   the draft id to `TradingTradeWorkflow`, whose 24h approval wait,
   approver verification, and claim-then-execute run unchanged.
   Per-order outcomes pass through; the saga never re-interprets
   a per-order decision.

Invariants, all inherited from the pieces rather than invented:

- Params carry ids only — never credentials, secrets, cards, or
  prices (the cfpay rule, repeated in all three workflows).
- `userLogin` is required; absent means fail closed (issue #1185),
  never a synthetic identity.
- One compensation per paid run, ever (DO-ledger dedupe per run):
  a replacement-run credit on x402, a provider refund first on
  stripe (rail-aware compensation per Venus 2026-10-31; see design
  §2.6/§3.3). The shared disclosure string states the rail's
  compensation before payment.
- Every saga leg transition writes one `mas_events` row under the
  saga id (same run id as screen and payment); consequential
  transitions (credit issuance, journey decision, trade-leg entry)
  use the Q7 S2 blocking pattern (`recordBlockingAudit`), so a
  failed audit write blocks the transition instead of recording an
  unrecorded completion. From a workflow step, the reachable form
  of that pattern is endpoint-mediated (POST `/api/audit/event`
  throwing on non-2xx); direct ORM access from the workflow
  runtime is not reachable — see the reachability note in
  `src/workflows/sagaWorkflowFlow.ts` and gap G-AUDIT-WORKFLOW.
- The saga adds no new audit system and no new delivery channel:
  the screen leg's delivery contract (email with PDF, Slack text
  post with PDF, report in UI, immediately) is unchanged, and the
  saga's own outcome is a retrievable record under the same run id.

Scope held out of this decision: pricing (CPO's; catalogue values
are proposed, unapproved); PROD/mainnet activation (excluded — the
gate's mainnet admission does not pull the saga onto mainnet);
redemption UX for issued credits (issuance verified, redemption
path unverified and left to the implementation slices); the saga
entry route (a reviewed wiring step, like the payment leg's own
adoption route, which no route calls by default yet).

## Implementation status (S1)

S1 implements the skeleton + Leg 0/1 only: `CrossDomainSagaWorkflow`
(thin adapter) + `sagaWorkflowFlow` (flow core) + `sagaLegPort`
(the new cross-workflow leg observation port, gap G-OBS) +
`SAGA_WORKFLOW` binding + `Env` type + the four Leg 0/1 outcome
catalog entries (gap G-CATALOG, in part — journey and trading
entries arrive with S2/S4) + derived saga leg instance ids (gap
G-SAGA-ID) + the resume/adopt pin (gap G-REPLAY) + the
endpoint-mediated blocking audit dep with its reachability note
(gap G-AUDIT-WORKFLOW, reachable half pinned). S1 ends at
`screen_completed`; S2 inserts the journey gate after that point,
S3 adds refund/credit execution, S4 adds the trading leg and the
entry route. No route calls the saga yet by default.

## Consequences

- The paid-screen failure gap closes: a screen that fails after
  starting becomes creditable, because for the first time something
  observes the screener outcome after `"started"`.
- The journey question gets its own gate, distinct from per-order
  approval: a user can decline to enter trading without declining
  (or ever seeing) a trade proposal, and a denied journey can never
  produce a trade by accident — denial means no proposals exist to
  approve.
- Nothing already built is forked: the gate, the screen, the
  proposal surfaces, the approval engine, and the trade workflow
  are all reused through their bindings. A fix to any leg propagates
  to the saga without a saga change.
- The saga is a fourth workflow binding (`SAGA_WORKFLOW`,
  alongside `PAYMENT_WORKFLOW`, `SCREENER_WORKFLOW`,
  `TRADE_WORKFLOW` in `wrangler.jsonc` + `Env`), so its activation
  is a binding + route decision, not a flag flip inside another
  workflow.
- A denied or expired journey is a visible record, not an absence:
  the saga outcome row names the leg and reason under the run id.
- Known wart (no live effect until S3): the redemption path for an
  issued D1 claim is not pinned in this decision; S3 must pin it
  before credit can be spent, not merely issued.

## Alternatives considered

- **Fold the journey into PaymentWorkflow.** Rejected: the payment
  leg's job is deliberately bounded at `"started"`, and extending
  it to observe screens, gate journeys, and run trades would turn a
  handoff into the saga by accretion — the same class of scope
  creep the thin-adapter + flow-core split exists to prevent.
- **Inline the gate in the saga instead of starting PaymentWorkflow.**
  Rejected: duplication of the gate, the capture approval, the
  ledger writes, and the start-failure credit — four places a fix
  would then have to reach instead of one.
- **Describe the saga as a DAG over WorkflowPort.** Rejected by
  ADR 0017: WorkflowPort is a linear stage pipeline + shard fan-out
  + job state machine, not a dependency graph. The saga needs no
  declared dependencies or topological scheduling — legs run in
  fixed order with human gates between them — so no DAG
  generalization is required or claimed.
- **Credit on journey denial.** Rejected as the default (open
  question Q3 in the companion design): the screen was delivered,
  so denial is a choice, not a failure; crediting it would make
  the screen free whenever the user declines to trade.
- **Refund instead of credit (superseded 2026-10-31).** The original
  brief predates the rail-aware compensation ruling: on stripe the
  compensation IS a provider refund (refund ports exist; the adapter
  is S3 work), on x402 it remains credit unless Q9 rules otherwise
  (an on-chain payment cannot be reversed). The disclosure states
  the rail's compensation before payment.
