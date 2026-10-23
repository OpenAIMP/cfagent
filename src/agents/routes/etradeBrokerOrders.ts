/**
 * Issue #995: E*TRADE broker route sub-domain module, split out of
 * src/agents/routes/etradeBroker.ts to restore the #359 <50 KB route
 * module target. Pure move — no behavior change.
 *
 * The dispatcher in etradeBroker.ts owns every route condition (the
 * #359 extraction pins and the thin-router inventory anchor the
 * conditions, the schema-parse calls, and the ETradeService
 * construction sites to that file); this module owns the order preview / execute completion (HITL tails)
 * handler bodies it delegates to. Each function is invoked only after
 * its route condition has matched, and returns the Response the
 * original inline block returned.
 */

import { ETradeSlackTradingService } from "../../trading";
import { ETradeBrowserService } from "../../services/browserAgent";
import type { EtradeBrokerRouteContext } from "./etradeBroker";
import type { ETradeService } from "../../services/etrade";
import type { PolicyVerdict } from "../../services/riskPolicyEngine";

export async function completeEtradeOrderPreview(args: {
  ctx: EtradeBrokerRouteContext;
  sessionId: string;
  preview: any;
  userLogin: string;
  requestedEnv: "TEST" | "PROD" | undefined;
}): Promise<Response> {
  const { ctx, sessionId, preview, userLogin, requestedEnv } = args;
  ctx.audit("etrade.order_previewed", "trading", {
    orderId: preview.orderId,
    symbol: preview.symbol,
    orderAction: preview.orderAction,
    quantity: preview.quantity,
    estimatedTotal: preview.estimatedTotal,
    proposerDid: preview.proposerDid,
  });

  // Autopilot policy envelope (autopilot Phase 1). Evaluated server-side
  // and recorded with a signed verdict. Paused ⇒ advisory (the human
  // authorizer still decides); running ⇒ hard gate, re-checked at execute.
  try {
    const evaluated = await ctx.evaluateAndRecordAutopilotVerdict({
      userLogin,
      requestedEnv,
      sessionId,
      draftId: preview.orderId,
      intent: {
        symbol: preview.symbol,
        action: preview.orderAction,
        quantity: preview.quantity,
        orderType: preview.orderType,
        estimatedPrice: typeof preview.estimatedPrice === "number" ? preview.estimatedPrice : null,
        estimatedTotal: typeof preview.estimatedTotal === "number" ? preview.estimatedTotal : null,
      },
    });
    (preview as any).policyVerdict = evaluated.verdict;
    if (!evaluated.verdict.executionAllowed) {
      return Response.json(
        {
          error: `Autopilot policy blocked this order: ${evaluated.verdict.detail}`,
          bindingRule: evaluated.verdict.bindingRule,
          policyVerdict: evaluated.verdict,
        },
        { status: 409 }
      );
    }
  } catch (policyErr) {
    console.warn("[OrchestratorAgent] Autopilot policy evaluation failed at preview:", policyErr);
    ctx.audit("autopilot.policy_check_failed", "trading", {
      stage: "preview",
      orderId: preview.orderId,
      error: policyErr instanceof Error ? policyErr.message : String(policyErr),
    });
    if (ctx.getAutopilotState().running) {
      return Response.json(
        { error: "Autopilot policy check could not be completed; refusing to preview while autopilot is running." },
        { status: 503 }
      );
    }
  }

  // Schedule a 15-minute expiration timer (900 seconds) for this draft
  try {
    const expSchedule = await ctx.schedule(900, "expireStaleOrderDraft", { orderId: preview.orderId, userLogin });
    if (expSchedule?.id) {
      preview.expirationScheduleId = expSchedule.id;
      preview.expiresAt = new Date(Date.now() + 900 * 1000).toISOString();
      ctx.getOrm().trades?.update(preview.orderId, {
        expirationScheduleId: expSchedule.id,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (schedErr) {
    console.warn("[OrchestratorAgent] Note: could not schedule expiration timer:", schedErr);
  }

  // Dispatch Pre-Trade Approval Ticket Block Kit card to Slack (Strict HITL Gate)
  try {
    const slackService = new ETradeSlackTradingService(ctx.env, ctx.getOrm(), sessionId);
    await slackService.sendPreTradeApprovalTicket({
      orderId: preview.orderId,
      symbol: preview.symbol,
      action: preview.orderAction as any,
      quantity: preview.quantity,
      orderType: preview.orderType as any,
      limitPrice: preview.limitPrice,
      estimatedPrice: preview.estimatedPrice,
      estimatedTotal: preview.estimatedTotal,
      proposerDid: preview.proposerDid,
      expiresAt: preview.expiresAt,
    });
  } catch (slackErr) {
    console.warn("[OrchestratorAgent] Note: could not dispatch Slack pre-trade ticket:", slackErr);
  }

  return Response.json(preview);
}

export async function completeEtradeOrderExecution(args: {
  ctx: EtradeBrokerRouteContext;
  sessionId: string;
  body: any;
  orderId: string;
  decision: "approved" | "rejected" | undefined;
  userLogin: string;
  userDid: string;
  existingRecord: any;
  symbol: string;
  action: any;
  quantity: number;
  orderType: string;
  limitPrice: number | undefined;
  strategyOrder: any;
  executionVerdict: PolicyVerdict | null;
  etrade: ETradeService;
}): Promise<Response> {
  const { ctx, sessionId, body, orderId, decision, userLogin, userDid, existingRecord, symbol, action, quantity, orderType, limitPrice, strategyOrder, executionVerdict, etrade } = args;
  let result: any;

  if (ctx.env.ETRADE_CONSUMER_KEY || ctx.env.ETRADE_MCP_SERVER_URL || ctx.env.ET_API_KEY) {
    result = await etrade.placeOrderRemote({
      orderId,
      symbol,
      action,
      quantity,
      orderType,
      limitPrice,
      previewId: body.previewId && String(body.previewId).trim() !== ""
        ? String(body.previewId).trim()
        : existingRecord?.orderRef && String(existingRecord.orderRef).trim() !== ""
        ? String(existingRecord.orderRef).trim()
        : undefined,
      optionLegs: strategyOrder?.optionLegs,
      strategyNetDebit: strategyOrder?.strategyNetDebit,
      userLogin,
    });
    if (result.success && ctx.getOrm().trades) {
      ctx.getOrm().trades.update(orderId, {
        status: "executed",
        orderRef: result.executionId,
        authorizerDid: userDid,
        updatedAt: new Date().toISOString(),
      });
      ctx.incrementAutopilotOrdersToday();
    }
  } else {
    result = etrade.executeOrder(orderId, userDid, decision);
  }

  // Cancel the scheduled expiration timer since the order has been executed
  if (existingRecord.expirationScheduleId) {
    try {
      await ctx.cancelSchedule(existingRecord.expirationScheduleId);
    } catch {
      // Ignore cancel error if already triggered
    }
  }

  ctx.audit("etrade.order_executed", "trading", {
    orderId,
    decision,
    authorizerDid: userDid,
    status: result.status,
    executionId: result.executionId,
    policyVerdictId: executionVerdict?.verdictId ?? null,
  });

  // Automatically dispatch official transaction snap to Slack via ETradeBrowserService
  if (result.status === "executed" || result.success) {
    try {
      const browserService = new ETradeBrowserService(ctx.env);
      await browserService.sendTransactionSnapToSlack({
        transactionId: orderId,
        symbol,
        action,
        quantity,
        price: existingRecord.price || (typeof limitPrice === "number" ? limitPrice : 0),
        orderType,
        status: "EXECUTED",
        totalValue: existingRecord.totalValue || (quantity * (existingRecord.price || 0)),
        environment: (ctx.env.ETRADE_ENVIRONMENT || "sandbox").toLowerCase(),
        timestamp: new Date().toISOString(),
        // This route is the HITL authorize/execute gate: execution
        // here means the session user submitted decision "approved"
        // for this draft (issue #120).
        humanApproved: decision === "approved",
      });
    } catch (snapErr) {
      console.warn("[OrchestratorAgent] Note: could not send transaction snap to Slack:", snapErr);
    }
  }

  return Response.json(result);
}
