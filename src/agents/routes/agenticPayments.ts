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
 *   GET|POST /payments/agentic/commercial/*       (issues #2015/#2020/#2022:
 *                                                  minimal commercial account
 *                                                  store, tenant settings,
 *                                                  credit redemption, and the
 *                                                  dedicated paid-submission
 *                                                  route)
 *   GET|POST /payments/agentic/commercial/plans   (issues #2020/#2127:
 *                                                  subscription plans as
 *                                                  operator data)
 *   GET|POST /payments/agentic/commercial/subscription/*
 *                                                  (issues #2020/#2127:
 *                                                  subscription checkout,
 *                                                  purchase, cancel, status)
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
import {
  buildPaymentWorkflowParams,
  deliverPaymentVerifiedViaHost,
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
  type PaymentWorkflowHost,
} from "../../services/paymentWorkflowSubmission";
import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import { cfpayA2AOperation, getCfpayConfig } from "../../services/cfpayA2A";
import { PAYMENT_DISCLOSURE } from "../../services/cfpayMonetization";
import { PROPOSED_SEED_PRICES } from "../../data/priceCataloguePorts";
import {
  createPriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../../data/createPriceCataloguePorts";
import { buildScenario, GOAL_TAXONOMY } from "../../services/goalScenarioEngine";
import { buildGoalScreenCommand } from "../../services/goalScreenWorkflowSubmission";
import {
  createCommercialAdapter,
  ensureCommercialSchema,
} from "../../data/createCommercialPorts";
import {
  createJournalAdapter,
  ensureJournalSchema,
} from "../../data/createJournalPorts";
import { mapRedemptionToJournalEntries } from "../../data/journalPorts";
import { postJournalBestEffort } from "../../services/journalPosting";
import type { D1CommercialAdapter } from "../../data/d1CommercialAdapter";
import { toCommercialAccount } from "../../data/commercialPorts";
import {
  createSubscriptionAdapter,
  ensureSubscriptionSchema,
} from "../../data/createSubscriptionPorts";
import type { D1SubscriptionAdapter } from "../../data/d1SubscriptionAdapter";
import { resolveEffectiveTier } from "../../data/subscriptionPorts";
import { activateSubscription } from "../../services/subscriptionActivation";
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
  const requireSubs = (): D1SubscriptionAdapter | Response => {
    const adapter = createSubscriptionAdapter(ctx.env as { AGENT_DB?: unknown });
    if (!adapter) {
      return Response.json({ error: "Subscription store unavailable: AGENT_DB is not bound." }, { status: 503 });
    }
    return adapter;
  };
  // Money paths fail CLOSED when the monetization flag is OFF:
  // no checkout is minted and no purchase activates. This mirrors
  // the live-assurance guard (flag OFF → 403).
  const requireMonetization = async (): Promise<Response | null> => {
    const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
    if (!flagOn) {
      return Response.json({ error: "monetization flag is OFF; subscription purchase is disabled." }, { status: 403 });
    }
    return null;
  };
  // Both stores, schema ensured. Money routes call this before
  // any read or write: the account upsert writes tier_source
  // (migration 0008), so the commercial write path needs 0008
  // applied too, not just 0007.
  const ensureStores = async (
    store: D1CommercialAdapter,
    subs: D1SubscriptionAdapter,
  ): Promise<Response | null> => {
    try {
      await ensureCommercialSchema(store.db);
      await ensureSubscriptionSchema(subs.db);
    } catch (err: any) {
      return Response.json({ error: `Commercial store unavailable: ${err.message || "unknown error"}` }, { status: 503 });
    }
    return null;
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
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const record = await store.getAccount(userId);
      // Effective tier, not just the stored baseline: a lapsed
      // subscription stops conferring Subscribed, while an
      // operator grant survives. A subscription-read failure
      // degrades to the stored tier (display value only — the
      // money paths below fail closed instead).
      let subscriptions: Array<{ periodEndMs: number }> = [];
      try {
        subscriptions = await subs.listSubscriptions(userId);
      } catch {
        subscriptions = [];
      }
      const effectiveTier = resolveEffectiveTier(record, subscriptions, Date.now());
      return Response.json({ record, effectiveTier });
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
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const record = await store.upsertAccount({
        userId: typeof body.userId === "string" ? body.userId : "",
        tenantId: typeof body.tenantId === "string" ? body.tenantId : "",
        tier: body.tier,
        // An operator write is an operator grant: it survives a
        // lapsed subscription (see resolveEffectiveTier).
        tierSource: "operator",
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
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const stored = await store.getAccount(login);
      if (stored && stored.tenantId !== tenantId) {
        return Response.json({ error: "Tenant mismatch: run tenant must equal the verified account tenant." }, { status: 403 });
      }
      // Effective tier at submission time: a lapsed subscription
      // stops covering runs even though the stored tier may still
      // read Subscribed. A subscription-read failure fails CLOSED
      // here (money path) — no run starts on unverified coverage.
      let subscriptions: Array<{ periodEndMs: number }>;
      try {
        subscriptions = await subs.listSubscriptions(login);
      } catch (err: any) {
        return Response.json({ error: `Subscription state unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const effectiveTier = resolveEffectiveTier(stored, subscriptions, Date.now());
      const account = { ...toCommercialAccount(login, stored, email, tenantId), tier: effectiveTier };

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
          // Issue #2155: project the redemption into the D1 journal
          // (Dr 2000 / Cr 4000 — the replacement run is delivered).
          // BEST-EFFORT, never thrown: the run already started and
          // the credit is already claimed; a journal failure is a
          // loud log + a reconcile flag. Posted only on start
          // success, never on the start_failed path above.
          await postJournalBestEffort(async () => {
            const adapter = createJournalAdapter(ctx.env as { AGENT_DB?: unknown });
            if (!adapter) return null;
            await ensureJournalSchema(adapter.db);
            return adapter;
          }, mapRedemptionToJournalEntries({
            transactionRef: runRequestId,
            tenantId,
            runRequestId,
            family,
            amountUSD: credit.amountUSD,
          }));
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
        // Issue #2137: stamp the screener command's owner from the
        // verified session login, never from a caller claim. The
        // command's userLogin is run attribution; authentication is
        // the session header, and a caller-supplied owner must not
        // survive into the workflow.
        screenerCommand: { ...(screenerCommand as Record<string, unknown>), userLogin: login } as WorkflowJobCommand,
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

  // ================================================================
  // Subscriptions (#2020/#2127): plans as operator data, a
  // route-owned cfpay checkout, purchase activation on verified
  // payment, cancel-at-period-end, and the effective-tier status
  // read. No provider auto-renewal exists here: cfpay is
  // one-time-only, so renewal is repurchase before expiry
  // (stacked from the latest periodEnd). No cash refunds in this
  // slice (deferred #2024). Money paths fail closed; the
  // monetization flag must be ON for checkout and purchase.
  // ================================================================

  // GET /payments/agentic/commercial/plans — active plans any verified login may buy.
  if (path.endsWith("/payments/agentic/commercial/plans") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      return Response.json({ plans: await subs.listPlans(true) });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to list plans" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/plans (operator only) — plans are data, never code: no price is hardcoded anywhere.
  if (path.endsWith("/payments/agentic/commercial/plans") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as {
        id?: unknown; name?: unknown; priceUSD?: unknown; periodDays?: unknown; includedRuns?: unknown;
      };
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.createPlan({
        id: body.id,
        name: body.name,
        priceUSD: body.priceUSD,
        periodDays: body.periodDays,
        includedRuns: body.includedRuns,
      });
      ctx.audit("commercial.plan.created", "payments", { planId: plan.id, priceUSD: plan.priceUSD, periodDays: plan.periodDays, includedRuns: plan.includedRuns });
      return Response.json({ plan });
    } catch (err: any) {
      const message = err.message || "Failed to create plan";
      return Response.json({ error: message }, { status: /required|must be|already exists/.test(message) ? 400 : 500 });
    }
  }

  // POST /payments/agentic/commercial/plans/deactivate (operator only) — stops new purchases; existing subscriptions run to periodEnd.
  if (path.endsWith("/payments/agentic/commercial/plans/deactivate") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.deactivatePlan(planId);
      ctx.audit("commercial.plan.deactivated", "payments", { planId: plan.id });
      return Response.json({ plan });
    } catch (err: any) {
      const message = err.message || "Failed to deactivate plan";
      return Response.json({ error: message }, { status: /No plan/.test(message) ? 404 : 500 });
    }
  }

  // POST /payments/agentic/commercial/subscription/checkout — route-owned cfpay checkout for a plan.
  // The route mints the checkout (requestId prefixed "sub-") so purchase can bind fulfillment to a
  // checkout WE created for this plan. Email is the checkout contact, supplied by the caller — it is
  // NOT an identity proof. Identity is the verified x-user-login.
  if (path.endsWith("/payments/agentic/commercial/subscription/checkout") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; tenantId?: unknown; email?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      if (!tenantId) return Response.json({ error: "tenantId is required." }, { status: 400 });
      if (!email) return Response.json({ error: "email (checkout contact) is required." }, { status: 400 });
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      const stored = await store.getAccount(login);
      if (stored && stored.tenantId !== tenantId) {
        return Response.json({ error: "Tenant mismatch: subscription tenant must equal the verified account tenant." }, { status: 403 });
      }
      const config = getCfpayConfig(ctx.env);
      if (!config) {
        return Response.json({ error: "cfpay is not configured." }, { status: 503 });
      }
      const checkoutRequestId = `sub-${crypto.randomUUID()}`;
      const res = await cfpayA2AOperation(config, "/a2a/payments", "checkout.create", {
        requestId: checkoutRequestId,
        email,
        request: `subscription ${plan.id} ${plan.priceUSD}`,
      });
      if (!res.ok) {
        return Response.json({ error: "cfpay checkout could not be created." }, { status: 503 });
      }
      ctx.audit("commercial.subscription.checkout_created", "payments", { userId: login, tenantId, planId: plan.id, checkoutRequestId });
      return Response.json({
        checkoutRequestId,
        checkout: res.data ?? null,
        plan: { id: plan.id, name: plan.name, priceUSD: plan.priceUSD, periodDays: plan.periodDays, includedRuns: plan.includedRuns },
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to create subscription checkout" }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/subscription/purchase — activate on VERIFIED payment only.
  // Fulfillment is re-read from cfpay checkout.status (fulfilled/paid), never a return page, exactly
  // like the payment workflow's confirm step. The checkout reference must come from the checkout
  // route above ("sub-" prefix) and activates at most one subscription (replay → 409). Amount
  // matching is NOT independently re-checked: the cfpay status shape the gate consumes carries no
  // amount field, so the binding is route-owned creation + fulfilled status; a route-owned
  // checkout for a plan is only fulfilled when cfpay accepts payment for it.
  if (path.endsWith("/payments/agentic/commercial/subscription/purchase") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const flag = await requireMonetization();
      if (flag) return flag;
      const body = (await request.json().catch(() => ({}))) as { planId?: unknown; tenantId?: unknown; checkoutRequestId?: unknown };
      const planId = typeof body.planId === "string" ? body.planId : "";
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      const checkoutRequestId = typeof body.checkoutRequestId === "string" ? body.checkoutRequestId : "";
      if (!planId) return Response.json({ error: "planId is required." }, { status: 400 });
      if (!tenantId) return Response.json({ error: "tenantId is required." }, { status: 400 });
      if (!checkoutRequestId) return Response.json({ error: "checkoutRequestId is required." }, { status: 400 });
      if (!checkoutRequestId.startsWith("sub-")) {
        return Response.json({ error: "checkoutRequestId must come from the subscription checkout route." }, { status: 400 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const plan = await subs.getPlan(planId);
      if (!plan) return Response.json({ error: `No plan ${planId}.` }, { status: 404 });
      if (!plan.active) return Response.json({ error: `Plan ${planId} is not active.` }, { status: 409 });
      const config = getCfpayConfig(ctx.env);
      if (!config) {
        return Response.json({ error: "cfpay is not configured." }, { status: 503 });
      }
      const statusRes = await cfpayA2AOperation(config, "/a2a/payments", "checkout.status", { requestId: checkoutRequestId });
      if (!statusRes.ok) {
        return Response.json({ error: "Payment verification unavailable." }, { status: 503 });
      }
      const statusData = statusRes.data as { status?: string; state?: string; paid?: boolean } | undefined;
      const state = String(statusData?.status ?? statusData?.state ?? "").toLowerCase();
      if (!(state === "fulfilled" || state === "paid" || statusData?.paid === true)) {
        return Response.json({ error: "Checkout is not fulfilled; no subscription activated." }, { status: 402 });
      }
      const { subscription, account } = await activateSubscription({
        subs,
        store,
        userId: login,
        tenantId,
        plan,
        providerPaymentRef: checkoutRequestId,
      });
      ctx.audit("commercial.subscription.activated", "payments", {
        userId: login,
        tenantId,
        planId: plan.id,
        subscriptionId: subscription.id,
        providerPaymentRef: checkoutRequestId,
        periodEndMs: subscription.periodEndMs,
      });
      const effectiveTier = resolveEffectiveTier(account, [subscription], Date.now());
      return Response.json({ subscription, account, effectiveTier });
    } catch (err: any) {
      const message = err.message || "Failed to activate subscription";
      const status = /Tenant mismatch/.test(message)
        ? 403
        : /already activated/.test(message)
          ? 409
          : /required|must be|not active/.test(message)
            ? 400
            : 500;
      return Response.json({ error: message }, { status });
    }
  }

  // POST /payments/agentic/commercial/subscription/cancel — cancel-at-period-end.
  // Sets every unexpired row canceled; access continues to periodEnd, then stops. No cash refund
  // (deferred #2024). Self-service, or an operator on a user's behalf (body.userId).
  if (path.endsWith("/payments/agentic/commercial/subscription/cancel") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { userId?: unknown };
      const targetUser = typeof body.userId === "string" && body.userId ? body.userId : login;
      if (targetUser !== login && !isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: only the subscriber or a store operator may cancel." }, { status: 403 });
      }
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const store = requireStore();
      if (store instanceof Response) return store;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const canceled = await subs.cancelUnexpiredSubscriptions(targetUser, Date.now());
      const accessThroughMs = canceled.length > 0 ? Math.max(...canceled.map((s) => s.periodEndMs)) : null;
      ctx.audit("commercial.subscription.canceled", "payments", {
        userId: targetUser,
        subscriptionIds: canceled.map((s) => s.id),
        accessThroughMs,
      });
      return Response.json({ userId: targetUser, canceled, accessThroughMs });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to cancel subscription" }, { status: 500 });
    }
  }

  // GET /payments/agentic/commercial/subscription?userId= — self or operator. Effective tier included:
  // the stored account tier alone does not say whether the user is Subscribed right now.
  if (path.endsWith("/payments/agentic/commercial/subscription") && request.method === "GET") {
    try {
      const login = commercialLogin();
      const userId = url.searchParams.get("userId") ?? "";
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      if (!userId) return Response.json({ error: "userId is required." }, { status: 400 });
      if (!canAccessAccount(login, userId)) {
        return Response.json({ error: "Forbidden: only the subscriber or a store operator may read a subscription." }, { status: 403 });
      }
      const store = requireStore();
      if (store instanceof Response) return store;
      const subs = requireSubs();
      if (subs instanceof Response) return subs;
      const ensured = await ensureStores(store, subs);
      if (ensured) return ensured;
      const account = await store.getAccount(userId);
      const subscriptions = await subs.listSubscriptions(userId);
      const effectiveTier = resolveEffectiveTier(account, subscriptions, Date.now());
      const current =
        subscriptions.length > 0
          ? subscriptions.reduce((a, b) => (b.periodEndMs > a.periodEndMs ? b : a))
          : null;
      return Response.json({ userId, effectiveTier, current, subscriptions });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to read subscription" }, { status: 500 });
    }
  }

  // Issue #2137: checkout UI support routes (commercial block, read-only
  // pricing + payment verification + goal-command builder). The UI never
  // hardcodes prices and never decides charging — the gate does. These
  // routes only expose server truth to the verified caller.
  //
  // GET /payments/agentic/commercial/pricing — server-truth family prices
  // (PROPOSED until owner approval), the monetization flag state, the
  // testnet-only marker, and the gate's failure policy, all from one
  // source so UI copy can never drift from the gate. Prices come
  // from the operator catalogue (#2185) when the store is bound;
  // the display fallback to the proposed seeds below is DISPLAY
  // ONLY — the gate never reads it and never charges from it, so
  // a store outage shows proposed prices instead of failing the
  // panel, but can never mint a charge. This GET never ensures
  // the schema (no writes on a read path).
  if (path.endsWith("/payments/agentic/commercial/pricing") && request.method === "GET") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const monetizationEnabled = await createFeatureFlagPort(ctx.env).isEnabled("monetization");
      let prices: Record<string, number> = { ...PROPOSED_SEED_PRICES };
      try {
        const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
        if (catalogue) {
          const entries = await catalogue.getAllPrices();
          if (entries.length > 0) {
            prices = Object.fromEntries(entries.map((e) => [e.family, e.priceUSD]));
          }
        }
      } catch {
        // Display fallback only (see above): keep the proposed seeds.
      }
      return Response.json({
        monetizationEnabled,
        prices,
        testnetOnly: true,
        failurePolicy: PAYMENT_DISCLOSURE,
      });
    } catch {
      return Response.json({ error: "Failed to read pricing." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/prices (operator only, #2185)
  // — the operator price upsert: changing a per-run price needs no
  // code deploy, because the gate reads the catalogue, not code.
  // Operator gating follows the commercial pattern above
  // (COMMERCIAL_STORE_OPERATORS, empty = deny all). A money write
  // path, so the schema is ensured first (migration 0010 seeds
  // the proposed defaults on a fresh store; the upsert then
  // overwrites exactly the family named). Invalid family or price
  // is 400; an unbound store is 503, never a silent no-op.
  if (path.endsWith("/payments/agentic/commercial/prices") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!isStoreOperator(login)) {
        return Response.json({ error: "Forbidden: store operator required." }, { status: 403 });
      }
      const body = (await request.json().catch(() => ({}))) as { family?: unknown; priceUSD?: unknown };
      const catalogue = createPriceCatalogueAdapter(ctx.env as { AGENT_DB?: unknown });
      if (!catalogue) {
        return Response.json({ error: "Price catalogue unavailable: AGENT_DB is not bound." }, { status: 503 });
      }
      try {
        await ensurePriceCatalogueSchema(catalogue.db);
      } catch (err: any) {
        return Response.json({ error: `Price catalogue unavailable: ${err.message || "unknown error"}` }, { status: 503 });
      }
      const entry = await catalogue.setPrice({ family: body.family, priceUSD: body.priceUSD });
      ctx.audit("commercial.price.set", "payments", { family: entry.family, priceUSD: entry.priceUSD });
      return Response.json({ entry });
    } catch (err: any) {
      const message = err.message || "Failed to set price";
      return Response.json({ error: message }, { status: /Invalid|must be/.test(message) ? 400 : 500 });
    }
  }

  // POST /payments/agentic/commercial/submission/check-payment — the
  // production mirror of the assurance check-payment, for REAL runs.
  // Re-reads cfpay checkout.status for requestId == runRequestId (the
  // gate's checkout id) and delivers payment_verified ONLY when
  // fulfilled. The wake-up event is never sent for an unfulfilled
  // checkout, and a Stripe return page is never proof (the gate
  // re-checks status itself). Ownership: runRequestId is unguessable,
  // the same standard as submission-status. A payment URL is returned
  // only when cfpay provides one; the UI must not invent one.
  if (path.endsWith("/payments/agentic/commercial/submission/check-payment") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as { runRequestId?: unknown };
      const runRequestId = typeof body.runRequestId === "string" ? body.runRequestId : "";
      if (!runRequestId) return Response.json({ error: "runRequestId is required." }, { status: 400 });
      const config = getCfpayConfig(ctx.env);
      if (!config) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
      const res = await cfpayA2AOperation(config, "/a2a/payments", "checkout.status", { requestId: runRequestId });
      if (!res.ok) return Response.json({ error: "Payment verification is temporarily unavailable." }, { status: 503 });
      const checkout = (res.data ?? {}) as {
        status?: unknown; state?: unknown; paid?: unknown;
        claimTxHash?: unknown; paymentIntentId?: unknown;
        checkoutUrl?: unknown; url?: unknown; paymentUrl?: unknown; checkout_url?: unknown;
      };
      const state = String(checkout.status ?? checkout.state ?? "").toLowerCase();
      const paid = state === "fulfilled" || state === "paid" || checkout.paid === true;
      const paymentUrl = [checkout.checkoutUrl, checkout.url, checkout.paymentUrl, checkout.checkout_url].find(
        (v) => typeof v === "string" && v.length > 0
      ) as string | undefined;
      if (!paid) {
        return Response.json({ runRequestId, paid: false, state: state || "unknown", paymentUrl: paymentUrl ?? null });
      }
      const binding = ctx.env.PAYMENT_WORKFLOW as unknown as PaymentWorkflowBinding | undefined;
      if (!binding || typeof binding.get !== "function") {
        return Response.json({ runRequestId, paid: true, delivered: false, state });
      }
      try {
        const host: PaymentWorkflowHost = {
          runWorkflow: async (_bindingName: string, params: unknown) => {
            const started = await startPaymentWorkflowViaBinding(binding, params as never);
            return { id: started.workflowId };
          },
          sendWorkflowEvent: async (_bindingName: string, workflowId: string, event: { type: string; payload: unknown }) => {
            const instance = await binding.get(workflowId);
            if (!instance || typeof instance.sendEvent !== "function") {
              throw new Error("Workflow binding cannot deliver events.");
            }
            await instance.sendEvent(event);
          },
        };
        await deliverPaymentVerifiedViaHost(host, runRequestId, {
          claimTxHash: typeof checkout.claimTxHash === "string" ? checkout.claimTxHash : undefined,
          paymentIntentId: typeof checkout.paymentIntentId === "string" ? checkout.paymentIntentId : undefined,
        });
        return Response.json({ runRequestId, paid: true, delivered: true, state });
      } catch {
        return Response.json({ runRequestId, paid: true, delivered: false, state });
      }
    } catch {
      return Response.json({ error: "Failed to check payment." }, { status: 500 });
    }
  }

  // POST /payments/agentic/commercial/goal-command — minimal server-side
  // builder for the checkout UI's goal path. GoalScreenCommand requires
  // a server-built scenario, which the client cannot construct, so this
  // route builds it from goalKind/direction via the same builders the
  // server submission path uses. It starts NOTHING — it only returns a
  // screenerCommand the caller then submits via the paid route (which
  // enforces the gate). userLogin is the verified login, never a
  // caller claim.
  if (path.endsWith("/payments/agentic/commercial/goal-command") && request.method === "POST") {
    try {
      const login = commercialLogin();
      if (!login) return Response.json({ error: "Unauthorized: verified login required." }, { status: 401 });
      const body = (await request.json().catch(() => ({}))) as {
        jobId?: unknown; goalKind?: unknown; direction?: unknown; symbols?: unknown; tenantId?: unknown;
      };
      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      const goalKind = typeof body.goalKind === "string" ? body.goalKind : "";
      const direction = typeof body.direction === "string" ? body.direction : "";
      const tenantId = typeof body.tenantId === "string" ? body.tenantId : "";
      const symbols = Array.isArray(body.symbols)
        ? body.symbols.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : undefined;
      if (!jobId) return Response.json({ error: "jobId is required." }, { status: 400 });
      if (!(goalKind in GOAL_TAXONOMY)) return Response.json({ error: "goalKind is not a known goal kind." }, { status: 400 });
      if (!["bullish", "bearish", "range_bound", "volatile", "unknown"].includes(direction)) {
        return Response.json({ error: "direction must be bullish, bearish, range_bound, volatile, or unknown." }, { status: 400 });
      }
      const scenario = buildScenario({
        goalKind: goalKind as keyof typeof GOAL_TAXONOMY,
        portfolioRef: { kind: "hypothetical" },
        direction: direction as "bullish" | "bearish" | "range_bound" | "volatile" | "unknown",
      });
      const screenerCommand = buildGoalScreenCommand({
        jobId,
        source: "manual",
        trigger: "manual",
        userLogin: login,
        tenantId: tenantId || undefined,
        scenario,
        scenarioSource: "built",
        symbols,
      });
      return Response.json({ screenerCommand });
    } catch {
      return Response.json({ error: "Failed to build goal command." }, { status: 500 });
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
