/**
 * x402 PaymentsAgent: budget enforcement + facilitator verification.
 *
 * Issue #896 (from the #785 audit): this Durable Object used to own a
 * SECOND payment ledger — one ctx.storage array (`payments`) plus a
 * serialized BudgetGuard blob (`budgetGuard`) — that no reader surface
 * could see and whose read-modify-write lost records under
 * concurrency. That blob ledger is retired as a system of record:
 *
 *   1. BudgetGuard state has a single home: it is DERIVED from
 *      mas_transactions (the ledger of record, owned by the
 *      OrchestratorAgent) on every check/record — see
 *      src/payments/ledger.ts for the attribution rules. Ledger spend
 *      (including agentic-payments micropayments) now moves the guard.
 *   2. processPaidRequest() validates via BudgetGuard (fail-closed),
 *      verifies via the x402 facilitator (fail-closed — issue #161),
 *      then records the payment INTO mas_transactions through the
 *      ledger owner's route. If the ledger cannot be reached it throws
 *      — a verified payment is never recorded into the void.
 *   3. Concurrency safety lives at the ledger owner: its duplicate
 *      check + insert are synchronous inside a single-threaded Durable
 *      Object, so concurrent calls cannot lose updates and a replayed
 *      idempotency key cannot slip past the facilitator await.
 *
 * Pre-existing blob data (the #785 audit found processPaidRequest had
 * no production caller, so the blob is expected empty) is migrated by
 * migrateLegacyLedger() — lossless and idempotent, and the blob keys
 * are deleted only after every record has landed in the ledger.
 */

import { PortThink } from "../actors/thinkAdapter";
import { BudgetGuard, type BudgetGuardState } from "../payments/budget-guard";
import {
  fetchLedgerBudgetState,
  listLedgerPayments,
  recordLedgerPayment,
  type PaymentRecord,
} from "../payments/ledger";

export type { PaymentRecord } from "../payments/ledger";

const GUARD_STORAGE_KEY = "budgetGuard";
const PAYMENTS_STORAGE_KEY = "payments";
const GUARD_ALLOWLIST = [
  "search.query",
  "payments.draft",
  "tasks.create",
  "memory.remember",
  "nlq.execute",
  "qa.run_sweep",
  "search.opportunity_hunt",
  "social.publish",
  "pipeline:social-daily",
];

export class PaymentsAgent extends PortThink {
  // Issue #1957 (think-fleet, tracker #1951, shape (a)): this class
  // is a non-chat, RPC-only actor — it drives no turns, has no chat
  // hooks, and registers no scheduler callbacks — so the migration is
  // the base class alone. PortThink (Think extends Agent) keeps the
  // Durable Object surface, this.env, and this.ctx.storage identical;
  // portHooks is deliberately left unset: there were no port hooks to
  // keep, and a turn driven against this class would have no hooks
  // to run. All domain methods below are unchanged.
  /**
   * Load the BudgetGuard with enforcement state derived from the
   * ledger of record (mas_transactions). Throws when the ledger owner
   * is unreachable — callers fail closed (budgetCheck) or loud
   * (processPaidRequest); the guard NEVER falls back to a stale local
   * copy, because there is no local copy anymore.
   */
  private async getGuard(agentId: string): Promise<BudgetGuard> {
    const state = await fetchLedgerBudgetState(this.env, agentId);
    return BudgetGuard.restore({ allowlist: GUARD_ALLOWLIST }, state);
  }

  /** Total spent today across all agents, in cents — from the ledger. */
  async todaySpent(): Promise<number> {
    const state = await fetchLedgerBudgetState(this.env);
    return state.dailySpend.reduce((sum, [, , cents]) => sum + cents, 0);
  }

  /**
   * Budget check for a proposed operation. Used by ScheduledAgent
   * and Orchestrator before creating work. Fail-closed: any error
   * (including an unreachable ledger) returns { allowed: false }.
   * Pure: a check never records spend — only processPaidRequest()
   * records, after verification.
   */
  async budgetCheck(req: {
    operation: string;
    amountCents: number;
    agentId?: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    try {
      const agentId = req.agentId ?? "orchestrator";
      const guard = await this.getGuard(agentId);
      return guard.check({
        agentId,
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
   * Process a paid request: validate against ledger-derived budget
   * state, verify via facilitator, record in mas_transactions.
   * Fail-closed at every step; fail-LOUD if the verified payment
   * cannot be recorded in the ledger of record.
   */
  async processPaidRequest(req: {
    agentId: string;
    operation: string;
    amountCents: number;
    idempotencyKey: string;
    paymentProof: string;
  }): Promise<PaymentRecord> {
    const guard = await this.getGuard(req.agentId);
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

    // Only now — validated AND verified — record the spend, in the
    // ledger of record. The record call is idempotent by idempotency
    // key at the (single-threaded) ledger owner: if a concurrent call
    // with the same key landed during the facilitator await, this is
    // a replay and is rejected as such, never double-recorded.
    const proof = parsePaymentProof(req.paymentProof);
    const { record, duplicate } = await recordLedgerPayment(this.env, {
      agentId: req.agentId,
      operation: req.operation,
      amountCents: req.amountCents,
      idempotencyKey: req.idempotencyKey,
      payer: proof?.payer,
      proofSignature: proof?.signature,
    });
    if (duplicate) {
      throw new Error("duplicate idempotency key");
    }
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

  /** List recent payments (for UX ledger view) — read from the ledger of record. */
  async listPayments(limit: number = 50): Promise<PaymentRecord[]> {
    return listLedgerPayments(this.env, limit);
  }

  /**
   * Issue #896: one-time, idempotent migration of any pre-existing
   * blob-ledger data into mas_transactions. Every verified blob
   * record is recorded through the same ledger path as live traffic
   * (idempotent by idempotency key, original timestamps preserved);
   * the blob keys are deleted ONLY after every record has landed.
   * BudgetGuard blob keys with no corresponding record (spend the old
   * read-modify-write race clobbered) cannot be reconstructed as
   * payments — they are REPORTED in `orphanedGuardKeys`, never
   * silently discarded. Throws (blob untouched) if the ledger is
   * unreachable.
   */
  async migrateLegacyLedger(): Promise<{
    found: number;
    migrated: number;
    duplicates: number;
    orphanedGuardKeys: string[];
  }> {
    const legacy =
      (await this.ctx.storage.get<PaymentRecord[]>(PAYMENTS_STORAGE_KEY)) ?? [];
    const guardState =
      await this.ctx.storage.get<BudgetGuardState>(GUARD_STORAGE_KEY);

    let migrated = 0;
    let duplicates = 0;
    const recordKeys = new Set<string>();
    for (const rec of legacy) {
      if (!rec || typeof rec.idempotencyKey !== "string" || rec.idempotencyKey.length === 0) {
        throw new Error(
          "legacy blob contains a payment record without an idempotency key; refusing to migrate or discard it"
        );
      }
      recordKeys.add(rec.idempotencyKey);
      if (rec.status !== "verified") continue;
      const { duplicate } = await recordLedgerPayment(this.env, {
        agentId: rec.agentId,
        operation: rec.operation,
        amountCents: rec.amountCents,
        idempotencyKey: rec.idempotencyKey,
        createdAt: rec.timestamp,
      });
      if (duplicate) duplicates++;
      else migrated++;
    }

    const orphanedGuardKeys = (guardState?.seenKeys ?? []).filter(
      (k) => !recordKeys.has(k)
    );

    // Every record has landed (or was already there): retire the blob.
    if (legacy.length > 0) await this.ctx.storage.delete(PAYMENTS_STORAGE_KEY);
    if (guardState) await this.ctx.storage.delete(GUARD_STORAGE_KEY);

    return { found: legacy.length, migrated, duplicates, orphanedGuardKeys };
  }
}

/** Best-effort parse of a payment proof for ledger provenance fields. */
function parsePaymentProof(proof: string): { payer?: string; signature?: string } | null {
  try {
    let parsed: any;
    try {
      parsed = JSON.parse(atob(proof));
    } catch {
      parsed = JSON.parse(proof);
    }
    if (!parsed || typeof parsed !== "object") return null;
    return {
      payer: typeof parsed.payer === "string" ? parsed.payer : undefined,
      signature: typeof parsed.signature === "string" ? parsed.signature : undefined,
    };
  } catch {
    return null;
  }
}
