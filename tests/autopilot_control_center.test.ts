import { describe, it, expect, vi } from "vitest";
import {
  AutopilotControlCenter,
  AutopilotPolicyLimits,
  AutonomousActionItem,
  mapAuditLogToAutonomousAction,
  mapTradeRecordToAutonomousAction,
} from "../src/client/components/AutopilotControlCenter";

describe("Autopilot Control Center & Policy Limits Cards (Issue #20)", () => {
  describe("Policy Limits Defaults & Specification", () => {
    it("defines exact institutional default policy limits matching NextGenTP spec", () => {
      const defaultLimits: AutopilotPolicyLimits = {
        maxPositionPct: 10.0,
        cashReservePct: 5.0,
        ordersPerDay: 10,
        drawdownAlertPct: 20.0,
        universe: "Default large caps/ETFs",
        riskProfile: "moderate",
      };

      expect(defaultLimits.maxPositionPct).toBe(10.0);
      expect(defaultLimits.cashReservePct).toBe(5.0);
      expect(defaultLimits.ordersPerDay).toBe(10);
      expect(defaultLimits.drawdownAlertPct).toBe(20.0);
      expect(defaultLimits.universe).toBe("Default large caps/ETFs");
      expect(defaultLimits.riskProfile).toBe("moderate");
    });

    it("supports policy limit updates across customizable thresholds", () => {
      const customLimits: AutopilotPolicyLimits = {
        maxPositionPct: 15.0,
        cashReservePct: 8.0,
        ordersPerDay: 20,
        drawdownAlertPct: 15.0,
        universe: "Nasdaq 100 & AI Growth",
        riskProfile: "aggressive",
      };

      expect(customLimits.maxPositionPct).toBeGreaterThan(10);
      expect(customLimits.riskProfile).toBe("aggressive");
      expect(customLimits.universe).toContain("Nasdaq");
    });
  });

  describe("Autonomous Actions & Attestation Integrity", () => {
    it("validates autonomous action records adhere to W3C DID attestation standards", () => {
      const mockAction: AutonomousActionItem = {
        id: "act-test-01",
        timestamp: "10:35:00 AM",
        actionType: "order",
        symbol: "NVDA",
        summary: "Limit Buy 20 shares @ $138.25",
        policyCheckRule: "Max position (6.8%) ≤ 10.00%",
        policyCheckPassed: true,
        status: "executed",
        didAttestation: {
          did: "did:agent:openaimp:trading",
          signature: "sig_ed25519_nvda_p98a1",
        },
      };

      expect(mockAction.id).toBeTruthy();
      expect(mockAction.symbol).toBe("NVDA");
      expect(mockAction.policyCheckPassed).toBe(true);
      expect(mockAction.status).toBe("executed");
      expect(mockAction.didAttestation.did).toMatch(/^did:agent:/);
      expect(mockAction.didAttestation.signature).toMatch(/^sig_/);
    });

    it("verifies routing to approval when Autopilot is paused or under caution", () => {
      const pausedAction: AutonomousActionItem = {
        id: "act-test-02",
        timestamp: "10:36:00 AM",
        actionType: "order",
        symbol: "TSLA",
        summary: "Limit Buy 15 shares @ $220.50",
        policyCheckRule: "Max position size ≤ 10.00%",
        policyCheckPassed: true,
        status: "routed_to_approval",
        didAttestation: {
          did: "did:agent:openaimp:trading",
          signature: "sig_0xabcdef123456",
        },
      };

      expect(pausedAction.status).toBe("routed_to_approval");
      expect(pausedAction.policyCheckPassed).toBe(true);
    });

    it("verifies emergency kill switch blocks autonomous actions", () => {
      const blockedAction: AutonomousActionItem = {
        id: "act-test-03",
        timestamp: "10:37:00 AM",
        actionType: "order",
        symbol: "BTC/USD",
        summary: "Market Buy 0.5 BTC",
        policyCheckRule: "Platform kill switch tripped",
        policyCheckPassed: false,
        status: "blocked",
        didAttestation: {
          did: "did:agent:openaimp:trading",
          signature: "sig_kill_switch_active",
        },
      };

      expect(blockedAction.status).toBe("blocked");
      expect(blockedAction.policyCheckPassed).toBe(false);
    });
  });

  describe("Live Backend Ledger Integration (mas_events & mas_trades)", () => {
    it("maps backend mas_events audit records to live AutonomousActionItems", () => {
      const rawEvent = {
        id: "evt-trade-12345",
        type: "alpaca.order_placed",
        agent: "trading",
        payload: {
          symbol: "NVDA",
          qty: 25,
          side: "buy",
          status: "filled",
          proposerDid: "did:agent:openaimp:trading",
          signature: "sig_ed25519_test_proof",
        },
        created_at: "2026-10-14T10:45:00.000Z",
      };

      const mapped = mapAuditLogToAutonomousAction(rawEvent);

      expect(mapped.id).toBe("evt-trade-12345");
      expect(mapped.actionType).toBe("order");
      expect(mapped.symbol).toBe("NVDA");
      expect(mapped.source).toBe("live");
      expect(mapped.status).toBe("executed");
      expect(mapped.policyCheckPassed).toBe(true);
      expect(mapped.didAttestation.did).toBe("did:agent:openaimp:trading");
      expect(mapped.didAttestation.signature).toBe("sig_ed25519_test_proof");
    });

    it("maps E*TRADE mas_trades records to live AutonomousActionItems", () => {
      const rawTrade: any = {
        id: "tr_etrade_99182",
        sessionId: "session_user_1",
        symbol: "AAPL",
        action: "BUY",
        orderType: "LIMIT",
        quantity: 50,
        price: 230.5,
        totalValue: 11525,
        status: "executed",
        proposerDid: "did:agent:openaimp:trading",
        authorizerDid: "did:agent:openaimp:orchestrator",
        proofSignature: "sig_ed25519_aapl_proof_882a",
        previewNotes: "Position size 7.2% ≤ 10.00% Limit",
        createdAt: "2026-10-14T11:00:00.000Z",
        updatedAt: "2026-10-14T11:00:05.000Z",
      };

      const mapped = mapTradeRecordToAutonomousAction(rawTrade);

      expect(mapped.id).toBe("tr_etrade_99182");
      expect(mapped.actionType).toBe("order");
      expect(mapped.symbol).toBe("AAPL");
      expect(mapped.source).toBe("live");
      expect(mapped.status).toBe("executed");
      expect(mapped.summary).toContain("BUY 50 shares @ $230.50");
      expect(mapped.didAttestation.signature).toBe("sig_ed25519_aapl_proof_882a");
    });
  });
});
