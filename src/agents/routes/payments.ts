/**
 * Issue #359-07: payments routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the Multi-Gateway Payments & DID Management API section:
 * GET /payments/gateways|/payments/status, GET /payments/dids,
 * /payments/transactions (ledger with DID provenance), POST /payments/create
 * (#1690: HITL draft via draft_payment — no checkout at create, gateway
 * validation + DID attestation), POST /payments/confirm (HITL authorize &
 * execute via confirm_payment_draft), POST /payments/capture
 * (real capture), POST /payments/webhook (unified HMAC-verified listener).
 * The seven blocks were contiguous in routeRequest (between the
 * referrals+ads handler and the Cloudflare Agentic Payments block), so this
 * module exports ONE handler invoked from routeRequest at the EXACT position
 * the original blocks occupied in the sequential path.endsWith matching
 * sequence. It returns a Response when one of its paths matches, or null
 * when none does — matching order relative to all other handlers is
 * preserved by the call site.
 *
 * Payment routes are money-adjacent; every guard and validation is
 * preserved exactly as written inline: the #156 gateway 400-before-checkout
 * gate, the #148 webhook provider default-deny (401 before verification),
 * signature verification (401 on invalid), and the audit event names
 * (payment.awaiting_confirmation / payment.confirmed / payment.rejected /
 * payment.captured / payment.settled_webhook — #1690 replaced the old
 * payment.created create audit with the draft command's
 * payment.awaiting_confirmation audit).
 *
 * The PaymentGatewayService and DID helpers stay where they are — this
 * module moves the ROUTE layer only. Handlers that used OrchestratorAgent
 * state receive it via the explicit PaymentsRouteContext parameter; there
 * are no new globals and no back-references into the class.
 */

import {
  PaymentGatewayService,
  normalizeGateway,
  isWebhookGateway,
  isSupportedGateway,
  SUPPORTED_GATEWAYS,
  type SupportedGateway,
} from "../../services/payments";
import { AGENT_DIDS, resolveAgentDidDocument } from "../did";
import {
  SETTLEMENT_OWNER_HEADER,
  resolveDraftOwner,
} from "../../payments/draftOwners";
import type { AgentName, Env } from "../../types";
import { DatabaseORM, type SqlStorage } from "../../orm";
import { executeMCPTool } from "../../mcp/index";
import { runRestTool } from "./restToolBridge";

/** The subset of OrchestratorAgent surface the payments handlers need. */
export interface PaymentsRouteContext {
  /** Worker environment (owner: OrchestratorAgent — was `this.env`). */
  env: Env;
  /** SQLite accessor (owner: OrchestratorAgent — was the routeRequest-local `sql`). */
  ensureTables(): SqlStorage;
  /**
   * #1644: ORM accessor for command execution. Optional — routes without
   * it build a DatabaseORM over ensureTables() (same tables, no seeding).
   */
  getOrm?: () => DatabaseORM;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
}

/**
 * Handles the payments routes. Returns a Response on match, null when
 * no payments path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handlePaymentsRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: PaymentsRouteContext
): Promise<Response | null> {
  const sql = ctx.ensureTables();
  // Multi-Gateway Payments & DID Management API
  // ==========================================

  // Gateway status & DID registry
  // #1644: executed through the get_payment_gateways command. The facade
  // delegates to the same PaymentGatewayService the route called, so the
  // data is identical; the route keeps its 3-field shape (the command's
  // extra `count` is presentation the route does not carry).
  if ((path.endsWith("/payments/gateways") || path.endsWith("/payments/status")) && request.method === "GET") {
    const out = await executeMCPTool("get_payment_gateways", {}, {
      env: ctx.env,
      orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
      sessionId,
      audit: (type, agent, payload) => ctx.audit(type, agent, payload),
    });
    return Response.json({
      gateways: out.gateways,
      agentDids: out.agentDids,
      userDid: out.userDid,
    });
  }

  // W3C DID Document resolver for agents
  if (path.endsWith("/payments/dids") && request.method === "GET") {
    const didParam = url.searchParams.get("did");
    if (didParam) {
      return Response.json(resolveAgentDidDocument(didParam));
    }
    const didDocs = Object.values(AGENT_DIDS).map((did) => resolveAgentDidDocument(did));
    return Response.json({
      count: didDocs.length,
      documents: didDocs,
    });
  }

  // Transaction ledger with DID provenance
  if (path.endsWith("/payments/transactions")) {
    if (request.method === "GET") {
      try {
        // #1644: the ledger query (created_at DESC, limit 50) executes
        // through the get_transactions command. The route keeps its row
        // coercions and summary stats as presentation — the command rows
        // already carry the camelCase fields the old raw-SQL mapping built.
        const out = (await runRestTool("get_transactions", { limit: 50 }, {
          orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
          sessionId,
          audit: (type, agent, payload) => ctx.audit(type, agent, payload),
        })) as { transactions: any[] };

        const transactions = out.transactions.map((t) => ({
          id: String(t.id),
          sessionId: String(t.sessionId),
          action: String(t.action),
          amount: Number(t.amount || 0),
          currency: String(t.currency || "USD"),
          customer: String(t.customer),
          gateway: String(t.gateway || "stripe"),
          gatewayRef: String(t.gatewayRef || ""),
          status: String(t.status),
          checkoutUrl: String(t.checkoutUrl || ""),
          proposerDid: String(t.proposerDid || AGENT_DIDS.PAYMENTS),
          authorizerDid: t.authorizerDid ? String(t.authorizerDid) : undefined,
          proofSignature: String(t.proofSignature || ""),
          note: String(t.note || ""),
          createdAt: String(t.createdAt),
          updatedAt: String(t.updatedAt),
        }));

        const totalVolume = transactions
          .filter((t) => t.status === "completed" || t.status === "authorized")
          .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : -t.amount), 0);

        const pendingCount = transactions.filter((t) => t.status === "awaiting_confirmation").length;
        const completedCount = transactions.filter((t) => t.status === "completed" || t.status === "authorized").length;

        return Response.json({
          count: transactions.length,
          transactions,
          summary: {
            totalVolume: Math.max(0, totalVolume),
            completedCount,
            pendingCount,
            verifiedDidCount: transactions.length,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
      }
    }
  }

  // Create a payment draft (#1690: delegated to draft_payment — no
  // checkout at create; the checkout happens at confirm).
  if (path.endsWith("/payments/create") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        amount?: number;
        currency?: string;
        customer?: string;
        action?: "charge" | "refund" | "invoice";
        gateway?: string;
        description?: string;
      };

      // #524: an omitted or unparseable amount is a validation error, never
      // a silent $10 charge.
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return Response.json(
          { error: "amount is required and must be a positive number" },
          { status: 400 }
        );
      }
      const currency = (body.currency || "USD").toUpperCase();
      // No invented customer name (issue #514): a create that supplies no
      // customer stores "" rather than a fabricated organization.
      const customer = (body.customer || "").trim();
      const action = body.action || "charge";
      // Validate the gateway where caller input enters (issue #156): an
      // unsupported value is rejected with a 400 BEFORE any checkout is
      // attempted and BEFORE any transaction row is written. Normalization
      // matches the webhook verifier (#148), so " Stripe " stores "stripe".
      const gatewayInput =
        body.gateway == null || (typeof body.gateway === "string" && body.gateway.trim() === "")
          ? "stripe"
          : String(body.gateway);
      if (!isSupportedGateway(gatewayInput)) {
        return Response.json({
          success: false,
          error: `Unsupported payment gateway: "${gatewayInput}". Supported gateways: ${SUPPORTED_GATEWAYS.join(", ")}.`,
          code: "UNSUPPORTED_GATEWAY",
        }, { status: 400 });
      }
      const gateway = normalizeGateway(gatewayInput) as SupportedGateway;
      // No invented product description (issue #514): a create that
      // supplies no description stores "" — the caller's text or nothing,
      // never a product line for a product that does not exist.
      const description = (body.description || "").trim();

      // #1690 (owner decision: HITL-draft canonical): create executes
      // through the MCP draft_payment command via executeMCPTool — the
      // #1644 pattern, route keeps transport + presentation only. The
      // command mints the draft id + DID attestation, writes the
      // awaiting_confirmation row (checkoutUrl/gatewayRef ""), records
      // the #932 draft owner, and audits payment.awaiting_confirmation.
      // NO checkout is attempted here: the old PAYMENT_GATEWAY_ERROR
      // -at-create path disappears, and checkout failures surface at
      // confirm instead. The gateway 400 above still runs BEFORE any
      // command call (hence before any row write), because the draft
      // command does not itself validate the gateway.
      const out = await executeMCPTool("draft_payment", {
        amount,
        currency,
        customer,
        action,
        gateway,
        // Explicitly passed even when "" so the command's #1690/#514
        // rule keeps the pinned empty note (an omitted description
        // keeps the command's generic default only for direct MCP
        // callers that omit the field entirely).
        description,
      }, {
        env: ctx.env,
        orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
        sessionId,
        audit: (type, agent, payload) => ctx.audit(type, agent, payload),
      });
      const tx = out.transaction;

      return Response.json({
        success: true,
        transaction: {
          id: String(tx.id),
          sessionId: String(tx.sessionId),
          action: String(tx.action),
          amount: Number(tx.amount),
          currency: String(tx.currency),
          customer: String(tx.customer),
          gateway: String(tx.gateway),
          gatewayRef: String(tx.gatewayRef || ""),
          status: String(tx.status),
          checkoutUrl: String(tx.checkoutUrl || ""),
          proposerDid: String(tx.proposerDid),
          authorizerDid: tx.authorizerDid ? String(tx.authorizerDid) : undefined,
          proofSignature: String(tx.proofSignature || ""),
          note: String(tx.note || ""),
          createdAt: String(tx.createdAt),
          updatedAt: String(tx.updatedAt),
        },
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to create payment" }, { status: 500 });
    }
  }

  // Authorize & Execute a pending payment draft (HITL)
  // #1690 (owner decision: HITL-draft canonical): confirm executes
  // through the MCP confirm_payment_draft command via executeMCPTool —
  // the #1644 pattern, route keeps transport + presentation only.
  // Deltas from the old REST confirm, all owned by the command now:
  // a missing draft THROWS before the decision branch (mapped to 404
  // here — no more silent success); an approved charge/invoice creates
  // a checkout UNCONDITIONALLY via the facade (overwriting any
  // checkoutUrl an old-immediate-checkout row already carries — see
  // the migration note in the issue); note text is the command's
  // ("Approved by human authorizer" / "Rejected by human reviewer");
  // and the confirm/reject audits are the command's payloads
  // (decision/status fields in, executorDid out).
  if (path.endsWith("/payments/confirm") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        draftId?: string;
        decision?: "approved" | "rejected";
        note?: string;
      };

      const draftId = (body.draftId || "").trim();
      const decision = body.decision || "approved";
      const note = (body.note || "").trim();

      if (!draftId) {
        return Response.json({ error: "draftId is required" }, { status: 400 });
      }

      let out: any;
      try {
        out = await executeMCPTool("confirm_payment_draft", {
          draftId,
          decision,
          note,
        }, {
          env: ctx.env,
          orm: ctx.getOrm?.() ?? new DatabaseORM(sql),
          sessionId,
          audit: (type, agent, payload) => ctx.audit(type, agent, payload),
        });
      } catch (err) {
        // The command throws on a missing draft before either decision
        // branch; that is a client error, not a 500 — and it replaces
        // the old route's silent success on a missing draft.
        if (err instanceof Error && /not found/i.test(err.message)) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }

      if (out.decision === "approved") {
        return Response.json({
          success: true,
          status: "completed",
          draftId,
          checkoutUrl: out.checkoutUrl || "",
          gatewayRef: out.gatewayRef || "",
          authorizerDid: out.authorizerDid,
        });
      }
      return Response.json({ success: true, status: "rejected", draftId });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to confirm payment draft" }, { status: 500 });
    }
  }

  // Real payment capture endpoint (PayPal & Stripe)
  if (path.endsWith("/payments/capture") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        orderId?: string;
        gateway?: SupportedGateway;
      };
      const orderId = (body.orderId || "").trim();
      const gateway = (body.gateway || "paypal") as SupportedGateway;
      if (!orderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      const paymentService = new PaymentGatewayService(ctx.env);
      const result = await paymentService.capturePayment({
        gateway,
        orderId,
        userLogin: sessionId,
      });

      if (result.success) {
        const now = new Date().toISOString();
        sql.exec(
          "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ? OR gateway_ref = ?",
          now,
          orderId,
          orderId
        );
        ctx.audit("payment.captured", "payments", { orderId, gateway, captureId: result.captureId });
      }

      return Response.json(result);
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to capture payment" }, { status: 500 });
    }
  }

  // Unified Payment Webhook listener (Stripe, PayPal, Lemon Squeezy with HMAC Verification)
  if (path.endsWith("/payments/webhook") && request.method === "POST") {
    try {
      const providerParam = url.searchParams.get("provider") || "stripe";
      const provider = normalizeGateway(providerParam) as SupportedGateway;

      // Defence in depth (issue #148): reject unsupported providers at
      // the route, before verification and before any state change. The
      // service's verifier independently default-denies them; a webhook
      // from an unverifiable provider must never settle a transaction.
      if (!isWebhookGateway(provider)) {
        return Response.json({ error: `Unsupported webhook provider: ${providerParam}` }, { status: 401 });
      }

      const rawBody = await request.text();
      const paymentService = new PaymentGatewayService(ctx.env);

      // Verify cryptographic webhook signature
      const verification = await paymentService.verifyWebhookSignature(provider, rawBody, request.headers);
      if (!verification.isValid) {
        return Response.json({ error: verification.reason || "Invalid webhook signature" }, { status: 401 });
      }

      let body: any = {};
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = {};
      }

      const now = new Date().toISOString();

      // Extract reference ID from Stripe / PayPal / Lemon Squeezy payload
      const draftId = body?.data?.object?.client_reference_id ||
        body?.resource?.purchase_units?.[0]?.reference_id ||
        body?.data?.attributes?.checkout_data?.custom?.draftId ||
        body?.draftId;

      if (draftId) {
        // Issue #932: settlement must execute in the instance that OWNS
        // the draft. Webhooks land on the shared system_webhook_receiver
        // instance (src/server.ts interception), but drafts live in
        // per-user instances — the previous code ran the UPDATE against
        // this instance's store, matched 0 rows for every real draft,
        // and still returned { received: true }. Resolution order:
        //   1. a settlement hop (SETTLEMENT_OWNER_HEADER, set only by
        //      the forwarding instance below) settles here only when it
        //      names THIS instance; anything else is a misroute and is
        //      refused loud — an instance never settles on another
        //      tenant's behalf;
        //   2. a draft row in THIS store is owned by possession and
        //      settles here;
        //   3. otherwise the draft-owner registry (written by every
        //      create path — src/payments/draftOwners.ts) names the
        //      owner, and the verified webhook is forwarded to it.
        // A settlement that matches no draft is LOUD (error response +
        // payment.settled_webhook_unmatched audit + console.error),
        // never a silent { received: true }.
        const auditUnmatched = (reason: string, status: number): Response => {
          console.error(
            `[payments] webhook settlement unmatched: draft=${draftId} provider=${provider} reason=${reason}`
          );
          ctx.audit("payment.settled_webhook_unmatched", "payments", {
            draftId,
            provider,
            reason,
            raw: body?.type || body?.event_type,
          });
          return Response.json(
            {
              received: false,
              settled: false,
              unmatched: true,
              draftId,
              error: `Settlement matched no draft (${reason})`,
            },
            { status }
          );
        };
        const settleHere = (): Response => {
          const rows = Array.from(
            sql.exec("SELECT id FROM mas_transactions WHERE id = ?", draftId)
          ) as any[];
          if (rows.length === 0) return auditUnmatched("owner_row_missing", 404);
          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ?",
            now,
            draftId
          );
          ctx.audit("payment.settled_webhook", "payments", { draftId, provider, raw: body?.type || body?.event_type });
          return Response.json({ received: true, settled: true, draftId });
        };

        const routedOwner = request.headers.get(SETTLEMENT_OWNER_HEADER);
        if (routedOwner) {
          if (routedOwner !== sessionId) return auditUnmatched("misrouted", 502);
          return settleHere();
        }

        const localRows = Array.from(
          sql.exec("SELECT id FROM mas_transactions WHERE id = ?", draftId)
        ) as any[];
        if (localRows.length > 0) return settleHere();

        const owner = await resolveDraftOwner(ctx.env, draftId);
        if (!owner) return auditUnmatched("unknown_draft", 404);
        if (owner === sessionId) return settleHere();

        // Forward the verified webhook to the owning instance, which
        // re-verifies the signature and settles against its own store —
        // so the settlement and its audit event land in the owning
        // instance. The owner's response (settled, or loud-unmatched)
        // is propagated to the gateway unchanged.
        try {
          const ns = ctx.env.SEARCH_AGENT;
          const stub = ns.get(ns.idFromString(owner));
          const headers = new Headers(request.headers);
          headers.set(SETTLEMENT_OWNER_HEADER, owner);
          headers.delete("content-length");
          const targetUrl = new URL("/payments/webhook" + url.search, "https://agent.internal");
          return await stub.fetch(
            new Request(targetUrl, { method: "POST", headers, body: rawBody })
          );
        } catch (err) {
          console.error(
            `[payments] webhook settlement routing failed: draft=${draftId} owner=${owner}:`,
            err instanceof Error ? err.message : String(err)
          );
          return auditUnmatched("routing_unavailable", 502);
        }
      }

      return Response.json({ received: true });
    } catch {
      return Response.json({ received: false }, { status: 400 });
    }
  }

  return null;
}

