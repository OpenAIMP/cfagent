/**
 * Issue #2193 (sub-issue of #2012, slice 1 of the native-payments
 * program #2146, stacked on slice 0 #2189) — the checkout port.
 *
 * ADR 0002 R1 boundary: this module is types only. It imports no
 * store client, no gateway SDK, no Stripe/x402 client, and reads no
 * env. Rails live in the adapters (StripeCheckoutAdapter,
 * X402CheckoutAdapter, InMemoryCheckoutAdapter); the native gate
 * (src/services/nativeMonetization.ts) depends only on this port.
 *
 * The port is deliberately rail-aware: one interface, two evidence
 * methods, one per rail. An adapter implements its own rail's
 * evidence method and THROWS for the other rail — a loud
 * rejection, never a silent cross-rail answer. The gate routes by
 * the rail stored at checkout time.
 *
 * Confirm semantics live in the gate, not here: this port returns
 * evidence (a Stripe session retrieve, a facilitator verdict) and
 * the gate applies the four-condition card rule and the
 * facilitator + amount + payer crypto rule. A redirect (Stripe
 * success page, cfpay return page) is never evidence and never
 * reaches this port.
 */
import type { PriceFamily } from "../data/priceCataloguePorts";

/** Rails the native gate can mint a checkout on. */
export type CheckoutRail = "stripe" | "x402";

/** Everything a checkout mint needs. Amount is per-checkout: the caller passes the run's catalogue price (or, for a subscription checkout, the plan price), never a deployment-wide amount. `runRequestId` is the checkout join key: a screener run-request id for run checkouts, the route-minted `sub-` draft id for subscription checkouts. `family` is present for run checkouts and absent for subscription checkouts (a plan has no screener family); no adapter reads it for card — the Stripe adapter charges priceUSD and binds the session via client_reference_id alone. */
export interface CreateCheckoutInput {
  runRequestId: string;
  family?: PriceFamily;
  priceUSD: number;
  email: string;
  userId: string;
}

/** The 402 challenge handed to an x402 payer. Shape mirrors ETradeAgenticPaymentService.createX402Challenge, but the recipient here is always the explicitly configured one — the adapter that builds this never touches that service's hardcoded fallback. */
export interface CheckoutChallenge {
  version: string;
  network: string;
  recipient: string;
  amountUSD: number;
  currency: "USDC";
  facilitator: string;
  resource: string;
  nonce: string;
  expiresAtMs: number;
}

/** What a minted checkout looks like to the gate. checkoutId is the provider join key: the Stripe session id for card, the run-request id for x402 (the challenge nonce binds the proof to the run). checkoutUrl is a redirect only — never proof of payment. */
export interface CheckoutCreation {
  rail: CheckoutRail;
  checkoutId: string;
  checkoutUrl?: string;
  challenge?: CheckoutChallenge;
}

/** Evidence from a Stripe session retrieve (GET /v1/checkout/sessions/{id}). Raw provider fields, unjudged: the gate applies the confirm rule. */
export interface CardSessionEvidence {
  sessionId: string;
  status: string;
  paymentStatus: string;
  amountTotalCents: number;
  clientReferenceId: string;
  paymentIntentId?: string;
}

/** Verdict from a facilitator verification of an x402 payment proof. `verified` is true only when the facilitator answered isValid === true for a verify request that carried this run's amount + recipient as paymentRequirements; the gate still checks the payer and the challenge nonce itself. */
export interface CryptoVerification {
  verified: boolean;
  payer: string | null;
  nonce: string | null;
}

/**
 * The checkout surface the native gate consumes. One port, both
 * rails; each adapter serves its own rail and throws for the other.
 */
export interface CheckoutPort {
  readonly rail: CheckoutRail;
  createCheckout(input: CreateCheckoutInput): Promise<CheckoutCreation>;
  retrieveCardSession(input: { sessionId: string }): Promise<CardSessionEvidence>;
  verifyCryptoPayment(input: { paymentProof: string; expectedAmountUSD: number }): Promise<CryptoVerification>;
}

/** The bundle the composition root builds: one port per rail, null per unconfigured rail. */
export interface CheckoutPorts {
  card: CheckoutPort | null;
  x402: CheckoutPort | null;
}
