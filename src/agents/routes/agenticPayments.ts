/**
 * Issue #359-17: Cloudflare Agentic Payments routes (x402 & MPP) extracted
 * from OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure
 * move - no behavior change. Slice #359-07 deliberately left this block
 * inline; this FINAL slice of the #359 orchestrator breakup extracts it,
 * leaving routeRequest a thin ordered dispatcher over
 * src/agents/routes/.
 *
 * Owns the agentic-payments block (invoked at the EXACT original position
 * in routeRequest's sequential matching sequence, between the payments
 * delegation and the premium delegation):
 *   GET      /payments/agentic/wallet             (wallet status & metrics)
 *   GET|POST /payments/agentic/auto-approve-limit (HITL threshold)
 *   POST     /payments/agentic/ledger/record      (issue #896: PaymentsAgent
 *                                                  write-through to the ledger
 *                                                  of record, mas_transactions)
 *   GET      /payments/agentic/ledger/budget-state (issue #896: BudgetGuard
 *                                                  state derived from the ledger)
 *   GET      /payments/agentic/ledger/payments    (issue #896: PaymentsAgent-
 *                                                  origin rows read back)
 *
 * Each route constructs the ETradeAgenticPaymentService per request,
 * exactly as the inline block did. The handler ends with an explicit
 * `return null` - never undefined (a non-GET/POST method on the
 * auto-approve-limit path still falls through, as before).
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * AgenticPaymentsRouteContext parameter; there are no new globals and no
 * back-references into the class. The limit-update audit event stays
 * funneled through the single-owner audit() via the context.
 */

import { ETradeAgenticPaymentService } from "../../services/agenticPayments";
import {
  buildLedgerTransaction,
  deriveBudgetGuardState,
  findPaymentsAgentRowByKey,
  isPaymentsAgentRow,
  toPaymentRecord,
} from "../../payments/ledger";
import { AGENT_DIDS } from "../did";
import type { DatabaseORM } from "../../orm";
import type { AgentName, Env } from "../../types";

/** The subset of OrchestratorAgent surface the agentic-payments handlers need. */
export interface AgenticPaymentsRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent.getOrm - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Audit funnel (owner: OrchestratorAgent.audit - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
}

/**
 * Handles the Cloudflare Agentic Payments routes. Returns a Response on
 * match, null when neither agentic path matches (the orchestrator then
 * continues its sequential matching).
 */
export async function handleAgenticPaymentsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: AgenticPaymentsRouteContext
): Promise<Response | null> {
  // ==========================================
  // Cloudflare Agentic Payments (x402 & MPP)
  // ==========================================

  // Agentic Wallet Status & Micropayment Metrics
  if ((path.endsWith("/payments/agentic/wallet") || path.includes("/payments/agentic/wallet")) && request.method === "GET") {
    try {
      const paymentService = new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId);
      const status = await paymentService.getWalletStatus();
      return Response.json(status);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to fetch wallet status" }, { status: 500 });
    }
  }

  // Issue #896: PaymentsAgent ledger write-through. mas_transactions in
  // THIS instance's store is the single payment ledger of record; the
  // PaymentsAgent Durable Object no longer keeps its own blob ledger.
  // The duplicate check and the insert below are deliberately
  // synchronous with no await between them: this Durable Object is
  // single-threaded, so check+insert is atomic here — two concurrent
  // verified payments with distinct keys both persist, and a replayed
  // key can never slip a second row past the facilitator-await window
  // that broke the old read-modify-write blob ledger (#785).
  if (path.endsWith("/payments/agentic/ledger/record") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        agentId?: unknown;
        operation?: unknown;
        amountCents?: unknown;
        idempotencyKey?: unknown;
        payer?: unknown;
        proofSignature?: unknown;
        createdAt?: unknown;
      };
      const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
      const operation = typeof body.operation === "string" ? body.operation.trim() : "";
      const idempotencyKey =
        typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
      const amountCents = Number(body.amountCents);
      if (!agentId || !operation || !idempotencyKey || !Number.isFinite(amountCents) || amountCents <= 0) {
        return Response.json(
          { error: "agentId, operation, idempotencyKey and a positive amountCents are required" },
          { status: 400 }
        );
      }
      const orm = ctx.getOrm();
      const existing = findPaymentsAgentRowByKey(orm.transactions.findMany(), idempotencyKey);
      if (existing) {
        return Response.json({ duplicate: true, record: toPaymentRecord(existing) }, { status: 409 });
      }
      const tx = buildLedgerTransaction(
        {
          agentId,
          operation,
          amountCents: Math.floor(amountCents),
          idempotencyKey,
          payer: typeof body.payer === "string" ? body.payer : undefined,
          proofSignature: typeof body.proofSignature === "string" ? body.proofSignature : undefined,
          createdAt: typeof body.createdAt === "string" ? body.createdAt : undefined,
        },
        AGENT_DIDS.PAYMENTS
      );
      orm.transactions.create(tx);
      ctx.audit("payments_agent.recorded", "payments", {
        transactionId: tx.id,
        agentId,
        operation,
        amountCents: Math.floor(amountCents),
        idempotencyKey,
      });
      return Response.json({ duplicate: false, record: toPaymentRecord(tx) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record payment in ledger" }, { status: 500 });
    }
  }

  // Issue #896: BudgetGuard state, derived from the ledger of record on
  // every read — the guard has no second home to diverge into.
  if (path.endsWith("/payments/agentic/ledger/budget-state") && request.method === "GET") {
    try {
      const agentId = url.searchParams.get("agentId");
      const state = deriveBudgetGuardState(ctx.getOrm().transactions.findMany(), agentId);
      return Response.json({ agentId, state });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to derive budget state" }, { status: 500 });
    }
  }

  // Issue #896: PaymentsAgent-origin payments, read back from the ledger.
  if (path.endsWith("/payments/agentic/ledger/payments") && request.method === "GET") {
    try {
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 50;
      const payments = ctx
        .getOrm()
        .transactions.findMany()
        .filter(isPaymentsAgentRow)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit)
        .map(toPaymentRecord);
      return Response.json({ count: payments.length, payments });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list ledger payments" }, { status: 500 });
    }
  }

  // Agentic Auto-Approve Limit (HITL threshold)
  if (path.endsWith("/payments/agentic/auto-approve-limit") || path.includes("/payments/agentic/auto-approve-limit")) {
    const paymentService = new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId);
    if (request.method === "GET") {
      return Response.json({
        autoApproveLimitUSD: paymentService.getAutoApproveLimit(),
        network: ctx.env.X402_NETWORK || "base-sepolia",
      });
    }
    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const limit = Number(body.limitUSD !== undefined ? body.limitUSD : body.limit);
        if (isNaN(limit) || limit < 0) {
          return Response.json({ error: "Invalid limitUSD. Must be non-negative number." }, { status: 400 });
        }
        paymentService.setAutoApproveLimit(limit);
        ctx.audit("agentic_payment.limit_updated", "payments", { limitUSD: limit });
        return Response.json({ success: true, autoApproveLimitUSD: limit });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to update limit" }, { status: 500 });
      }
    }
  }

  return null;
}
