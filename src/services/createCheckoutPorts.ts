/**
 * Issue #2193 (slice 1, #2146) — composition root for the checkout
 * port. This is the ONLY module that maps Worker env to checkout
 * adapters: it is the only place that reads checkout env (Stripe
 * keys, X402_RECIPIENT_ADDRESS, X402_NETWORK,
 * X402_FACILITATOR_URL) and constructs adapters. Domain code
 * imports this helper and the port types, never a gateway SDK.
 *
 * Returns null when NOTHING is configured (neither rail): callers
 * keep their fail direction — fail-closed on money paths. A rail
 * whose configuration is present-but-invalid is treated as
 * unconfigured for that rail (loud log, null port), so a bad x402
 * recipient can never break coverage paths or fall back to
 * anything; the gate still throws when that rail is actually
 * needed for a checkout.
 *
 * Card configuration is the DIRECT REST key only
 * (STRIPE_SECRET_KEY / STRIPE_TEST_SECRET_KEY /
 * STRIPE_LIVE_SECRET_KEY via StripePaymentStrategy.resolveApiKey).
 * The Stripe MCP-remote path (STRIPE_MCP_SERVER_URL) is NOT a
 * screener configuration: the migration uses the direct REST path
 * (design §4), so an MCP-only env yields a null card port.
 *
 * x402 configuration requires X402_RECIPIENT_ADDRESS to be present
 * and valid. There is no fallback here and none in the adapter:
 * the existing x402 service's hardcoded recipient is never read on
 * this path, in any environment.
 */
import type { Env } from "../types";
import { StripePaymentStrategy } from "../patterns/paymentStrategies";
import { PaymentGatewayService } from "./payments";
import type { CheckoutPorts } from "./checkoutPorts";
import { StripeCheckoutAdapter } from "./stripeCheckoutAdapter";
import { X402CheckoutAdapter } from "./x402CheckoutAdapter";

export type CheckoutEnv = {
  STRIPE_SECRET_KEY?: string;
  STRIPE_TEST_SECRET_KEY?: string;
  STRIPE_LIVE_SECRET_KEY?: string;
  STRIPE_MCP_SERVER_URL?: string;
  APP_BASE_URL?: string;
  X402_RECIPIENT_ADDRESS?: string;
  X402_NETWORK?: string;
  X402_FACILITATOR_URL?: string;
};

/** Build the checkout ports from Worker env, or null when neither rail is configured. */
export function createCheckoutPorts(env: CheckoutEnv): CheckoutPorts | null {
  let card: CheckoutPorts["card"] = null;
  try {
    const { apiKey } = new StripePaymentStrategy().resolveApiKey(env as unknown as Env);
    if (apiKey) {
      const service = new PaymentGatewayService(env as unknown as Env);
      card = new StripeCheckoutAdapter({
        createCheckout: (params) => service.createCheckout({ ...params, gateway: "stripe" }),
        retrieveSession: (sessionId) => service.retrieveCheckoutSession(sessionId),
      });
    }
  } catch (err) {
    console.error(
      `[checkout-ports] card rail unconfigured (bad Stripe configuration, failing closed for card): ${err instanceof Error ? err.message : String(err)}`,
    );
    card = null;
  }

  let x402: CheckoutPorts["x402"] = null;
  const recipient = (env.X402_RECIPIENT_ADDRESS ?? "").trim();
  if (recipient) {
    try {
      x402 = new X402CheckoutAdapter({
        recipientAddress: recipient,
        network: env.X402_NETWORK,
        facilitatorUrl: env.X402_FACILITATOR_URL,
      });
    } catch (err) {
      console.error(
        `[checkout-ports] x402 rail unconfigured (bad recipient/network configuration, failing closed for x402): ${err instanceof Error ? err.message : String(err)}`,
      );
      x402 = null;
    }
  }

  if (!card && !x402) return null;
  return { card, x402 };
}

export type { CheckoutPorts };
