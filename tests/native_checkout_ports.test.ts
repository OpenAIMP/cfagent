// @vitest-environment node
/**
 * Issue #2193 (slice 1, #2146) — checkout port conformance suite
 * + structural pins.
 *
 * The conformance suite runs UNCHANGED against every adapter: the
 * Stripe adapter (fake checkout client, no network), the x402
 * adapter (stubbed facilitator fetch, no network), and the
 * in-memory adapter (both rails). A behavior that passes on one
 * adapter and fails on another is a port defect, not an
 * application bug.
 *
 * Structural pins (ADR 0002 R1, standards §7.1, ADR 0004):
 * - the port module imports no Stripe/x402 client;
 * - domain modules (native gate, flow) import no gateway SDK;
 * - the gate reads no env.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckoutPort } from "../src/services/checkoutPorts";
import { StripeCheckoutAdapter, type StripeCheckoutClient } from "../src/services/stripeCheckoutAdapter";
import { X402CheckoutAdapter } from "../src/services/x402CheckoutAdapter";
import { InMemoryCheckoutAdapter } from "../src/services/inMemoryCheckoutAdapter";
import { createCheckoutPorts } from "../src/services/createCheckoutPorts";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";

function fakeStripeClient(): StripeCheckoutClient & { creates: Array<{ draftId: string; amount: number }> } {
  const creates: Array<{ draftId: string; amount: number }> = [];
  return {
    creates,
    async createCheckout(params) {
      creates.push({ draftId: params.draftId, amount: params.amount });
      return { success: true, checkoutUrl: `https://checkout.example/session/${params.draftId}`, gatewayRef: `cs_test_${params.draftId}` };
    },
    async retrieveSession(sessionId) {
      return {
        id: sessionId,
        status: "complete",
        payment_status: "paid",
        amount_total: 10,
        client_reference_id: sessionId.replace("cs_test_", ""),
        payment_intent: `pi_test_${sessionId.replace("cs_test_", "")}`,
      };
    },
  };
}

function stubFetch(opts: { isValid: boolean; capture?: Array<{ url: string; body: unknown }> }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = (async (url: string, init?: { body?: unknown }) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    opts.capture?.push({ url, body });
    return { ok: true, json: async () => ({ isValid: opts.isValid }) };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** Shared port contract, run against every adapter. */
async function runPortConformance(port: CheckoutPort, rail: "stripe" | "x402") {
  const creation = await port.createCheckout({
    runRequestId: "run-1",
    family: "goal",
    priceUSD: 0.1,
    email: "u1@example.com",
    userId: "u1",
  });
  expect(creation.rail).toBe(rail);
  expect(creation.checkoutId).toBeTruthy();
  if (rail === "stripe") {
    expect(creation.checkoutUrl).toBeTruthy();
    // Foreign-rail method must throw loudly, never answer.
    await expect(port.verifyCryptoPayment({ paymentProof: "x", expectedAmountUSD: 0.1 })).rejects.toThrow();
  } else {
    expect(creation.challenge).toBeTruthy();
    expect(creation.challenge!.recipient).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(creation.challenge!.amountUSD).toBe(0.1);
    expect(creation.challenge!.resource).toBe("screener-run:run-1");
    expect(creation.challenge!.nonce).toBeTruthy();
    await expect(port.retrieveCardSession({ sessionId: "cs_x" })).rejects.toThrow();
  }
}

describe("checkout port conformance (all adapters)", () => {
  it("stripe adapter (fake client) satisfies the port", async () => {
    await runPortConformance(new StripeCheckoutAdapter(fakeStripeClient()), "stripe");
  });

  it("x402 adapter (stubbed facilitator) satisfies the port and mints the configured recipient", async () => {
    const { fn } = stubFetch({ isValid: true });
    const adapter = new X402CheckoutAdapter({ recipientAddress: RECIPIENT, network: "base-sepolia", fetchFn: fn });
    await runPortConformance(adapter, "x402");
    const creation = await adapter.createCheckout({
      runRequestId: "run-9",
      family: "stock",
      priceUSD: 0.02,
      email: "u1@example.com",
      userId: "u1",
    });
    expect(creation.challenge!.recipient).toBe(RECIPIENT);
  });

  it("in-memory adapter satisfies the port on both rails", async () => {
    await runPortConformance(new InMemoryCheckoutAdapter("stripe"), "stripe");
    await runPortConformance(new InMemoryCheckoutAdapter("x402"), "x402");
  });

  it("stripe adapter maps a retrieved session to port evidence", async () => {
    const adapter = new StripeCheckoutAdapter(fakeStripeClient());
    const evidence = await adapter.retrieveCardSession({ sessionId: "cs_test_run-1" });
    expect(evidence).toEqual({
      sessionId: "cs_test_run-1",
      status: "complete",
      paymentStatus: "paid",
      amountTotalCents: 10,
      clientReferenceId: "run-1",
      paymentIntentId: "pi_test_run-1",
    });
  });

  it("x402 adapter verifies only on facilitator isValid=true, and sends amount+recipient requirements", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    const { fn } = stubFetch({ isValid: true, capture: captured });
    const adapter = new X402CheckoutAdapter({ recipientAddress: RECIPIENT, network: "base-sepolia", fetchFn: fn });
    const proof = Buffer.from(JSON.stringify({ signature: "0xsig", payer: PAYER, nonce: "n_1" })).toString("base64");
    const verdict = await adapter.verifyCryptoPayment({ paymentProof: proof, expectedAmountUSD: 0.1 });
    expect(verdict).toEqual({ verified: true, payer: PAYER, nonce: "n_1" });
    expect(captured).toHaveLength(1);
    const req = captured[0].body as { paymentRequirements: { amount: string; payTo: string; network: string } };
    // goal $0.10 at 6 USDC decimals = 100000 atomic.
    expect(req.paymentRequirements.amount).toBe("100000");
    expect(req.paymentRequirements.payTo).toBe(RECIPIENT);
    expect(req.paymentRequirements.network).toBe("base-sepolia");
  });

  it("x402 adapter fails closed: facilitator rejection, simulated proof, malformed proof, transport error", async () => {
    const denied = stubFetch({ isValid: false });
    const adapter = new X402CheckoutAdapter({ recipientAddress: RECIPIENT, fetchFn: denied.fn });
    const good = Buffer.from(JSON.stringify({ signature: "0xsig", payer: PAYER, nonce: "n_1" })).toString("base64");
    expect((await adapter.verifyCryptoPayment({ paymentProof: good, expectedAmountUSD: 0.1 })).verified).toBe(false);

    const calls: unknown[] = [];
    const counting = (async (url: string, init?: { body?: unknown }) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ isValid: true }) };
    }) as unknown as typeof fetch;
    const simAdapter = new X402CheckoutAdapter({ recipientAddress: RECIPIENT, fetchFn: counting });
    const simulated = Buffer.from(JSON.stringify({ signature: "0xsig", payer: PAYER, nonce: "n_1", simulated: true })).toString("base64");
    expect((await simAdapter.verifyCryptoPayment({ paymentProof: simulated, expectedAmountUSD: 0.1 })).verified).toBe(false);
    // Simulated proofs are rejected BEFORE any network call.
    expect(calls).toHaveLength(0);
    expect((await simAdapter.verifyCryptoPayment({ paymentProof: "not-json{{", expectedAmountUSD: 0.1 })).verified).toBe(false);
    expect((await simAdapter.verifyCryptoPayment({ paymentProof: "", expectedAmountUSD: 0.1 })).verified).toBe(false);

    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const downAdapter = new X402CheckoutAdapter({ recipientAddress: RECIPIENT, fetchFn: throwing });
    expect((await downAdapter.verifyCryptoPayment({ paymentProof: good, expectedAmountUSD: 0.1 })).verified).toBe(false);
  });

  it("x402 adapter construction throws without an explicit valid recipient (no hardcoded fallback)", () => {
    expect(() => new X402CheckoutAdapter({ recipientAddress: "" })).toThrow(/explicitly configured/);
    expect(() => new X402CheckoutAdapter({ recipientAddress: "not-an-address" })).toThrow(/explicitly configured/);
    expect(() => new X402CheckoutAdapter({ recipientAddress: RECIPIENT, network: "nope" })).toThrow(/unknown network/);
  });
});

describe("createCheckoutPorts composition root", () => {
  it("returns null when nothing is configured", () => {
    expect(createCheckoutPorts({})).toBeNull();
  });

  it("returns an x402-only bundle for an explicit recipient, and null for an invalid one", () => {
    const ports = createCheckoutPorts({ X402_RECIPIENT_ADDRESS: RECIPIENT, X402_NETWORK: "base-sepolia" });
    expect(ports).not.toBeNull();
    expect(ports!.x402?.rail).toBe("x402");
    expect(ports!.card).toBeNull();
    expect(createCheckoutPorts({ X402_RECIPIENT_ADDRESS: "bogus" })).toBeNull();
  });

  it("returns a card port for a direct REST Stripe key (MCP-only env does not configure card)", () => {
    const withKey = createCheckoutPorts({ STRIPE_SECRET_KEY: "sk_test_fake" });
    expect(withKey).not.toBeNull();
    expect(withKey!.card?.rail).toBe("stripe");
    expect(createCheckoutPorts({ STRIPE_MCP_SERVER_URL: "https://mcp.example.invalid" })).toBeNull();
  });
});

describe("structural pins (ADR 0002 R1)", () => {
  function importLines(rel: string): string[] {
    const src = readFileSync(resolve(__dirname, `../${rel}`), "utf-8");
    return src.split("\n").filter((line) => /^\s*import[\s{]/.test(line));
  }

  it("port module imports no Stripe/x402 client and no store client", () => {
    const lines = importLines("src/services/checkoutPorts.ts");
    for (const line of lines) {
      expect(line).not.toMatch(/stripe|paymentStrategies|agenticPayments|x402Verifier|services\/payments/);
    }
    expect(lines.join("\n")).not.toMatch(/from\s+["']\.\.\/data\/d1|drizzle/);
  });

  it("domain modules import no gateway SDK and read no env", () => {
    for (const rel of ["src/services/nativeMonetization.ts", "src/workflows/paymentWorkflowFlow.ts"]) {
      const lines = importLines(rel);
      for (const line of lines) {
        expect(line).not.toMatch(/paymentStrategies|agenticPayments|x402Verifier|services\/payments|stripeCheckoutAdapter|x402CheckoutAdapter|createCheckoutPorts/);
      }
      const src = readFileSync(resolve(__dirname, `../${rel}`), "utf-8");
      expect(src).not.toMatch(/process\.env|env\.AGENT_DB/);
    }
  });
});
