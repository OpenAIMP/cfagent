/**
 * Issue #359-07: payments routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move — no behavior change.
 *
 * Owns the Multi-Gateway Payments & DID Management API section:
 * GET /payments/gateways|/payments/status, GET /payments/dids,
 * /payments/transactions (ledger with DID provenance), POST /payments/create
 * (checkout/draft with gateway validation + DID attestation), POST
 * /payments/confirm (HITL authorize & execute), POST /payments/capture
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
 * (payment.created / payment.confirmed / payment.rejected /
 * payment.captured / payment.settled_webhook).
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
import { AGENT_DIDS, getUserDid, resolveAgentDidDocument } from "../did";
import type { AgentName, Env } from "../../types";
import type { SqlStorage } from "../../orm";

/** The subset of OrchestratorAgent surface the payments handlers need. */
export interface PaymentsRouteContext {
  /** Worker environment (owner: OrchestratorAgent — was `this.env`). */
  env: Env;
  /** SQLite accessor (owner: OrchestratorAgent — was the routeRequest-local `sql`). */
  ensureTables(): SqlStorage;
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
  if ((path.endsWith("/payments/gateways") || path.endsWith("/payments/status")) && request.method === "GET") {
    const paymentService = new PaymentGatewayService(ctx.env);
    const gateways = paymentService.getGatewayStatuses();
    return Response.json({
      gateways,
      agentDids: AGENT_DIDS,
      userDid: getUserDid(sessionId),
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
        const raw = Array.from(
          sql.exec(
            "SELECT id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at FROM mas_transactions ORDER BY created_at DESC LIMIT 50"
          )
        ) as any[];

        const transactions = raw.map((t) => ({
          id: String(t.id),
          sessionId: String(t.session_id),
          action: String(t.action),
          amount: Number(t.amount || 0),
          currency: String(t.currency || "USD"),
          customer: String(t.customer),
          gateway: String(t.gateway || "stripe"),
          gatewayRef: String(t.gateway_ref || ""),
          status: String(t.status),
          checkoutUrl: String(t.checkout_url || ""),
          proposerDid: String(t.proposer_did || AGENT_DIDS.PAYMENTS),
          authorizerDid: t.authorizer_did ? String(t.authorizer_did) : undefined,
          proofSignature: String(t.proof_signature || ""),
          note: String(t.note || ""),
          createdAt: String(t.created_at),
          updatedAt: String(t.updated_at),
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

  // Create payment checkout / draft
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

      const amount = Number(body.amount) || 10;
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

      const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
      const userDid = getUserDid(sessionId);

      const paymentService = new PaymentGatewayService(ctx.env);
      const checkoutResult = await paymentService.createCheckout({
        draftId,
        amount,
        currency,
        customer,
        description,
        gateway,
        userLogin: sessionId,
      });

      if (!checkoutResult.success) {
        return Response.json({
          success: false,
          error: checkoutResult.message || `Failed to create checkout with ${gateway}`,
          code: "PAYMENT_GATEWAY_ERROR",
        }, { status: 400 });
      }

      const now = new Date().toISOString();
      const initialStatus = checkoutResult.checkoutUrl ? "pending_checkout" : "completed";
      sql.exec(
        "INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        draftId,
        sessionId,
        action,
        amount,
        currency,
        customer,
        gateway,
        checkoutResult.gatewayRef || "",
        initialStatus,
        checkoutResult.checkoutUrl,
        AGENT_DIDS.PAYMENTS,
        userDid,
        checkoutResult.didAttestation.signature,
        description,
        now,
        now
      );

      ctx.audit("payment.created", "payments", {
        draftId,
        amount,
        currency,
        customer,
        gateway,
        proposerDid: AGENT_DIDS.PAYMENTS,
        authorizerDid: userDid,
        proofSignature: checkoutResult.didAttestation.signature,
      });

      return Response.json({
        success: true,
        transaction: {
          id: draftId,
          sessionId,
          action,
          amount,
          currency,
          customer,
          gateway,
          gatewayRef: checkoutResult.gatewayRef,
          status: initialStatus,
          checkoutUrl: checkoutResult.checkoutUrl,
          proposerDid: AGENT_DIDS.PAYMENTS,
          authorizerDid: userDid,
          proofSignature: checkoutResult.didAttestation.signature,
          note: description,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to create payment" }, { status: 500 });
    }
  }

  // Authorize & Execute a pending payment draft (HITL)
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

      const userDid = getUserDid(sessionId);
      const now = new Date().toISOString();

      if (decision === "approved") {
        // Retrieve draft from mas_transactions
        const rows = Array.from(sql.exec("SELECT * FROM mas_transactions WHERE id = ?", draftId)) as any[];
        const tx = rows[0];
        const paymentService = new PaymentGatewayService(ctx.env);

        let checkoutUrl = tx?.checkout_url || "";
        let gatewayRef = tx?.gateway_ref || "";

        if (tx && (tx.action === "charge" || tx.action === "invoice") && !checkoutUrl) {
          const res = await paymentService.createCheckout({
            draftId,
            amount: Number(tx.amount),
            currency: String(tx.currency || "USD"),
            customer: String(tx.customer),
            gateway: tx.gateway as SupportedGateway,
            userLogin: sessionId,
            description: tx.note || "Authorized payment intent",
          });
          checkoutUrl = res.checkoutUrl;
          gatewayRef = res.gatewayRef;
        } else if (tx && tx.action === "refund") {
          const res = await paymentService.executeRefund({
            transactionId: draftId,
            amount: Number(tx.amount),
            gateway: tx.gateway as SupportedGateway,
            gatewayRef: tx.gateway_ref,
            userLogin: sessionId,
            reason: note,
          });
          gatewayRef = res.refundId;
        }

        sql.exec(
          "UPDATE mas_transactions SET status = 'completed', gateway_ref = ?, checkout_url = ?, authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
          gatewayRef,
          checkoutUrl,
          userDid,
          note || "Confirmed by human authorizer",
          now,
          draftId
        );

        ctx.audit("payment.confirmed", "payments", {
          draftId,
          authorizerDid: userDid,
          executorDid: AGENT_DIDS.ORCHESTRATOR,
          gatewayRef,
          checkoutUrl,
        });

        return Response.json({
          success: true,
          status: "completed",
          draftId,
          checkoutUrl,
          gatewayRef,
          authorizerDid: userDid,
        });
      } else {
        sql.exec(
          "UPDATE mas_transactions SET status = 'rejected', authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
          userDid,
          note || "Rejected by reviewer",
          now,
          draftId
        );

        ctx.audit("payment.rejected", "payments", { draftId, authorizerDid: userDid });
        return Response.json({ success: true, status: "rejected", draftId });
      }
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
        sql.exec(
          "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ?",
          now,
          draftId
        );
        ctx.audit("payment.settled_webhook", "payments", { draftId, provider, raw: body?.type || body?.event_type });
      }

      return Response.json({ received: true });
    } catch {
      return Response.json({ received: false }, { status: 400 });
    }
  }

  return null;
}

