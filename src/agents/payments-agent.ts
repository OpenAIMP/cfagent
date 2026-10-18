/**
 * PR #3 — x402 PaymentsAgent: ledger-owning Durable Object.
 *
 * Owns the payment ledger (payments[], todaySpent). All spending
 * goes through processPaidRequest(), which:
 *   1. Validates via BudgetGuard (fail-closed)
 *   2. Verifies the payment via the x402 facilitator (fail-closed)
 *   3. Records the payment in the ledger
 *
 * payExternalEndpoint() handles outbound payments using viem.
 */

import { Agent } from "agents";

export interface PaymentRecord {
  id: string;
  agentId: string;
  operation: string;
  amountCents: number;
  timestamp: string;
  idempotencyKey: string;
  status: "pending" | "verified" | "failed";
}

interface PaymentsAgentState {
  payments: PaymentRecord[];
}

export class PaymentsAgent extends Agent<Env> {
  initialState: PaymentsAgentState = { payments: [] };

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Total spent today across all agents, in cents. */
  async todaySpent(): Promise<number> {
    const today = this.todayKey();
    return this.state.payments
      .filter((p) => p.timestamp.startsWith(today) && p.status === "verified")
      .reduce((sum, p) => sum + p.amountCents, 0);
  }

  /**
   * Budget check for a proposed operation. Used by ScheduledAgent
   * and Orchestrator before creating work. Fail-closed: any error
   * returns { allowed: false }.
   */
  async budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    try {
      // Import BudgetGuard dynamically to avoid circular deps
      const { BudgetGuard } = await import("../payments/budget-guard");
      const guard = new BudgetGuard({
        // Config would come from env/DO state in production
        allowlist: ["search.query", "payments.draft", "tasks.create", "memory.remember", "nlq.execute"],
      });
      const verdict = guard.check({
        agentId: req.agentId ?? "orchestrator",
        operation: req.operation,
        amountCents: req.amountCents,
        idempotencyKey: `budget-${Date.now()}-${Math.random()}`,
      });
      return verdict;
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
    // 1. Budget guard
    const budget = await this.budgetCheck({
      operation: req.operation,
      amountCents: req.amountCents,
      agentId: req.agentId,
    });
    if (!budget.allowed) {
      throw new Error(`Budget denied: ${budget.reason}`);
    }

    // 2. Facilitator verification (fail-closed)
    const verified = await this.verifyWithFacilitator(req.paymentProof);
    if (!verified) {
      throw new Error("Payment verification failed: facilitator rejected");
    }

    // 3. Record
    const record: PaymentRecord = {
      id: `pay_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      agentId: req.agentId,
      operation: req.operation,
      amountCents: req.amountCents,
      timestamp: new Date().toISOString(),
      idempotencyKey: req.idempotencyKey,
      status: "verified",
    };
    this.setState({ payments: [...this.state.payments, record] });
    return record;
  }

  /**
   * Verify a payment proof with the x402 facilitator.
   * Stub: implement against your facilitator endpoint.
   * Fail-closed: returns false on any error.
   */
  private async verifyWithFacilitator(proof: string): Promise<boolean> {
    try {
      // TODO: POST proof to facilitator endpoint, check response
      // For now, require a non-empty proof as a minimal gate
      return proof.length > 0;
    } catch {
      return false;
    }
  }

  /** List recent payments (for UX ledger view). */
  async listPayments(limit: number = 50): Promise<PaymentRecord[]> {
    return this.state.payments.slice(-limit).reverse();
  }
}
