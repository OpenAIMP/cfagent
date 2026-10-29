/**
 * Issue #2219 (program #2218, slice 1) — platform identity resolution
 * for the payment workflow screen.
 *
 * The payment screen's tenant / user / account are AUTOMATIC and
 * READ-ONLY: the server resolves them from the verified session
 * login, and the UI only displays what this module returns. A
 * client-supplied tenantId is untrusted input, never identity, so
 * no caller in this slice reads one — the paid-submission and
 * subscription checkout/purchase routes derive the tenant from
 * the resolved identity below and ignore any client-supplied
 * value, even on mismatch (resolved identity wins).
 *
 * Port-first (ADR 0002): this module depends only on port
 * interfaces (CommercialStore, SubscriptionStore) and on the
 * pure helpers in the data layer. It never imports a store
 * client, references env.AGENT_DB, or writes SQL. Callers build
 * the ports from the composition roots (createCommercialAdapter,
 * createSubscriptionAdapter — null when unbound) and pass them
 * in. No parallel account store exists: the commercial and
 * subscription ports ARE the platform identity source in this
 * slice; later platform slices may add a dedicated identity port
 * behind this same shape.
 *
 * No-account behavior (PROPOSED, owner may correct — see the PR
 * body): a missing store row is not an error for the DISPLAY
 * read (hasAccount false, tenantId null, tier Free, zero
 * balances — Free is implicit, #1076). On a PAID path the caller
 * must fail closed with NO_ACCOUNT_PAID_MESSAGE, directing the
 * user to account setup (a platform surface to come) — never
 * invent an account or tenant, never fall back to a text field.
 * On the FREE path (monetization flag OFF) the caller proceeds
 * exactly as today; the flag-OFF fallback scope is the caller's
 * decision, not this module's (see the submit route).
 */
import {
  type CommercialAccountRecord,
  type CommercialStore,
  type StoreTier,
} from "../data/commercialPorts";
import {
  resolveEffectiveTier,
  type SubscriptionStore,
} from "../data/subscriptionPorts";

/** Paid-path failure message for a user with no resolved account. */
export const NO_ACCOUNT_PAID_MESSAGE =
  "No commercial account is set up for your signed-in account yet. " +
  "Set up an account through platform management (coming) or ask an operator " +
  "to create one, then try again. No charge was made.";

/** Port inputs for identity resolution (adapters satisfy these structurally). */
export interface PlatformIdentityPorts {
  commercial: CommercialStore | null;
  subscriptions: SubscriptionStore | null;
}

/** The resolved platform identity for one verified login. */
export interface PlatformIdentity {
  userLogin: string;
  /** Null when no store row exists — never a guessed value. */
  tenantId: string | null;
  hasAccount: boolean;
  /** Effective tier at read time (a lapsed subscription stops conferring Subscribed). */
  tier: StoreTier;
  creditsUSD: number;
  includedRunsRemaining: number;
  /** The stored row, when one exists, for callers that build an account view from it. */
  stored: CommercialAccountRecord | null;
}

/**
 * Resolve the platform identity for a verified login.
 *
 * Fail-closed throughout: an unbound store throws (no identity
 * can be verified), and a subscription-read failure throws (no
 * tier can be verified). A missing store row is NOT a failure —
 * it resolves to hasAccount false with a null tenant; whether a
 * caller may proceed without an account is the caller's path
 * decision (paid fails closed, free proceeds), never this
 * module's.
 */
export async function resolvePlatformIdentity(
  ports: PlatformIdentityPorts,
  input: { userId: string; nowMs: number },
): Promise<PlatformIdentity> {
  if (!ports.commercial || !ports.subscriptions) {
    throw new Error(
      "Commercial account store is unavailable; refusing to resolve platform identity without verified account data.",
    );
  }
  const stored = await ports.commercial.getAccount(input.userId);
  let subscriptions: Array<{ periodEndMs: number }>;
  try {
    subscriptions = await ports.subscriptions.listSubscriptions(input.userId);
  } catch (err) {
    throw new Error(
      `Subscription state unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const tier = resolveEffectiveTier(stored, subscriptions, input.nowMs);
  return {
    userLogin: input.userId,
    tenantId: stored ? stored.tenantId : null,
    hasAccount: stored !== null,
    tier,
    creditsUSD: stored ? stored.creditsUSD : 0,
    includedRunsRemaining: stored ? stored.includedRuns : 0,
    stored,
  };
}

/** The identity shape the self-only read endpoint returns (no stored row leaks). */
export function toPlatformIdentityView(identity: PlatformIdentity): {
  userLogin: string;
  tenantId: string | null;
  hasAccount: boolean;
  tier: StoreTier;
  creditsUSD: number;
  includedRunsRemaining: number;
} {
  return {
    userLogin: identity.userLogin,
    tenantId: identity.tenantId,
    hasAccount: identity.hasAccount,
    tier: identity.tier,
    creditsUSD: identity.creditsUSD,
    includedRunsRemaining: identity.includedRunsRemaining,
  };
}
