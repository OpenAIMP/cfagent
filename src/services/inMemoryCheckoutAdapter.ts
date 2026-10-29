/**
 * Issue #2193 (slice 1, #2146) — in-memory checkout port.
 *
 * A test double with the same port semantics as the real adapters.
 * It is NOT a production checkout and NOT a fallback: it exists so
 * the port conformance suite runs unchanged against a store-free
 * implementation, and so gate tests can script evidence without
 * network. Production wiring never constructs it (the composition
 * root builds only the Stripe/x402 adapters, or null).
 */
import type {
  CardSessionEvidence,
  CheckoutChallenge,
  CheckoutCreation,
  CheckoutPort,
  CheckoutRail,
  CreateCheckoutInput,
  CryptoVerification,
} from "./checkoutPorts";

export class InMemoryCheckoutAdapter implements CheckoutPort {
  readonly rail: CheckoutRail;
  private sessions = new Map<string, CardSessionEvidence>();
  private verdicts = new Map<string, CryptoVerification>();

  constructor(rail: CheckoutRail) {
    this.rail = rail;
  }

  /** Script the session evidence a later retrieve returns. */
  setCardSessionEvidence(sessionId: string, evidence: CardSessionEvidence): void {
    this.sessions.set(sessionId, evidence);
  }

  /** Script the verdict a later verification of this exact proof returns. */
  setCryptoVerdict(paymentProof: string, verdict: CryptoVerification): void {
    this.verdicts.set(paymentProof, verdict);
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutCreation> {
    if (!Number.isFinite(input.priceUSD) || input.priceUSD <= 0) {
      throw new Error("Refusing to mint a checkout without a positive per-run price.");
    }
    if (this.rail === "stripe") {
      const sessionId = `mem_cs_${input.runRequestId}`;
      return {
        rail: "stripe",
        checkoutId: sessionId,
        checkoutUrl: `https://checkout.example.invalid/session/${sessionId}`,
      };
    }
    const challenge: CheckoutChallenge = {
      version: "1.0",
      network: "base-sepolia",
      recipient: "0x0000000000000000000000000000000000000000",
      amountUSD: input.priceUSD,
      currency: "USDC",
      facilitator: "https://facilitator.example.invalid",
      resource: `screener-run:${input.runRequestId}`,
      nonce: `n_mem_${input.runRequestId}`,
      expiresAtMs: Date.now() + 15 * 60 * 1000,
    };
    return { rail: "x402", checkoutId: input.runRequestId, challenge };
  }

  async retrieveCardSession(input: { sessionId: string }): Promise<CardSessionEvidence> {
    if (this.rail !== "stripe") {
      throw new Error("InMemoryCheckoutAdapter (x402) cannot retrieve Stripe sessions: use the card adapter.");
    }
    const evidence = this.sessions.get(input.sessionId);
    if (!evidence) throw new Error(`No scripted session evidence for ${input.sessionId}.`);
    return evidence;
  }

  async verifyCryptoPayment(input: { paymentProof: string; expectedAmountUSD: number }): Promise<CryptoVerification> {
    if (this.rail !== "x402") {
      throw new Error("InMemoryCheckoutAdapter (stripe) cannot verify x402 payments: use the x402 adapter.");
    }
    if (!Number.isFinite(input.expectedAmountUSD) || input.expectedAmountUSD <= 0) {
      return { verified: false, payer: null, nonce: null };
    }
    return this.verdicts.get(input.paymentProof) ?? { verified: false, payer: null, nonce: null };
  }
}
