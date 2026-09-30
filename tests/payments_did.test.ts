import { describe, it, expect } from "vitest";
import { AGENT_DIDS, createDidAttestation, getUserDid, resolveAgentDidDocument } from "../src/agents/did";
import { PaymentGatewayService } from "../src/services/payments";
import type { Env } from "../src/types";

describe("Agent Decentralized Identifiers (DIDs) & Payments", () => {
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    SEARCH_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock_key",
  };

  it("exports known registered agent DIDs", () => {
    expect(AGENT_DIDS.ORCHESTRATOR).toBe("did:agent:openaimp:orchestrator");
    expect(AGENT_DIDS.JUDGE).toBe("did:agent:openaimp:judge");
    expect(AGENT_DIDS.PAYMENTS).toBe("did:agent:openaimp:payments");
    expect(AGENT_DIDS.NLQ).toBe("did:agent:openaimp:nlq");
  });

  it("formats user DID correctly", () => {
    const userDid = getUserDid("developer123");
    expect(userDid).toBe("did:user:github:developer123");
  });

  it("generates deterministic cryptographic proof attestation", async () => {
    const attestation = await createDidAttestation({
      proposerDid: AGENT_DIDS.PAYMENTS,
      action: "charge",
      draftId: "pay_unit_999",
      amount: 45.0,
      currency: "USD",
      customer: "Acme Corp",
      gateway: "stripe",
    });

    expect(attestation.proposerDid).toBe(AGENT_DIDS.PAYMENTS);
    expect(attestation.proofType).toBe("HmacSha256Verification2026");
    expect(attestation.signature).toBeDefined();
    expect(attestation.signature.length).toBe(64);
  });

  it("resolves valid W3C DID document for agent DIDs", () => {
    const didDoc = resolveAgentDidDocument(AGENT_DIDS.PAYMENTS);

    expect(didDoc.id).toBe(AGENT_DIDS.PAYMENTS);
    expect(didDoc.verificationMethod.length).toBeGreaterThan(0);
    expect(didDoc.authentication).toContain(`${AGENT_DIDS.PAYMENTS}#key-1`);
  });

  describe("PaymentGatewayService", () => {
    it("reports configured status for Stripe when API key is set", () => {
      const service = new PaymentGatewayService(mockEnv);
      const statuses = service.getGatewayStatuses();

      const stripe = statuses.find((s) => s.id === "stripe");
      expect(stripe).toBeDefined();
      expect(stripe?.configured).toBe(true);

      const paypal = statuses.find((s) => s.id === "paypal");
      expect(paypal).toBeDefined();
    });

    it("creates checkout session with cryptographic DID proof", async () => {
      const service = new PaymentGatewayService(mockEnv);
      const result = await service.createCheckout({
        draftId: "pay_test_service",
        amount: 25.0,
        currency: "USD",
        customer: "Acme Corp",
        gateway: "stripe",
        userLogin: "mubasher",
      });

      expect(result.draftId).toBe("pay_test_service");
      expect(result.checkoutUrl).toBeDefined();
      expect(result.didAttestation).toBeDefined();
      expect(result.didAttestation?.proposerDid).toBe(AGENT_DIDS.PAYMENTS);
      expect(result.didAttestation?.signature).toBeDefined();
    });
  });
});
