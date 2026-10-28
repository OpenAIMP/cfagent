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
 *   POST     /payments/agentic/ledger/record-cfpay (issue #2019: cfpay
 *                                                  write-through — charge and
 *                                                  one-time credit rows, session
 *                                                  screener-payment:<runId>)
 *   GET      /payments/agentic/ledger/cfpay       (issue #2019: cfpay-origin
 *                                                  rows for one run, for
 *                                                  reconciliation)
 *   GET      /payments/agentic/ledger/cfpay-revenue (issue #2022: cfpay
 *                                                  revenue report — ledger
 *                                                  totals, audit-joined
 *                                                  family/coverage
 *                                                  attribution)
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
  aggregateCfpayRevenue,
  buildCfpayChargeTransaction,
  buildCfpayCreditTransaction,
  cfpayLedgerSessionId,
  isCfpayLedgerRow,
} from "../../services/cfpayLedger";
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
import {
  paymentsConfigErrorEvent,
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsScopedModes,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";

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
  /**
   * #1728: optional session/user carriers for the wallet switch
   * (run comes from the per-request `mode` / `?mode=`, global env
   * from `env`). Populated by the execution-context owner; unset
   * carriers fall through to env. See
   * src/config/agenticPaymentsModes.ts.
   */
  scopedPaymentsModes?: PaymentsScopedModes;
}

/**
 * #1728: resolves the wallet switch for a route in run > session >
 * user > env > builtin order. An invalid winning value fails closed
 * to the route legacy and is logged + audited as payment.config_error
 * (agent "payments").
 */
function resolveAgenticRouteMode(
  ctx: AgenticPaymentsRouteContext,
  key: keyof PaymentsModeValues,
  run: unknown,
  legacy: PaymentsSurfaceMode
): PaymentsSurfaceMode {
  const envRecord = ctx.env as unknown as Record<string, unknown> | undefined;
  const { resolved, switchName } = resolvePaymentsSwitchByKey(
    ctx.scopedPaymentsModes,
    key,
    run,
    envRecord?.[AGENTIC_ROUTE_SWITCH_NAMES[key]],
    legacy
  );
  if (resolved.invalid) {
    console.error(
      `[payments] invalid ${switchName} value ${JSON.stringify(resolved.raw)} — failing closed to "${legacy}"`
    );
    ctx.audit(paymentsConfigErrorEvent(), "payments", {
      setting: switchName,
      value: resolved.raw ?? "",
      resolved: legacy,
    });
  }
  return resolved.mode;
}

/** Env var name per switch key (for the env level lookup above). */
const AGENTIC_ROUTE_SWITCH_NAMES: Record<keyof PaymentsModeValues, string> = {
  create: "PAYMENTS_CREATE_MODE",
  confirm: "PAYMENTS_CONFIRM_MODE",
  transactions: "PAYMENTS_TRANSACTIONS_MODE",
  wallet: "AGENTIC_WALLET_MODE",
  screener: "PREMIUM_SCREENER_MODE",
  research: "PREMIUM_RESEARCH_MODE",
};

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
      // #1728: mode "mcp" adopts the MCP status shape
      // ({success: true, ...status}); mode "rest" (legacy) keeps
      // the raw status.
      const walletMode = resolveAgenticRouteMode(ctx, "wallet", url.searchParams.get("mode"), "rest");
      const paymentService = new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId);
      const status = await paymentService.getWalletStatus();
      return Response.json(walletMode === "mcp" ? { success: true, ...status } : status);
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

  // Issue #2019: cfpay ledger write-through. mas_transactions in THIS
  // instance's store is the single payment ledger of record; the
  // PaymentWorkflow (via the SEARCH_AGENT channel) records cfpay
  // charge and credit rows here. Deliberately separate from the #896
  // record endpoint: that endpoint builds PaymentsAgent-origin x402
  // rows only, and reusing it for cfpay would mislabel gateway and
  // session. Dedupe mirrors #896 and is atomic for the same reason
  // (this Durable Object is single-threaded): one charge row and one
  // credit row per run — a replayed write returns 409 with the
  // existing row instead of a second row.
  if (path.endsWith("/payments/agentic/ledger/record-cfpay") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        kind?: unknown;
        runRequestId?: unknown;
        userId?: unknown;
        family?: unknown;
        priceUSD?: unknown;
        checkoutId?: unknown;
        claimTxHash?: unknown;
        paymentIntentId?: unknown;
      };
      const kind = body.kind === "credit" ? "credit" : body.kind === "charge" ? "charge" : "";
      const runRequestId = typeof body.runRequestId === "string" ? body.runRequestId.trim() : "";
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const family = typeof body.family === "string" ? body.family.trim() : "";
      const priceUSD = Number(body.priceUSD);
      if (!kind || !runRequestId || !userId || !family || !Number.isFinite(priceUSD) || priceUSD <= 0) {
        return Response.json(
          { error: "kind (charge|credit), runRequestId, userId, family and a positive priceUSD are required" },
          { status: 400 },
        );
      }
      const orm = ctx.getOrm();
      const sessionId = cfpayLedgerSessionId(runRequestId);
      const existing = orm
        .transactions.findMany()
        .find((t) => t.sessionId === sessionId && t.action === kind);
      if (existing) {
        return Response.json({ duplicate: true, record: existing }, { status: 409 });
      }
      const tx =
        kind === "charge"
          ? buildCfpayChargeTransaction({
              runRequestId,
              userId,
              family,
              priceUSD,
              checkoutId: typeof body.checkoutId === "string" ? body.checkoutId : undefined,
              claimTxHash: typeof body.claimTxHash === "string" ? body.claimTxHash : undefined,
              paymentIntentId:
                typeof body.paymentIntentId === "string" ? body.paymentIntentId : undefined,
            })
          : buildCfpayCreditTransaction({ runRequestId, userId, family, priceUSD });
      orm.transactions.create(tx);
      ctx.audit("payments_cfpay.recorded", "payments", {
        transactionId: tx.id,
        runRequestId,
        kind,
        priceUSD,
      });
      return Response.json({ duplicate: false, record: tx });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to record cfpay payment in ledger" }, { status: 500 });
    }
  }

  // Issue #2019: cfpay-origin rows for one run, read back for
  // reconciliation (cfpay checkout.status vs mas_transactions on
  // run-request id + checkout id + tx hash / payment intent id).
  if (path.endsWith("/payments/agentic/ledger/cfpay") && request.method === "GET") {
    try {
      const runRequestId = (url.searchParams.get("runRequestId") ?? "").trim();
      if (!runRequestId) {
        return Response.json({ error: "runRequestId is required" }, { status: 400 });
      }
      const sessionId = cfpayLedgerSessionId(runRequestId);
      const rows = ctx
        .getOrm()
        .transactions.findMany()
        .filter((t) => t.sessionId === sessionId);
      return Response.json({ runRequestId, count: rows.length, rows });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list cfpay ledger rows" }, { status: 500 });
    }
  }

  // Issue #2022: cfpay revenue report. Money is authoritative from
  // the mas_transactions charge/credit rows; family and coverage
  // attribution come from the mas_events payment payloads joined on
  // run id, with explicit "unknown" buckets where an audit row is
  // missing (audit writes are best-effort, so attribution can lag
  // the ledger — totals never do). Cost-per-run is NOT reported
  // here: no per-run cost accounting exists yet to report against.
  if (path.endsWith("/payments/agentic/ledger/cfpay-revenue") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const cfpayRows = orm.transactions.findMany().filter(isCfpayLedgerRow);
      const charges = cfpayRows.filter((t) => t.action === "charge");
      const credits = cfpayRows.filter((t) => t.action === "credit");
      const payloadsOf = (type: string): Array<Record<string, unknown>> =>
        orm.events.findMany({ where: { type } }).map((e) => {
          const raw = (e as { payload?: unknown }).payload;
          if (raw && typeof raw === "object") return raw as Record<string, unknown>;
          try {
            return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
          } catch {
            return {};
          }
        });
      const report = aggregateCfpayRevenue(
        charges,
        credits,
        payloadsOf("payment.confirmed"),
        payloadsOf("payment.covered"),
        payloadsOf("payment.failure_credit_issued"),
      );
      return Response.json(report);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to build cfpay revenue report" }, { status: 500 });
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
      // Newest first. createdAt is millisecond-resolution, so two
      // payments recorded in the same millisecond tie on timestamp;
      // Array.sort is stable, which would then return them in
      // insertion order (oldest first) and break the newest-first
      // contract. Tie-break on insertion order, latest inserted first.
      const payments = ctx
        .getOrm()
        .transactions.findMany()
        .filter(isPaymentsAgentRow)
        .map((row, index) => ({ row, index }))
        .sort(
          (a, b) =>
            String(b.row.createdAt).localeCompare(String(a.row.createdAt)) ||
            b.index - a.index
        )
        .slice(0, limit)
        .map(({ row }) => toPaymentRecord(row));
      return Response.json({ count: payments.length, payments });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list ledger payments" }, { status: 500 });
    }
  }

  // Agentic Auto-Approve Limit (HITL threshold)
  if (path.endsWith("/payments/agentic/auto-approve-limit") || path.includes("/payments/agentic/auto-approve-limit")) {
    const paymentService = new ETradeAgenticPaymentService(ctx.getOrm(), ctx.env, sessionId);
    if (request.method === "GET") {
      // #1728: mode "mcp" adopts the MCP status shape (the full
      // wallet status, which carries autoApproveLimitUSD); mode
      // "rest" (legacy) keeps {autoApproveLimitUSD, network}.
      const walletMode = resolveAgenticRouteMode(ctx, "wallet", url.searchParams.get("mode"), "rest");
      if (walletMode === "mcp") {
        const status = await paymentService.getWalletStatus();
        return Response.json({ success: true, ...status });
      }
      return Response.json({
        autoApproveLimitUSD: paymentService.getAutoApproveLimit(),
        network: ctx.env.X402_NETWORK || "base-sepolia",
      });
    }
    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        // #1728: validation (400) and the limit_updated audit run in
        // BOTH modes — they are guards/observability, not presentation.
        // Only the RESPONSE SHAPE is switchable: mode "mcp" returns
        // the MCP set_limit shape (with the message string); mode
        // "rest" (legacy) returns {success, autoApproveLimitUSD}.
        const walletMode = resolveAgenticRouteMode(ctx, "wallet", body.mode, "rest");
        const limit = Number(body.limitUSD !== undefined ? body.limitUSD : body.limit);
        if (isNaN(limit) || limit < 0) {
          return Response.json({ error: "Invalid limitUSD. Must be non-negative number." }, { status: 400 });
        }
        paymentService.setAutoApproveLimit(limit);
        ctx.audit("agentic_payment.limit_updated", "payments", { limitUSD: limit });
        if (walletMode === "mcp") {
          return Response.json({
            success: true,
            message: `Agentic payment auto-approval limit set to $${limit.toFixed(2)} USD.`,
            autoApproveLimitUSD: limit,
          });
        }
        return Response.json({ success: true, autoApproveLimitUSD: limit });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to update limit" }, { status: 500 });
      }
    }
  }

  return null;
}
