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
 *   GET|POST /payments/agentic/commercial/*       (issues #2015/#2020/#2022:
 *                                                  minimal commercial account
 *                                                  store, tenant settings,
 *                                                  credit redemption, and the
 *                                                  dedicated paid-submission
 *                                                  route — see the block
 *                                                  below for the endpoints)
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
import {
  paymentsConfigErrorEvent,
  resolvePaymentsSwitchByKey,
  type PaymentsModeValues,
  type PaymentsScopedModes,
  type PaymentsSurfaceMode,
} from "../../config/agenticPaymentsModes";
import {
  buildPaymentWorkflowParams,
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
} from "../../services/paymentWorkflowSubmission";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../../data/createCommercialPorts";
import type { D1CommercialAdapter } from "../../data/d1CommercialAdapter";
import { toCommercialAccount } from "../../data/commercialPorts";
import { createWorkflowPorts, type WorkflowEnv } from "../../workflows/createWorkflowPorts";
import { tryStartScreenerWorkflow } from "../../workflows/screenerWorkflowRoutes";
import type { WorkflowJobCommand } from "../../workflows/workflowPorts";

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

  // ================================================================
  // Issues #2015/#2020/#2022: commercial account store on Drizzle
  // D1, tenant settings, credit redemption (#2019), and the
  // dedicated paid-submission route (no CTO collision: this route
  // never touches ScheduledTasksService or the #1997-2000 unified
  // run-request path; CTO wires into it later).
  //
  // Trust model, stated once for the whole block:
  // - x-user-login reaching this handler is session-verified
  //   (server.ts sets it from the session for /api/*, 401 without
  //   a session). Identity is that login; nothing here trusts a
  //   body-supplied userId.
  // - D1 is SHARED across instances, so there is no canonical-
  //   instance hop: the handler builds the store adapter straight
  //   from env.AGENT_DB. An unbound AGENT_DB fails closed on money
  //   paths (503) — the store cannot be verified, so no run starts
  //   and no balance is read as Free.
  // - Operator writes require COMMERCIAL_STORE_OPERATORS (empty =
  //   deny all). The consume/redeem/unredeemed-credit HTTP endpoints
  //   from the earlier DO-store draft are gone: with D1, the
  //   payment adapter and the submit route call the port directly,
  //   so no hop-only endpoint needs to exist.
  // ================================================================
  const commercialLogin = (): string | null => {
    const login = request.headers.get("x-user-login");
    return login && login.trim() ? login.trim() : null;
  };
  const isStoreOperator = (login: string | null): boolean => {
    if (!login) return false;
    const raw = (ctx.env as unknown as Record<string, unknown>)["COMMERCIAL_STORE_OPERATORS"];
    if (typeof raw !== "string" || !raw.trim()) return false;
    return raw.split(",").map((s) => s.trim()).includes(login);
  };
  const canAccessAccount = (login: string | null, userId: string): boolean =>
    login !== null && (login === userId || isStoreOperator(login));
  const requireStore = (): D1CommercialAdapter | Response => {
    const adapter = createCommercialAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Commercial store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };

  // GET /payments/agentic/commercial/account?userId=
  if (path.endsWith("/payments/agentic/commercial/account") && request.method === "GET") {
    try {
      const login = commercialLogin();
      const userId = url.searchParams.get("userId") ?? "";
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) {
        return Response.json({ error: "Forbidden: only the account owner or a store operator may read an account." }, { status: 403 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const record = await store.getAccount(userId);
      return Response.json({ record });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read commercial account" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/account (operator only)
  if (path.endsWith("/payments/agentic/commercial/account") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        userId?: unknown; tenantId?: unknown; tier?: unknown; creditsUSD?: unknown; includedRuns?: unknown;
      };
      const store = requireStore();
      if (store instanceof Response) return store;
      const record = await store.upsertAccount({
        userId: typeof body.userId === "string" ? body.userId : "",
        tenantId: typeof body.tenantId === "string" ? body.tenantId : "",
        tier: body.tier,
        creditsUSD: body.creditsUSD,
        includedRuns: body.includedRuns,
      });
      ctx.audit("commercial.account.upserted", "payments", { userId: record.id, tenantId: record.tenantId, tier: record.tier });
      return Response.json({ record });
    } catch (err: any) {
      const message = err.message || "Failed to upsert commercial account";
      return Response.json({ error: message }, { status: /requires|Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // POST /payments/agentic/commercial/account/credits (operator only)
  if (path.endsWith("/payments/agentic/commercial/account/credits") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown; deltaUSD?: unknown };
      const userId = typeof body.userId === "string" ? body.userId : "";
      const deltaUSD = Number(body.deltaUSD);
      if (!userId || !Number.isFinite(deltaUSD)) {
        return Response.json({ error: "userId and a finite deltaUSD are required." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const record = await store.adjustCredits(userId, deltaUSD);
      ctx.audit("commercial.account.credits_adjusted", "payments", { userId, deltaUSD });
      return Response.json({ record });
    } catch (err: any) {
      const message = err.message || "Failed to adjust credits";
      return Response.json({ error: message }, { status: /No commercial account|below zero/.test(message) ? 400 : 500 });
    }
  }

  // GET /payments/agentic/commercial/tenant-settings?tenantId= (operator only)
  if (path.endsWith("/payments/agentic/commercial/tenant-settings") && request.method === "GET") {
    try {
      const login = commercialLogin();
      const tenantId = url.searchParams.get("tenantId") ?? "";
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!tenantId) return Response.json({ error: "tenantId is required." }, { status: 400 });
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: only a store operator may read tenant settings." }, { status: 403 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      return Response.json({ tenantId, adsEnabled: await store.getTenantAdsEnabled(tenantId) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read tenant settings" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/tenant-settings (operator only)
  if (path.endsWith("/payments/agentic/commercial/tenant-settings") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { tenantId?: unknown; adsEnabled?: unknown };
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      if (!tenantId || typeof body.adsEnabled !== "boolean") {
        return Response.json({ error: "tenantId and a boolean adsEnabled are required." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const record = await store.setTenantAdsEnabled(tenantId, body.adsEnabled);
      ctx.audit("commercial.tenant_settings.set", "payments", { tenantId, adsEnabled: body.adsEnabled });
      return Response.json({ record });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to set tenant settings" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/submit — the dedicated
  // paid-submission route. One-off runs only: scheduleKind
  // "recurring" is refused (recurring schedules are created via
  // the schedule service, not here — no CTO collision). The route
  // never starts a screener for free: a new run goes through the
  // payment workflow (which enforces the gate), and a redeemed run
  // starts only after its credit claim is atomically redeemed.
  // Email is the caller's checkout contact, supplied by the caller
  // — it is NOT an identity proof. Identity is the verified
  // x-user-login; no verified email exists in the session.
  if (path.endsWith("/payments/agentic/commercial/submit") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        family?: unknown; trigger?: unknown; scheduleKind?: unknown; authorizedAtSubmission?: unknown;
        tenantId?: unknown; screenerCommand?: unknown; email?: unknown;
      };
      const family = body.family;
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const trigger = body.trigger === undefined ? "manual" : body.trigger;
      const screenerCommand = body.screenerCommand as { jobId?: unknown } | undefined;
      if (family !== "stock" && family !== "goal" && family !== "options" && family !== "strategy") {
        return Response.json({ error: "family must be stock, goal, options, or strategy." }, { status: 400 });
      }
      if (!tenantId) return Response.json({ error: "tenantId is required." }, { status: 400 });
      if (!email) return Response.json({ error: "email (checkout contact) is required." }, { status: 400 });
      if (trigger !== "manual" && trigger !== "scheduled") {
        return Response.json({ error: "trigger must be manual or scheduled." }, { status: 400 });
      }
      if (body.scheduleKind === "recurring") {
        return Response.json({ error: "Recurring schedules are created via the schedule service, not this route." }, { status: 400 });
      }
      if (body.scheduleKind !== undefined && body.scheduleKind !== "one_off") {
        return Response.json({ error: "scheduleKind must be one_off when given." }, { status: 400 });
      }
      if (!screenerCommand || typeof screenerCommand.jobId !== "string") {
        return Response.json({ error: "screenerCommand with a jobId is required." }, { status: 400 });
      }
      const runRequestId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

      // D1 store, schema ensured. A store failure fails closed:
      // without the account, coverage cannot be verified, so no
      // run starts — and without the claims table, a credit cannot
      // be checked, so no run is charged either.
      const store = requireStore();
      if (store instanceof Response) return store;
      try {
        await ensureCommercialSchema(store.db);
      } catch (err: any) {
        return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const stored = await store.getAccount(login);
      if (stored && stored.tenantId !== tenantId) {
        return Response.json({ error: "Tenant mismatch: run tenant must equal the verified account tenant." }, { status: 403 });
      }
      const account = toCommercialAccount(login, stored, email, tenantId);

      // Failure-credit redemption, if one exists for this family.
      const credit = await store.findUnredeemedCredit(login, family);
      if (credit) {
        // Pre-check the screener port before claiming: claiming
        // first and then failing to start would burn the credit.
        // The claim itself (primary-key insert) is the atomic guard
        // against two concurrent submissions spending one credit;
        // a lost race falls through to the payment path below.
        if (!createWorkflowPorts(ctx.env as unknown as WorkflowEnv)) {
          return Response.json({ error: "Screener workflow port unavailable; credit not redeemed, retry later." }, { status: 503 });
        }
        let redeemed = false;
        try {
          await store.redeemCredit(credit.creditRunId, runRequestId);
          redeemed = true;
        } catch (err: any) {
          if (!/already redeemed/.test(err.message || "")) {
            return Response.json({ error: `Credit redemption failed: ${err.message || "unknown error"}` }, { status: 503 });
          }
        }
        if (redeemed) {
          const handle = await tryStartScreenerWorkflow(ctx.env, screenerCommand as WorkflowJobCommand);
          if (!handle) {
            // Residual gap, stated plainly: the credit is claimed
            // but no run started. The audit row below is the
            // operator's re-issue signal; there is no operator
            // credit-issue route yet.
            ctx.audit("commercial.redeem.start_failed", "payments", { runRequestId, creditRunId: credit.creditRunId, userId: login });
            return Response.json({ error: "Credit redeemed but the screener could not start; an operator must re-issue.", runRequestId, creditRedeemed: true }, { status: 503 });
          }
          ctx.audit("commercial.credit.redeemed", "payments", { runRequestId, creditRunId: credit.creditRunId, family, userId: login });
          return Response.json({ runRequestId, status: "redeemed_started", creditRunId: credit.creditRunId, workflowId: handle.workflowId });
        }
      }

      const params = buildPaymentWorkflowParams({
        runRequestId,
        family,
        trigger,
        scheduleKind: body.scheduleKind as "one_off" | undefined,
        authorizedAtSubmission: body.authorizedAtSubmission === true,
        tenantId,
        userId: login,
        email,
        account,
        screenerCommand: screenerCommand as WorkflowJobCommand,
      });
      try {
        const binding = ctx.env.PAYMENT_WORKFLOW as unknown as PaymentWorkflowBinding | undefined;
        const started = await startPaymentWorkflowViaBinding(binding, params);
        return Response.json({ runRequestId, workflowId: started.workflowId, status: "payment_started" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Payment workflow could not start; no screener started." }, { status: 503 });
      }
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to submit paid run" }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/submission-status?workflowId=
  if (path.endsWith("/payments/agentic/commercial/submission-status") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const workflowId = url.searchParams.get("workflowId") ?? "";
      if (!workflowId) return Response.json({ error: "workflowId is required." }, { status: 400 });
      const binding = ctx.env.PAYMENT_WORKFLOW as unknown as { get(id: string): Promise<unknown> } | undefined;
      if (!binding || typeof binding.get !== "function") {
        return Response.json({ error: "Payment workflow binding is not configured." }, { status: 503 });
      }
      let status = "unknown";
      try {
        const instance = await binding.get(workflowId);
        const statusFn = (instance as { status?: unknown }).status;
        if (typeof statusFn === "function") {
          const result = (await (statusFn as () => Promise<unknown>).call(instance)) as { status?: unknown } | string | null;
          status =
            typeof result === "string"
              ? result
              : result && typeof result === "object" && typeof result.status === "string"
                ? result.status
                : "unknown";
        }
      } catch {
        status = "unknown";
      }
      return Response.json({ workflowId, status });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read submission status" }, { status: 500 });
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
