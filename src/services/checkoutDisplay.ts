/**
 * Issue #2196 (sub-issue of #2012, slice 3 of the native-payments
 * program #2146, stacked on #2195) — server-derived checkout display
 * values for the pricing route.
 *
 * Pure derivation only: this module reads no env, imports no gateway
 * SDK and no store client. The route (the wiring layer) supplies the
 * already-resolved inputs — the Stripe mode from
 * StripePaymentStrategy.resolveApiKey, the x402 network name when the
 * x402 checkout port exists, and the raw browser-scope operator value
 * — and this module turns them into the marker the UI renders. The UI
 * must never hardcode the network: it renders exactly what this
 * marker says.
 *
 * Network truth:
 * - Stripe mode comes from resolveApiKey: "sandbox" (test keys) or
 *   "live" (live keys). "unconfigured" means no direct REST Stripe key
 *   is present — the MCP-remote path is NOT a screener card
 *   configuration (see createCheckoutPorts.ts), so it never counts
 *   as configured here either.
 * - x402 network is resolved through the x402 network table: only
 *   "Base" is mainnet today; "Base Sepolia" is testnet. An unknown
 *   name resolves to null (never a guessed network).
 * - acceptsMainnet is true when EITHER rail can take mainnet money.
 *   With nothing configured it is false, so the panel's testnet
 *   presentation is the fail-closed default, not a hardcoded claim.
 *
 * Browser scope:
 * - "card-only" is the default: the browser offers card only, and
 *   x402 is an API/agent 402 flow. The scope is operator data served
 *   by the pricing route, so widening it to "card-and-x402" needs no
 *   client deploy — but an unknown value fails closed to card-only,
 *   never to a wider scope.
 */
import { resolveX402Network } from "./x402Networks";

/** Rails the browser may offer, as served by the pricing route. */
export type BrowserPaymentScope = "card-only" | "card-and-x402";

/** Stripe key mode as resolved by the strategy, plus unconfigured. */
export type StripeDisplayMode = "sandbox" | "live" | "unconfigured";

/** The server-derived network marker the checkout UI renders. */
export interface NetworkMarker {
  stripeMode: StripeDisplayMode;
  /** Canonical x402 network name ("Base" / "Base Sepolia"), or null when the x402 rail is not configured. */
  x402Network: string | null;
  /** True when either configured rail can accept mainnet payment. False is the fail-closed default. */
  acceptsMainnet: boolean;
}

/**
 * Resolve the browser payment scope from the operator value.
 * Anything other than the exact "card-and-x402" string — including
 * unset, empty, or misspelled values — resolves to "card-only".
 */
export function resolveBrowserPaymentScope(raw: unknown): BrowserPaymentScope {
  return raw === "card-and-x402" ? "card-and-x402" : "card-only";
}

/**
 * Derive the network marker from the resolved Stripe mode and the
 * x402 network name (null when the x402 port does not exist).
 * No value here is hardcoded to a network: every field follows its
 * input, and an unresolvable x402 name yields null, not a guess.
 */
export function deriveNetworkMarker(input: {
  stripeMode: StripeDisplayMode;
  x402Network: string | null;
}): NetworkMarker {
  const info = input.x402Network ? resolveX402Network(input.x402Network) : null;
  const x402Network = info ? info.name : null;
  return {
    stripeMode: input.stripeMode,
    x402Network,
    acceptsMainnet: input.stripeMode === "live" || (info !== null && info.testnet === false),
  };
}
