/**
 * Issue #896: unit pins for the ledger <-> BudgetGuard translation in
 * src/payments/ledger.ts — the reconciliation contract between
 * mas_transactions (ledger of record) and BudgetGuard state.
 */
import { describe, it, expect } from "vitest";
import {
  buildLedgerTransaction,
  deriveBudgetGuardState,
  findPaymentsAgentRowByKey,
  paymentsAgentSessionId,
  toPaymentRecord,
} from "../src/payments/ledger";
import type { TransactionRecord } from "../src/types";

const TODAY = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 86400000).toISOString();

function row(partial: Partial<TransactionRecord>): TransactionRecord {
  return {
    id: "pay_x",
    sessionId: "default_trader",
    action: "micropayment",
    amount: 1,
    currency: "USD",
    customer: "someone",
    gateway: "x402",
    gatewayRef: "ref",
    status: "completed",
    checkoutUrl: "",
    proposerDid: "did:key:payments",
    proofSignature: "sig",
    note: "op",
    createdAt: now,
    updatedAt: now,
    ...partial,
  } as TransactionRecord;
}

describe("deriveBudgetGuardState (#896)", () => {
  it("counts PaymentsAgent-origin spend per agent and collects its keys", () => {
    const rows = [
      row({ sessionId: paymentsAgentSessionId("a1"), amount: 2.5, gatewayRef: "k1" }),
      row({ sessionId: paymentsAgentSessionId("a1"), amount: 1.0, gatewayRef: "k2" }),
      row({ sessionId: paymentsAgentSessionId("a2"), amount: 9.0, gatewayRef: "k3" }),
    ];
    const state = deriveBudgetGuardState(rows, "a1", TODAY);
    expect(state.dailySpend).toEqual([["a1", TODAY, 350]]);
    expect(state.seenKeys.sort()).toEqual(["k1", "k2"]);
  });

  it("attributes agentic outbound spend to the orchestrator identity only", () => {
    const rows = [row({ amount: 45, gatewayRef: "0xtx" })]; // agentic micropayment
    expect(deriveBudgetGuardState(rows, "orchestrator", TODAY).dailySpend).toEqual([
      ["orchestrator", TODAY, 4500],
    ]);
    expect(deriveBudgetGuardState(rows, "a1", TODAY).dailySpend).toEqual([]);
    // Agentic gateway refs are tx hashes, not guard idempotency keys.
    expect(deriveBudgetGuardState(rows, "orchestrator", TODAY).seenKeys).toEqual([]);
  });

  it("ignores inbound earnings, simulated rows, and non-completed rows", () => {
    const rows = [
      row({ action: "agentic_payment", amount: 10 }),
      row({ status: "simulated", amount: 10 }),
      row({ status: "failed", amount: 10, sessionId: paymentsAgentSessionId("a1"), gatewayRef: "kf" }),
      row({ status: "awaiting_confirmation", amount: 10 }),
    ];
    const state = deriveBudgetGuardState(rows, null, TODAY);
    expect(state.dailySpend).toEqual([]);
    expect(state.seenKeys).toEqual([]);
  });

  it("yesterday's PaymentsAgent keys still block replays but do not count as today's spend", () => {
    const rows = [
      row({ sessionId: paymentsAgentSessionId("a1"), amount: 5, gatewayRef: "old-key", createdAt: yesterday }),
    ];
    const state = deriveBudgetGuardState(rows, "a1", TODAY);
    expect(state.dailySpend).toEqual([]);
    expect(state.seenKeys).toEqual(["old-key"]);
  });

  it("cross-agent view (agentId null) includes every agent plus orchestrator agentic spend", () => {
    const rows = [
      row({ sessionId: paymentsAgentSessionId("a1"), amount: 1, gatewayRef: "k1" }),
      row({ amount: 2, gatewayRef: "0xtx" }),
    ];
    const state = deriveBudgetGuardState(rows, null, TODAY);
    expect(state.dailySpend.sort()).toEqual([
      ["a1", TODAY, 100],
      ["orchestrator", TODAY, 200],
    ]);
    expect(state.seenKeys).toEqual(["k1"]);
  });
});

describe("ledger record mapping (#896)", () => {
  it("buildLedgerTransaction stamps the PaymentsAgent provenance and USD amount", () => {
    const tx = buildLedgerTransaction(
      { agentId: "a1", operation: "search.query", amountCents: 250, idempotencyKey: "key-1", payer: "0xpayer", proofSignature: "0xsig" },
      "did:key:payments"
    );
    expect(tx.sessionId).toBe("payments-agent:a1");
    expect(tx.amount).toBe(2.5);
    expect(tx.gateway).toBe("x402");
    expect(tx.gatewayRef).toBe("key-1");
    expect(tx.status).toBe("completed");
    expect(tx.authorizerDid).toBe("did:key:0xpayer");
    expect(tx.note).toBe("search.query");
  });

  it("toPaymentRecord round-trips a built transaction", () => {
    const tx = buildLedgerTransaction(
      { agentId: "a1", operation: "payments.draft", amountCents: 333, idempotencyKey: "key-2" },
      "did:key:payments"
    );
    const rec = toPaymentRecord(tx);
    expect(rec).toMatchObject({
      agentId: "a1",
      operation: "payments.draft",
      amountCents: 333,
      idempotencyKey: "key-2",
      status: "verified",
    });
  });

  it("findPaymentsAgentRowByKey only matches PaymentsAgent-origin rows", () => {
    const agentic = row({ gatewayRef: "same" });
    const own = row({ sessionId: paymentsAgentSessionId("a1"), gatewayRef: "same" });
    expect(findPaymentsAgentRowByKey([agentic], "same")).toBeUndefined();
    expect(findPaymentsAgentRowByKey([agentic, own], "same")).toBe(own);
  });
});
