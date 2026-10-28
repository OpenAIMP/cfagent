# 2020 — Subscriptions (#2020/#2127)

- **D1 subscription object (#2020)**: `agent_subscriptions` (one row per purchase: user, tenant, plan, provider, payment reference, status, period, cancel time) and `agent_subscription_plans` (operator-managed plans) via migration 0008 in `src/data/migrationRunner.ts` and the data-foundation port pattern (`src/data/subscriptionPorts.ts` + `src/data/d1SubscriptionAdapter.ts` + `src/data/inMemorySubscriptionAdapter.ts` + `src/data/createSubscriptionPorts.ts`). The payment-reference UNIQUE index is the replay guard: one verified checkout activates at most one subscription.
- **Plans as operator data, not code (#2020)**: operators create/deactivate plans via `POST /payments/agentic/commercial/plans` and `POST /payments/agentic/commercial/plans/deactivate`; any verified login lists active plans. No price is hardcoded anywhere — no subscription price is owner-approved.
- **Checkout-to-subscription (#2020)**: `POST /payments/agentic/commercial/subscription/checkout` mints a route-owned cfpay checkout for the plan price, and `POST /payments/agentic/commercial/subscription/purchase` activates the subscription only after re-reading cfpay `checkout.status` as fulfilled/paid (never a return page). Activation sets the account tierSource to "subscription" and credits the plan's included runs, keeping the stored tier as the operator-managed baseline. Money paths fail closed (flag OFF → 403, no adapter → 503, unverified payment → no activation).
- **Cancellation (#2021)**: `POST /payments/agentic/commercial/subscription/cancel` cancels every unexpired row with access continuing to periodEnd (cancel-at-period-end). No cash refunds in this slice (deferred #2024).
- **Effective tier at read time (#2020/#2022)**: coverage checks (paid-submission route) and the ads resolvers now use `resolveEffectiveTier`: an unexpired subscription confers Subscribed over any stored tier, and a lapsed subscription stops conferring it, while an operator grant survives. No background sweeper, no new cron. A lapsed subscription returns the user to their stored baseline (Free, or PayPerUse — activation never overwrites the baseline, so PayPerUse is restored, not lost).

### Stated plainly: NO provider auto-renewal

cfpay is one-time-only and no provider subscription API exists in-repo, so renewal in this slice is repurchase before expiry (stacked from the latest periodEnd, so no paid time is lost). Provider-managed auto-renewal is a separate future slice and is NOT claimed here.

### Notes

- Purchase verifies fulfillment only, at the same level as the payment workflow: the cfpay status shape the gate consumes carries no amount field, so amount matching is not independently re-checked. The binding is route-owned checkout creation (the checkout is minted by this route for this plan's price) + fulfilled status.
- The stored account tier is the operator baseline; `GET /payments/agentic/commercial/account` now also returns the effective tier, and `GET /payments/agentic/commercial/subscription` is the effective-tier status read.
- No client changes, no new wrangler bindings (AGENT_DB already bound), no orchestrator mount (orchestrator.ts is at its size budget — endpoints live in the existing agenticPayments handler; thin_router_inventory 254 -> 261, delegation unchanged).
- No PROD activation: no flag default changes, no mainnet, no live price.
