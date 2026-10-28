/**
 * Issue #2059: LIVE PaymentWorkflow assurance routes (no fake seams).
 *
 * These routes test the live deployed PaymentWorkflow end-to-end
 * with test inputs. Unlike the browser simulation in
 * PaymentWorkflowAssurance.tsx (fake step/cfpay/screener), every
 * step here is real: a real workflow instance is created through
 * the PAYMENT_WORKFLOW binding, the real gate evaluates, real
 * approval/verified events are delivered through the binding, the
 * real cfpay checkout.status is re-read, and a completed run
 * really starts ScreenerScreenWorkflow through the workflow port.
 *
 * What is "test" here is only the INPUT: run ids are
 * live-test-prefixed, the screener command carries environment
 * TEST, and the account is a synthetic test account (coverage or
 * pay-per-use). Nothing about the workflow, the binding, the
 * gate, or the screener start is simulated.
 *
 * Guards (all fail closed):
 * - payment_assurance flag must be ON (FeatureFlagPort).
 * - Caller identity comes from x-user-login / execution context,
 *   never from the request body.
 * - Live endpoints additionally require the caller login to be
 *   listed in PAYMENT_ASSURANCE_LIVE_LOGINS (comma-separated
 *   Worker var). Empty/missing = deny all. This endpoint can
 *   start real screener runs and mint real cfpay checkouts, so
 *   it is never open to every signed-in user.
 * - Event/status/check-payment endpoints only accept
 *   live-test-prefixed workflow ids, so they can never poke a
 *   production workflow instance.
 * - Checkout mode additionally requires MONETIZATION_ENABLED=true
 *   and a configured cfpay key in the deployed env; otherwise it
 *   returns 409 naming the missing piece instead of silently
 *   running the free path. The gate's testnet-only network guard
 *   still applies inside the workflow.
 *
 * Handler shape follows the other route modules (payments.ts):
 * returns a Response when a path matches, null otherwise, and is
 * invoked from OrchestratorAgent.routeRequest in sequence.
 */

import { createFeatureFlagPort } from "../../features/createFeatureFlagPort";
import { buildScenario } from "../../services/goalScenarioEngine";
import { buildGoalScreenCommand } from "../../services/goalScreenWorkflowSubmission";
import { cfpayA2AOperation, getCfpayConfig } from "../../services/cfpayA2A";
import type { CommercialAccount } from "../../services/cfpayMonetization";
import {
  buildPaymentWorkflowParams,
  deliverPaymentApprovalViaHost,
  deliverPaymentVerifiedViaHost,
  startPaymentWorkflowViaBinding,
  type PaymentWorkflowBinding,
  type PaymentWorkflowHost,
} from "../../services/paymentWorkflowSubmission";

export interface PaymentAssuranceLiveContext {
  env: unknown;
  getUserLogin?: () => string | undefined;
}

type EnvRecord = Record<string, unknown>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envRecord(ctx: PaymentAssuranceLiveContext): EnvRecord {
  return (ctx.env ?? {}) as EnvRecord;
}

function callerLogin(request: Request, ctx: PaymentAssuranceLiveContext): string | null {
  const login = request.headers.get("x-user-login")?.trim() || ctx.getUserLogin?.()?.trim() || "";
  return login ? login : null;
}

function liveLogins(env: EnvRecord): string[] {
  const raw = env.PAYMENT_ASSURANCE_LIVE_LOGINS;
  if (typeof raw !== "string") return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function guard(request: Request, ctx: PaymentAssuranceLiveContext): Promise<{ login: string } | Response> {
  const env = envRecord(ctx);
  const flagOn = await createFeatureFlagPort(ctx.env).isEnabled("payment_assurance");
  if (!flagOn) {
    return json({ error: "payment_assurance flag is OFF; live testing is disabled." }, 403);
  }
  const login = callerLogin(request, ctx);
  if (!login) {
    return json({ error: "Missing caller identity (x-user-login); refusing to start a live test run." }, 401);
  }
  if (!liveLogins(env).includes(login)) {
    return json({ error: `Live testing is not configured for this login. Ask the owner to add it to PAYMENT_ASSURANCE_LIVE_LOGINS.` }, 403);
  }
  return { login };
}

function testEmailFor(login: string): string {
  // Test-run marker address, never a real user's address. The
  // local part is sanitized so any login shape stays a valid
  // email format for checkout.create.
  const local = login.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tester";
  return `${local}@assurance-test.local`;
}

function bindingFrom(env: EnvRecord): PaymentWorkflowBinding | undefined {
  const binding = env.PAYMENT_WORKFLOW as PaymentWorkflowBinding | undefined;
  return binding && typeof binding.create === "function" ? binding : undefined;
}

function bindingHost(binding: PaymentWorkflowBinding): PaymentWorkflowHost {
  return {
    runWorkflow: async (_bindingName: string, params: unknown) => {
      const started = await startPaymentWorkflowViaBinding(binding, params as never);
      return { id: started.workflowId };
    },
    sendWorkflowEvent: async (_bindingName: string, workflowId: string, event: { type: string; payload: unknown }) => {
      const instance = await binding.get(workflowId);
      if (!instance || typeof instance.sendEvent !== "function") {
        throw new Error(`Workflow binding cannot deliver events to instance ${workflowId}.`);
      }
      await instance.sendEvent(event);
    },
  };
}

function isLiveTestId(workflowId: unknown): workflowId is string {
  return typeof workflowId === "string" && workflowId.startsWith("live-test-");
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function handleStart(request: Request, ctx: PaymentAssuranceLiveContext, login: string): Promise<Response> {
  const env = envRecord(ctx);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400);
  const mode = body.mode;
  if (mode !== "coverage" && mode !== "checkout") {
    return json({ error: "mode must be \"coverage\" or \"checkout\"." }, 400);
  }
  const scheduleKind = body.scheduleKind ?? "one_off";
  if (scheduleKind !== "one_off" && scheduleKind !== "recurring") {
    return json({ error: "scheduleKind must be \"one_off\" or \"recurring\"." }, 400);
  }
  const authorizedAtSubmission = body.authorizedAtSubmission === true;

  const monetizationEnabled = env.MONETIZATION_ENABLED === "true";
  const cfpay = getCfpayConfig(env);
  if (mode === "checkout") {
    if (!monetizationEnabled) {
      return json({ error: "Checkout-mode live test refused: MONETIZATION_ENABLED is not \"true\" in the deployed env." }, 409);
    }
    if (!cfpay) {
      return json({ error: "Checkout-mode live test refused: cfpay is not configured (CFPAY_URL / token missing in the deployed env)." }, 409);
    }
  }

  const runRequestId = `live-test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const tenantId = "primary";
  const email = testEmailFor(login);
  const account: CommercialAccount =
    mode === "coverage"
      ? { userId: login, email, tenantId, tier: "Subscribed", creditsUSD: 0, includedRunsRemaining: 1 }
      : { userId: login, email, tenantId, tier: "PayPerUse", creditsUSD: 0, includedRunsRemaining: 0 };
  const scenario = buildScenario({
    goalKind: "income",
    portfolioRef: { kind: "hypothetical" },
    direction: "bullish",
  });
  const screenerCommand = buildGoalScreenCommand({
    jobId: `goal-screen:live-test:${runRequestId}`,
    source: "payment-assurance-live",
    trigger: "scheduled",
    userLogin: login,
    tenantId,
    scenario,
    scenarioSource: "built",
    environment: "TEST",
  });
  const params = buildPaymentWorkflowParams({
    runRequestId,
    family: "goal",
    trigger: "scheduled",
    scheduleKind,
    authorizedAtSubmission,
    tenantId,
    userId: login,
    email,
    account,
    screenerCommand,
  });
  const binding = bindingFrom(env);
  if (!binding) {
    return json({ error: "PAYMENT_WORKFLOW binding is not configured; refusing to start a live test run." }, 503);
  }
  try {
    const started = await startPaymentWorkflowViaBinding(binding, params);
    console.log(`[payment-assurance-live] started run=${runRequestId} workflow=${started.workflowId} mode=${mode} login=${login}`);
    return json({
      workflowId: started.workflowId,
      runRequestId,
      screenerJobId: screenerCommand.jobId,
      mode,
      scheduleKind,
      authorizedAtSubmission,
      monetizationEnabled,
      cfpayConfigured: Boolean(cfpay),
      testAccountTier: account.tier,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleEvent(request: Request, ctx: PaymentAssuranceLiveContext, login: string): Promise<Response> {
  const env = envRecord(ctx);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400);
  if (!isLiveTestId(body.workflowId)) {
    return json({ error: "Only live-test workflow ids can receive events through this endpoint." }, 403);
  }
  const binding = bindingFrom(env);
  if (!binding) return json({ error: "PAYMENT_WORKFLOW binding is not configured." }, 503);
  const host = bindingHost(binding);
  try {
    if (body.type === "approval") {
      if (typeof body.approved !== "boolean") {
        return json({ error: "approval events require a boolean \"approved\" field." }, 400);
      }
      await deliverPaymentApprovalViaHost(host, body.workflowId, {
        approved: body.approved,
        approverId: typeof body.approverId === "string" ? body.approverId : login,
      });
    } else if (body.type === "payment_verified") {
      await deliverPaymentVerifiedViaHost(host, body.workflowId, {
        claimTxHash: typeof body.claimTxHash === "string" ? body.claimTxHash : undefined,
        paymentIntentId: typeof body.paymentIntentId === "string" ? body.paymentIntentId : undefined,
      });
    } else {
      return json({ error: "type must be \"approval\" or \"payment_verified\"." }, 400);
    }
    console.log(`[payment-assurance-live] event type=${body.type} workflow=${body.workflowId} login=${login}`);
    return json({ delivered: true, workflowId: body.workflowId, type: body.type });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleStatus(_request: Request, url: URL, ctx: PaymentAssuranceLiveContext): Promise<Response> {
  const env = envRecord(ctx);
  const workflowId = url.searchParams.get("workflowId");
  if (!isLiveTestId(workflowId)) {
    return json({ error: "Only live-test workflow ids can be queried through this endpoint." }, 403);
  }
  const binding = bindingFrom(env);
  let instanceStatus: unknown = "unknown";
  if (binding) {
    try {
      const instance = await binding.get(workflowId);
      const statusFn = (instance as { status?: unknown }).status;
      if (typeof statusFn === "function") {
        const result: unknown = await (statusFn as () => Promise<unknown>).call(instance);
        instanceStatus =
          typeof result === "string"
            ? result
            : result && typeof result === "object" && typeof (result as { status?: unknown }).status === "string"
              ? (result as { status: string }).status
              : result ?? "unknown";
      }
    } catch {
      instanceStatus = "unknown";
    }
  }
  let checkout: unknown = null;
  const cfpay = getCfpayConfig(env);
  if (cfpay) {
    try {
      const res = await cfpayA2AOperation(cfpay, "/a2a/payments", "checkout.status", { requestId: workflowId });
      checkout = res.ok ? res.data : { error: res.error ?? "checkout.status failed" };
    } catch (err) {
      checkout = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return json({ workflowId, instanceStatus, checkout });
}

async function handleCheckPayment(request: Request, ctx: PaymentAssuranceLiveContext): Promise<Response> {
  const env = envRecord(ctx);
  const body = await readBody(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400);
  if (!isLiveTestId(body.workflowId)) {
    return json({ error: "Only live-test workflow ids can be checked through this endpoint." }, 403);
  }
  const cfpay = getCfpayConfig(env);
  if (!cfpay) {
    return json({ error: "cfpay is not configured in the deployed env; cannot re-read checkout status." }, 409);
  }
  const binding = bindingFrom(env);
  if (!binding) return json({ error: "PAYMENT_WORKFLOW binding is not configured." }, 503);
  let checkoutRecord: Record<string, unknown> | null = null;
  try {
    const res = await cfpayA2AOperation(cfpay, "/a2a/payments", "checkout.status", { requestId: body.workflowId });
    if (!res.ok) return json({ delivered: false, checkout: { error: res.error ?? "checkout.status failed" } });
    checkoutRecord = (res.data ?? {}) as Record<string, unknown>;
  } catch (err) {
    return json({ delivered: false, checkout: { error: err instanceof Error ? err.message : String(err) } });
  }
  // Mirror the gate's fulfilled test (confirmPaid): fulfilled, paid,
  // or paid === true. Anything else delivers nothing — the wake-up
  // event is never sent for an unfulfilled checkout.
  const state = String(checkoutRecord?.status ?? checkoutRecord?.state ?? "").toLowerCase();
  const fulfilled = state === "fulfilled" || state === "paid" || checkoutRecord?.paid === true;
  if (!fulfilled) {
    return json({ delivered: false, checkout: checkoutRecord, reason: "Checkout is not fulfilled; no payment_verified event was delivered." });
  }
  try {
    await deliverPaymentVerifiedViaHost(bindingHost(binding), body.workflowId, {
      claimTxHash: typeof checkoutRecord?.claimTxHash === "string" ? checkoutRecord.claimTxHash : undefined,
      paymentIntentId: typeof checkoutRecord?.paymentIntentId === "string" ? checkoutRecord.paymentIntentId : undefined,
    });
    return json({ delivered: true, workflowId: body.workflowId, checkout: checkoutRecord });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

export async function handlePaymentAssuranceLiveRoutes(
  request: Request,
  url: URL,
  path: string,
  _sessionId: string | undefined,
  ctx: PaymentAssuranceLiveContext,
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (method === "POST" && path.endsWith("/api/assurance/payment-workflow/start")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleStart(request, ctx, guarded.login);
  }
  if (method === "POST" && path.endsWith("/api/assurance/payment-workflow/event")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleEvent(request, ctx, guarded.login);
  }
  if (method === "GET" && path.endsWith("/api/assurance/payment-workflow/status")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleStatus(request, url, ctx);
  }
  if (method === "POST" && path.endsWith("/api/assurance/payment-workflow/check-payment")) {
    const guarded = await guard(request, ctx);
    if (guarded instanceof Response) return guarded;
    return handleCheckPayment(request, ctx);
  }
  return null;
}
