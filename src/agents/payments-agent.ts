/**
 * PR #3 — x402 PaymentsAgent: ledger-owning Durable Object.
 *
 * Owns the payment ledger (payments[]) and the BudgetGuard enforcement
 * state. All spending goes through processPaidRequest(), which:
 *   1. Validates via BudgetGuard (fail-closed; state persisted in DO storage
 *      so daily caps and idempotency survive restarts — issue #161)
 *   2. Verifies the payment via the x402 facilitator (fail-closed — issue #161)
 *   3. Records the payment in the ledger
 *
 * State is persisted via ctx.storage (Durable Object storage),
 * not via Agent state helpers.
 */

import { Agent } from "agents";
import type { Env } from "../types";
import { BudgetGuard, type BudgetGuardState } from "../payments/budget-guard";

export interface PaymentRecord {
  id: string;
  agentId: string;
  operation: string;
  amountCents: number;
  timestamp: string;
  idempotencyKey: string;
  status: "pending" | "verified" | "failed";
}

const GUARD_STORAGE_KEY = "budgetGuard";
const GUARD_ALLOWLIST = ["search.query", "payments.draft", "tasks.create", "memory.remember", "nlq.execute"];

export class PaymentsAgent extends Agent<Env> {
  private async getPayments(): Promise<PaymentRecord[]> {
    const stored = await this.ctx.storage.get<PaymentRecord[]>("payments");
    return stored ?? [];
  }

  private async savePayments(payments: PaymentRecord[]): Promise<void> {
    await this.ctx.storage.put("payments", payments);
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Load the BudgetGuard with enforcement state restored from DO storage. */
  private async getGuard(): Promise<BudgetGuard> {
    const state = await this.ctx.storage.get<BudgetGuardState>(GUARD_STORAGE_KEY);
    return BudgetGuard.restore({ allowlist: GUARD_ALLOWLIST }, state);
  }

  /** Persist the guard's enforcement state (spend + idempotency keys). */
  private async saveGuard(guard: BudgetGuard): Promise<void> {
    await this.ctx.storage.put(GUARD_STORAGE_KEY, guard.serialize());
  }

  /** Total spent today across all agents, in cents. */
  async todaySpent(): Promise<number> {
    const today = this.todayKey();
    const payments = await this.getPayments();
    return payments
      .filter((p: PaymentRecord) => p.timestamp.startsWith(today) && p.status === "verified")
      .reduce((sum: number, p: PaymentRecord) => sum + p.amountCents, 0);
  }

  /**
   * Budget check for a proposed operation. Used by ScheduledAgent
   * and Orchestrator before creating work. Fail-closed: any error
   * returns { allowed: false }. Pure: a check never records spend —
   * only processPaidRequest() records, after verification.
   */
  async budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const guard = await this.getGuard();
      return guard.check({
        agentId: req.agentId ?? "orchestrator",
        operation: req.operation,
        amountCents: req.amountCents,
        // Pre-flight checks are not payments: use an ephemeral key so a
        // mere check can never consume idempotency or budget.
        idempotencyKey: `check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
    } catch (err) {
      return {
        allowed: false,
        reason: `budget check error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Process a paid request: validate, verify via facilitator,
   * record in ledger. Fail-closed at every step.
   */
  async processPaidRequest(req: {
    agentId: string;
    operation: string;
    amountCents: number;
    idempotencyKey: string;
    paymentProof: string;
  }): Promise<PaymentRecord> {
    const guard = await this.getGuard();
    const paymentReq = {
      agentId: req.agentId,
      operation: req.operation,
      amountCents: req.amountCents,
      idempotencyKey: req.idempotencyKey,
    };

    const budget = guard.check(paymentReq);
    if (!budget.allowed) {
      throw new Error(`Budget denied: ${budget.reason}`);
    }

    const verified = await this.verifyWithFacilitator(req.paymentProof);
    if (!verified) {
      throw new Error("Payment verification failed: facilitator rejected");
    }

    // Only now — validated AND verified — record the spend.
    guard.record(paymentReq);
    await this.saveGuard(guard);

    const record: PaymentRecord = {
      id: `pay_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      agentId: req.agentId,
      operation: req.operation,
      amountCents: req.amountCents,
      timestamp: new Date().toISOString(),
      idempotencyKey: req.idempotencyKey,
      status: "verified",
    };
    const payments = await this.getPayments();
    payments.push(record);
    await this.savePayments(payments);
    return record;
  }

  /**
   * Verify a payment proof via the x402 facilitator. Fail-closed:
   * malformed proofs, simulated proofs, facilitator rejections, and any
   * transport error all return false.
   *
   * Issue #161: the previous implementation was `proof.length > 0` — any
   * non-empty string passed as "verified". Simulated proofs (issue #122)
   * are rejected before any network call, matching
   * AgenticPaymentsService.verifyPayment: a locally produced proof is not
   * a payment and must never be redeemable.
   */
  private async verifyWithFacilitator(proof: string): Promise<boolean> {
    try {
      if (!proof || typeof proof !== "string" || proof.length === 0 || proof.length > 100_000) {
        return false;
      }

      // Parse: base64-encoded JSON (PAYMENT-SIGNATURE header) or raw JSON.
      let parsed: any = null;
      let parsedOk = false;
      try {
        parsed = JSON.parse(atob(proof));
        parsedOk = true;
      } catch {
        try {
          parsed = JSON.parse(proof);
          parsedOk = true;
        } catch {
          return false;
        }
      }
      if (!parsedOk || !parsed || typeof parsed !== "object") return false;
      if (parsed.simulated === true) return false;
      if (typeof parsed.signature !== "string" || parsed.signature.length === 0) return false;
      if (typeof parsed.payer !== "string" || parsed.payer.length === 0) return false;

      // Real facilitator verification (x402 /verify). Any non-approval —
      // HTTP error, transport failure, malformed response — denies.
      const facilitatorUrl = (
        this.env.CF_WALLET_FACILITATOR ||
        this.env.X402_FACILITATOR_URL ||
        "https://x402.org/facilitator"
      ).replace(/\/+$/, "");
      const res = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x402Version: 1, paymentPayload: parsed }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { isValid?: boolean } | null;
      return data?.isValid === true;
    } catch {
      return false;
    }
  }

  /** List recent payments (for UX ledger view). */
  async listPayments(limit: number = 50): Promise<PaymentRecord[]> {
    const payments = await this.getPayments();
    return payments.slice(-limit).reverse();
  }
}
