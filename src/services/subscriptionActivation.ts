/**
 * Issues #2020/#2127 — purchase activation service.
 *
 * Port-level logic with no fetch and no flag reads, so it is
 * unit-testable without a payment rail: the route verifies the
 * payment (flag ON, provider state re-read and judged paid) and
 * then calls here. Native callers pass provider "stripe" plus the
 * Stripe session/payment-intent ids; legacy callers pass nothing
 * and keep provider "cfpay" with null Stripe ids.
 *
 * Activation, in order:
 * 1. The plan must exist and be active (an operator-deactivated
 *    plan cannot be bought, even with a valid checkout).
 * 2. The payment reference must be unused (replay guard — the
 *    UNIQUE index on provider_payment_ref is the backstop).
 * 3. The period stacks from the latest paid-through instant, so
 *    repurchase before expiry loses no paid time.
 * 4. The account keeps its stored tier (the operator-managed
 *    baseline) and gains tierSource "subscription" plus the
 *    plan's included runs. The effective tier is Subscribed
 *    while the period is unexpired (see resolveEffectiveTier);
 *    activation never overwrites the baseline, so a lapse
 *    restores PayPerUse instead of dropping the user to Free.
 * 5. Tenant: an existing account with a different tenant refuses
 *    (no cross-tenant activation); a missing account is created
 *    in the caller's tenant (the tenant is pinned from then on).
 */
import type { CommercialAccountRecord, CommercialStore } from "../data/commercialPorts";
import {
  MS_PER_DAY,
  nextPeriodStartMs,
  type SubscriptionPlanRecord,
  type SubscriptionRecord,
  type SubscriptionStore,
} from "../data/subscriptionPorts";

export interface ActivationInput {
  subs: SubscriptionStore;
  store: CommercialStore;
  userId: string;
  tenantId: string;
  plan: SubscriptionPlanRecord;
  providerPaymentRef: string;
  /** Native only: defaults to "cfpay" so existing callers are unchanged. */
  provider?: string;
  /** Native only: the Stripe session + payment-intent ids, stored for refunds (#2198). Null when absent. */
  stripeSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  nowMs?: number;
}

export interface ActivationResult {
  subscription: SubscriptionRecord;
  account: CommercialAccountRecord;
}

export async function activateSubscription(input: ActivationInput): Promise<ActivationResult> {
  const { subs, store, userId, tenantId, plan, providerPaymentRef } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!plan.active) throw new Error(`Plan ${plan.id} is not active.`);
  if (!providerPaymentRef) throw new Error("providerPaymentRef is required.");
  const replay = await subs.findByPaymentRef(providerPaymentRef);
  if (replay) {
    throw new Error(`Payment reference ${providerPaymentRef} already activated subscription ${replay.id}.`);
  }
  const existing = await store.getAccount(userId);
  if (existing && existing.tenantId !== tenantId) {
    throw new Error("Tenant mismatch: subscription tenant must equal the verified account tenant.");
  }
  const prior = await subs.listSubscriptions(userId);
  const periodStartMs = nextPeriodStartMs(
    prior.map((s) => s.periodEndMs),
    nowMs,
  );
  const periodEndMs = periodStartMs + plan.periodDays * MS_PER_DAY;
  const subscription = await subs.createSubscription({
    id: `sub-${crypto.randomUUID().slice(0, 8)}`,
    userId,
    tenantId,
    planId: plan.id,
    provider: input.provider ?? "cfpay",
    providerPaymentRef,
    stripeSessionId: input.stripeSessionId ?? null,
    stripePaymentIntentId: input.stripePaymentIntentId ?? null,
    periodStartMs,
    periodEndMs,
  });
  const account = await store.upsertAccount({
    userId,
    tenantId,
    tier: existing?.tier ?? "Free",
    tierSource: "subscription",
    creditsUSD: existing?.creditsUSD ?? 0,
    includedRuns: (existing?.includedRuns ?? 0) + plan.includedRuns,
  });
  return { subscription, account };
}
