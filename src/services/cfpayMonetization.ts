/**
 * Goal 1 Phase 2 (draft, #2014): cfpay monetization gate, TypeScript port.
 *
 * This is a standalone service: no route wiring, no flag enablement, no
 * PROD deployment in this file. Wiring it into the unified run-request
 * path is a separate, reviewed step under #2014, behind FeatureFlagPort,
 * default OFF.
 *
 * Mainnet (Phase 6, #2016) enabled by owner direction 2026-10-28:
 * the network allowlist below admits Base mainnet alongside the
 * Sepolia testnets. The default network stays base-sepolia — mainnet
 * requires an explicit MONETIZATION_NETWORK=base (or eip155:8453).
 * Ethereum mainnet is NOT admitted: it is not in cfpay's chain map.
 * Network here is the operator-declared deployment network and a
 * fail-closed allowlist only — settlement chain follows the cfpay
 * deployment's own configuration, so the two must be kept in
 * agreement by the operator.
 *
 * Rules (from the prototype, 16 tests, updated 2026-10-27 for
 * all-runs-scheduled-behind-the-scenes):
 * - One charge per run-request, never per stage/shard/leg/retry/re-serve.
 * - Manual runs: subscription/credits first, then cfpay checkout (402).
 * - Scheduled runs: subscription/credits only, never unattended card,
 *   EXCEPT a one-off scheduled run authorized by a human present at
 *   submission (scheduleKind "one_off" + authorizedAtSubmission), which
 *   may checkout at submission; execution happens later, on schedule.
 *   A scheduled run with no scheduleKind is treated as recurring.
 * - Tenant isolation: run tenant must equal the verified account tenant.
 * - Confirm paid only via cfpay checkout.status == fulfilled.
 *   Stripe return page is never proof. Replay of a tx hash / payment
 *   intent id is rejected. Identity, price, and network are fail-closed.
 * - cfpay cannot refund: a failed paid run gets a one-time replacement
 *   credit, disclosed before payment.
 * - Proposed prices, NOT approved: stock $0.02, goal $0.10,
 *   options $0.05 (existing), strategy $0.10.
 */

export type ScreenerFamily = "stock" | "goal" | "options" | "strategy";
export type RunTrigger = "manual" | "scheduled";
export type ScheduleKind = "one_off" | "recurring";

export const FAMILY_PRICES: Record<ScreenerFamily, number> = {
  stock: 0.02,
  goal: 0.1,
  options: 0.05,
  strategy: 0.1,
};

/**
 * Networks the gate accepts when monetization is enabled, as the
 * operator-declared MONETIZATION_NETWORK value. Testnets first
 * (the original testnet-only build), then Base mainnet, admitted by
 * owner direction 2026-10-28 (Phase 6, #2016). Identifiers follow
 * cfpay's chain map: "base" and "eip155:8453" are Base mainnet;
 * Ethereum mainnet ("eip155:1") is NOT in cfpay's map and is not
 * admitted. Anything else is refused fail-closed. The default
 * network (base-sepolia, in the workflow adapter) is unchanged —
 * mainnet requires an explicit opt-in value.
 */
export const ALLOWED_NETWORKS = ["base-sepolia", "ethereum-sepolia", "base", "eip155:8453"] as const;

/**
 * The failure policy, disclosed BEFORE any payment (gate + pricing
 * route share this one string so the UI can never drift from the
 * gate). Prices above are PROPOSED, not owner-approved. Text kept
 * truthful after #2140: mainnet on Base is admitted when the
 * operator configures MONETIZATION_NETWORK=base; the default
 * remains testnet (base-sepolia).
 */
export const PAYMENT_DISCLOSURE =
  "One charge per run-request. Shards, stages, retries and re-serves are free. Automated refunds are not available in v1; a paid run that fails gets a one-time replacement-run credit. Mainnet payments are accepted on Base (MONETIZATION_NETWORK=base); testnets remain available. Settlement chain follows the cfpay deployment configuration.";

export interface CfPayCheckoutClient {
  createCheckout(input: { requestId: string; email: string; request: string }): Promise<unknown>;
  checkoutStatus(requestId: string): Promise<{ status?: string; state?: string; paid?: boolean }>;
}

export interface CommercialAccount {
  userId: string;
  email: string;
  tenantId?: string;
  tier: "Free" | "PayPerUse" | "Subscribed";
  creditsUSD: number;
  includedRunsRemaining: number;
}

export interface MonetizationConfig {
  monetizationEnabled: boolean;
  network: string;
  familyPrices?: Partial<Record<ScreenerFamily, number>>;
}

export type GateDecision =
  | { allowed: true; status: string; runRequestId: string; priceUSD: number; paidVia?: string }
  | { allowed: false; status: string; httpStatus: 402; runRequestId: string; priceUSD: number; family: ScreenerFamily; checkout?: unknown; disclosure?: string; reason?: string };

interface LedgerRow {
  runRequestId: string;
  userId: string;
  tenantId?: string;
  family: ScreenerFamily;
  trigger: RunTrigger;
  priceUSD: number;
  status: "payment_required" | "paid";
  paidVia?: string;
}

export class CfPayMonetizationGate {
  private byRun = new Map<string, LedgerRow>();
  private byClaim = new Map<string, string>();
  private events: Array<{ runRequestId: string; type: string }> = [];

  constructor(
    private cfpay: CfPayCheckoutClient,
    private config: MonetizationConfig,
  ) {
    if (config.monetizationEnabled && !(ALLOWED_NETWORKS as readonly string[]).includes(config.network)) {
      throw new Error(`Refusing monetization on network ${config.network}: unknown network (allowed: ${ALLOWED_NETWORKS.join(", ")}).`);
    }
  }

  priceFor(family: ScreenerFamily): number {
    const override = this.config.familyPrices?.[family];
    if (override !== undefined) {
      if (!Number.isFinite(override) || override <= 0) throw new Error(`Price for ${family} is invalid`);
      return override;
    }
    return FAMILY_PRICES[family];
  }

  async check(run: { id: string; family: ScreenerFamily; trigger: RunTrigger; scheduleKind?: ScheduleKind; authorizedAtSubmission?: boolean; tenantId?: string; account: CommercialAccount }): Promise<GateDecision> {
    const { account } = run;
    if (!account.userId || !account.email) throw new Error("Verified user id and email are required");
    if (run.tenantId && account.tenantId && run.tenantId !== account.tenantId) throw new Error("Tenant mismatch: run tenant must equal the verified account tenant. No cross-tenant billing.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") {
      return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD, paidVia: existing.paidVia };
    }
    const priceUSD = this.priceFor(run.family);

    const coverage =
      account.tier === "Subscribed" && account.includedRunsRemaining > 0
        ? "subscription_included"
        : account.creditsUSD >= priceUSD
          ? "credits"
          : null;
    if (coverage) {
      if (coverage === "subscription_included") account.includedRunsRemaining -= 1;
      else account.creditsUSD = Math.round((account.creditsUSD - priceUSD) * 100) / 100;
      this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD, status: "paid", paidVia: coverage });
      return { allowed: true, status: "paid", runRequestId: run.id, priceUSD, paidVia: coverage };
    }
    // All runs are scheduled behind the scenes: only a one-off scheduled
    // run authorized at submission may checkout; every other scheduled
    // run (recurring, or no scheduleKind stated) is coverage-only.
    const isOneOffScheduled =
      run.trigger === "scheduled" && run.scheduleKind === "one_off" && run.authorizedAtSubmission === true;
    if (run.trigger === "scheduled" && !isOneOffScheduled) {
      this.events.push({ runRequestId: run.id, type: "scheduled.skipped_uncovered" });
      return { allowed: false, status: "coverage_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, reason: "Scheduled runs need subscription included usage or prepaid credits. No unattended card charge is taken." };
    }
    if (!this.config.monetizationEnabled) {
      return { allowed: true, status: "free_flag_off", runRequestId: run.id, priceUSD: 0 };
    }
    if (existing?.status === "payment_required") {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family };
    }
    const checkout = await this.cfpay.createCheckout({ requestId: run.id, email: account.email, request: `${run.family} run ${run.id}` });
    this.byRun.set(run.id, { runRequestId: run.id, userId: account.userId, tenantId: run.tenantId ?? account.tenantId, family: run.family, trigger: run.trigger, priceUSD, status: "payment_required" });
    return {
      allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD, family: run.family, checkout,
      disclosure: PAYMENT_DISCLOSURE,
    };
  }

  async confirmPaid(run: { id: string; userId: string; email: string }, proof: { claimTxHash?: string; paymentIntentId?: string; stripeReturnPage?: boolean } = {}): Promise<GateDecision> {
    if (proof.stripeReturnPage) throw new Error("A Stripe return page is not proof of payment.");
    const existing = this.byRun.get(run.id);
    if (existing?.status === "paid") return { allowed: true, status: "already_paid", runRequestId: run.id, priceUSD: existing.priceUSD };
    const claimKey = (proof.claimTxHash ?? proof.paymentIntentId ?? "").toLowerCase();
    if (claimKey) {
      const prior = this.byClaim.get(claimKey);
      if (prior && prior !== run.id) throw new Error(`This payment was already redeemed for run ${prior}`);
    }
    const status = await this.cfpay.checkoutStatus(run.id);
    const state = String(status?.status ?? status?.state ?? "").toLowerCase();
    if (!(state === "fulfilled" || state === "paid" || status?.paid === true)) {
      return { allowed: false, status: "payment_required", httpStatus: 402, runRequestId: run.id, priceUSD: existing?.priceUSD ?? 0, family: existing?.family ?? "goal" };
    }
    const priceUSD = existing?.priceUSD ?? 0;
    this.byRun.set(run.id, { ...(existing as LedgerRow), runRequestId: run.id, status: "paid" });
    if (claimKey) this.byClaim.set(claimKey, run.id);
    return { allowed: true, status: "paid", runRequestId: run.id, priceUSD };
  }
}
