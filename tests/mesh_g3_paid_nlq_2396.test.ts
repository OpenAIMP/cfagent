/**
 * Agent Mesh S11 / G3 (issue #2396, programme #2225): the paid NLQ leg
 * stops recording simulated receipts.
 *
 * Before this slice, `paid_scan` / `paid_research` in the NLQ executor
 * ran the premium service for free and recorded a self-minted receipt
 * (status "simulated", #122) into the real payments ledger
 * (mas_transactions). The executor has no payment-proof channel — the
 * NLQ plan schema carries no proof field and the payment service holds
 * no signing key — so it cannot collect or verify a real x402 payment.
 * The verified rail is the premium HTTP endpoint the tier names
 * (402 → wallet pays → on-chain claim verification → verified receipt
 * recorded from the settlement, src/agents/routes/premium.ts).
 *
 * Pins here:
 *  - paid_scan / paid_research refuse honestly on the async executor:
 *    the premium service is not executed, no receipt is minted, zero
 *    ledger rows, zero payment events; the refusal names the premium
 *    endpoint where a verified payment happens.
 *  - the identity-missing refusal (#1185) still fires first.
 *  - the sync executor refuses paid actions explicitly instead of
 *    falling through to the conversation-history default.
 *  - already-recorded simulated rows stay in the ledger labelled
 *    "simulated" (no deletion, no rewrite) but no longer count toward
 *    wallet earned/spent totals or the derived balance; verified rows
 *    still count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stand-in for on-chain claim verification (same mock shape as the
// agentic-payments suites; the refusal path never reaches verification).
vi.mock("../src/services/x402Verifier", () => ({
  verifyOnChainClaim: vi.fn(async ({ proof }: any) => ({
    ok: true,
    payer: proof.payer,
    txHash: proof.txHash,
  })),
}));

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { executeNLQQuery, executeNLQQueryAsync } from "../src/agents/nlq";
import { ETradeAgenticPaymentService } from "../src/services/agenticPayments";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { NLQPlan } from "../src/agents/nlq/schema";
import type { Env } from "../src/types";

const mockEnv = {
  X402_NETWORK: "base-sepolia",
  X402_RECIPIENT_ADDRESS: "0xAgentWallet",
} as unknown as Env;

function paidPlan(action: "paid_scan" | "paid_research"): NLQPlan {
  return {
    domain: "agentic_payments",
    operation: "create",
    agenticPaymentsData: { action, symbol: "NVDA" },
    terms: "NVDA",
    role: "any",
    since: null,
    limit: 10,
  } as unknown as NLQPlan;
}

/** Chains fixture (same shape as the agentic-payments suites) so a
 *  regression that executes the scan would produce rows — the refusal
 *  pins below assert rows/count stay at zero. */
function seedChainsFixture() {
  const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const quoteTimestamp = Date.now();
  DynamicOptionsScreener.setTestChainsFixture({
    NVDA: {
      symbol: "NVDA",
      underlyingPrice: 100,
      selectedExpiry: {
        year: expiryDate.getUTCFullYear(),
        month: expiryDate.getUTCMonth() + 1,
        day: expiryDate.getUTCDate(),
      },
      pairs: [
        {
          call: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "CALL",
            strikePrice: 100,
            symbol: "NVDATESTC100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 500,
            openInterest: 1000,
            delta: 0.52,
            impliedVolatility: 0.38,
          },
        },
      ],
    },
  });
}

describe("Mesh G3 (#2396): paid NLQ leg refuses instead of recording simulated receipts", () => {
  let orm: DatabaseORM;

  beforeEach(() => {
    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("session_trader");
  });

  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("paid_scan (async) refuses: nothing executed, nothing recorded, refusal names the premium endpoint", async () => {
    seedChainsFixture();
    const result = await executeNLQQueryAsync(orm, "session_trader", paidPlan("paid_scan"), mockEnv, "session_trader");

    expect(result.domain).toBe("agentic_payments");
    expect(result.status).toBe("error");
    expect(result.count).toBe(0);
    expect(result.rows).toHaveLength(0);
    expect(result.summary).toContain("requires a verified x402 payment");
    expect(result.summary).toContain("nothing was executed and nothing was recorded");
    expect(result.summary).toContain("/api/premium/options-scan");
    expect(result.summary).not.toContain("SIMULATED");

    // The ledger must not gain a receipt of any status for this request.
    const txs = orm.transactions.findMany();
    expect(txs.filter((t) => t.gateway === "x402" || t.gateway === "mpp")).toHaveLength(0);
    const events = orm.events.findMany({ where: { type: "AGENTIC_PAYMENT_COLLECTED" } });
    expect(events).toHaveLength(0);
  });

  it("paid_research (async) refuses: nothing executed, nothing recorded, refusal names the premium endpoint", async () => {
    const result = await executeNLQQueryAsync(orm, "session_trader", paidPlan("paid_research"), mockEnv, "session_trader");

    expect(result.domain).toBe("agentic_payments");
    expect(result.status).toBe("error");
    expect(result.count).toBe(0);
    expect(result.rows).toHaveLength(0);
    expect(result.summary).toContain("requires a verified x402 payment");
    expect(result.summary).toContain("/api/premium/market-research");

    const txs = orm.transactions.findMany();
    expect(txs.filter((t) => t.gateway === "x402" || t.gateway === "mpp")).toHaveLength(0);
  });

  it("paid_scan without a verified payer identity still refuses on identity grounds first (#1185)", async () => {
    const result = await executeNLQQueryAsync(orm, "session_trader", paidPlan("paid_scan"), mockEnv, undefined);

    expect(result.status).toBe("error");
    expect(result.summary).toContain("a verified payer identity is required");
    expect(orm.transactions.findMany().filter((t) => t.gateway === "x402" || t.gateway === "mpp")).toHaveLength(0);
  });

  it("paid actions on the SYNC executor refuse explicitly instead of falling through to conversation history", () => {
    const result = executeNLQQuery(orm, "session_trader", paidPlan("paid_scan"), mockEnv);

    expect(result.domain).toBe("agentic_payments");
    expect(result.status).toBe("error");
    expect(result.summary).toContain("requires a verified x402 payment");
    expect(result.summary).toContain("/api/premium/options-scan");
    expect(orm.transactions.findMany().filter((t) => t.gateway === "x402" || t.gateway === "mpp")).toHaveLength(0);
  });

  it("already-recorded simulated rows stay labelled in the ledger but no longer count as wallet earnings/spend", async () => {
    const service = new ETradeAgenticPaymentService(orm, mockEnv, "session_trader");
    const base = {
      protocol: "x402" as const,
      resource: "/api/premium/options-scan",
      currency: "USDC",
      network: "base-sepolia",
      payer: "session_trader",
      recipient: "0xAgentWallet",
      timestamp: new Date().toISOString(),
    };

    // Historical rows as the retired leg recorded them.
    await service.recordPaymentTransaction(
      { ...base, receiptId: "rcpt_hist_sim_earn", amount: 0.05, status: "simulated", simulated: true },
      "inbound",
    );
    await service.recordPaymentTransaction(
      { ...base, receiptId: "rcpt_hist_sim_spend", amount: 0.03, status: "simulated", simulated: true },
      "outbound",
    );
    // A genuinely verified row (premium-route shape).
    await service.recordPaymentTransaction(
      { ...base, receiptId: "rcpt_verified_earn", amount: 0.05, status: "verified", txHash: "0x_hash_verified" },
      "inbound",
    );

    // The rows remain in the ledger, honestly labelled — nothing deleted.
    const rows = orm.transactions.findMany().filter((t) => t.gateway === "x402");
    expect(rows).toHaveLength(3);
    expect(rows.filter((t) => t.status === "simulated")).toHaveLength(2);

    // But simulated rows no longer present as earnings/spend.
    const wallet = service.getWalletStatusSync();
    expect(wallet.totalEarnedUSD).toBe(0.05);
    expect(wallet.totalSpentUSD).toBe(0);
    expect(wallet.transactionCount).toBe(1);
    expect(wallet.balanceUSD).toBe(50.05);
  });
});
