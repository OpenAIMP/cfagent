/**
 * Issue #359-09: E*TRADE broker routes extracted from OrchestratorAgent.routeRequest
 * (src/agents/orchestrator.ts). Pure move - no behavior change.
 *
 * Owns the E*TRADE broker route blocks:
 * 1. "Environment & E*TRADE Trading APIs": the environment switcher (#314,
 *    both spellings - /environment/switch and /broker/etrade/environment -
 *    delegate to the single-owner handleEnvironmentSwitch, moved here with
 *    the block), broker status, diagnostics, accounts, equity screener,
 *    quote, order preview/execute (with the autopilot policy envelope,
 *    expiration scheduling, and pre-trade Slack approval ticket), positions,
 *    portfolio-risk (aggregate / evaluate / correlation / size), think
 *    evaluation, hedge analysis, and orders listing / remote fetch / cancel.
 * 2. The broker account-activity block: transactions list + details, alerts
 *    inbox + details + delete, and product lookup. It was non-contiguous
 *    with block 1 (the omnichannel trading channels block sat between
 *    them), so this module exports TWO handlers - handleEtradeBrokerRoutes
 *    and handleEtradeBrokerActivityRoutes - each invoked from routeRequest
 *    at the EXACT position its block occupied in the sequential
 *    path.endsWith matching sequence.
 *
 * Each handler returns a Response when one of its paths matches, or null
 * when none does (the orchestrator then continues its sequential matching).
 * Every handler ends with an explicit `return null` - never undefined.
 *
 * Sibling slice (#359-11) owns the /etrade/options/* and
 * /trading/options/* blocks; those were NOT moved here.
 *
 * Handlers that used OrchestratorAgent state receive it via the explicit
 * EtradeBrokerRouteContext parameter; there are no new globals and no
 * back-references into the class.
 */

import {
  computePortfolioRisk,
  aggregatePortfolioRisk,
  resolvePositionsSnapshot,
  evaluatePostTradeTotals,
  type CandidateGreekContribution,
} from "../../services/portfolioRisk";
import { ETradeThinkHarness } from "../../services/thinkHarness";
import { assessPortfolioConcentration } from "../../services/portfolioConcentration";
import {
  sizeCandidateAgainstPortfolio,
  type SizingCandidate,
} from "../../services/positionSizing";
import { generateHedgeProposals } from "../../services/hedgeProposals";
import { sharedCorrelationService } from "../../services/correlationService";
import { ETradeService } from "../../services/etrade";
import { resolveEnvironmentConfig } from "../../config/environment";
import { getValidTokens } from "../../security/etradeOAuth";
import { ETradeRestClient, ETradeSlackTradingService } from "../../trading";
import { ETradeBrowserService } from "../../services/browserAgent";
import { publishScreenerCompleted, publishScreenerFailed } from "../../events/screenerPublishers";
import type { ScreenerRunResult } from "../screener-agent";
import { getUserDid } from "../did";
import type { AgentName, Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import type { ScreenerAgent } from "../screener-agent";
import type {
  OrderIntent,
  PolicyVerdict,
  PolicyVerdictAttestation,
} from "../../services/riskPolicyEngine";
import type { Schedule } from "agents";

/** The subset of OrchestratorAgent surface the E*TRADE broker handlers need. */
export interface EtradeBrokerRouteContext {
  /** Worker environment (owner: OrchestratorAgent - was `this.env`). */
  env: Env;
  /** ORM accessor (owner: OrchestratorAgent - was `this.getOrm()`). */
  getOrm(): DatabaseORM;
  /** Audit writer (owner: OrchestratorAgent - was `this.audit`). */
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  /** Screener agent (owner: OrchestratorAgent - was `this.getScreenerAgent()`). */
  getScreenerAgent(userLogin?: string): ScreenerAgent;
  /** Canonical-copy screener persistence (owner: OrchestratorAgent - was `this.persistScreenerReportCanonical`). */
  persistScreenerReportCanonical(result: {
    timestamp: string;
    universe?: unknown;
    sector?: unknown;
    success: boolean;
    totalScanned: number;
    matchedCount: number;
    opportunities: unknown[];
    allStocks: unknown[];
    error?: string;
    trigger?: unknown;
  }): void;
  /** Autopilot policy evaluation (owner: OrchestratorAgent - was `this.evaluateAndRecordAutopilotVerdict`). */
  evaluateAndRecordAutopilotVerdict(params: {
    userLogin: string;
    requestedEnv: unknown;
    sessionId: string;
    intent: OrderIntent;
    draftId?: string | null;
    dryRun?: boolean;
  }): Promise<{ verdict: PolicyVerdict; attestation: PolicyVerdictAttestation }>;
  /** Autopilot state (owner: OrchestratorAgent - was `this.getAutopilotState()`). */
  getAutopilotState(): { running: boolean };
  /** Autopilot order counter (owner: OrchestratorAgent - was `this.incrementAutopilotOrdersToday()`). */
  incrementAutopilotOrdersToday(): void;
  /** SDK scheduler (owner: OrchestratorAgent - was `this.schedule`). */
  schedule(when: number, callback: string, payload: any): Promise<Schedule>;
  /** SDK schedule cancellation (owner: OrchestratorAgent - was `this.cancelSchedule`). */
  cancelSchedule(id: string): Promise<boolean>;
}

async function publishManualScreenerRun(
  env: Env,
  orm: DatabaseORM,
  userLogin: string,
  result: ScreenerRunResult,
): Promise<void> {
  const deps = { env, orm, userLogin };
  if (!result.success) {
    await publishScreenerFailed(deps, {
      type: "screener.failed",
      timestamp: result.timestamp,
      universe: result.universe,
      trigger: "manual",
      deliveryId: `manual:${result.timestamp}:${result.universe}`,
      sector: result.sector,
      error: result.error || "E*TRADE unavailable",
    });
    return;
  }
  await publishScreenerCompleted(deps, {
    type: "screener.completed",
    timestamp: result.timestamp,
    universe: result.universe,
    trigger: "manual",
    expectedCount: result.expectedCount,
    pdfKey: result.pdfKey,
    deliveryId: `manual:${result.timestamp}:${result.universe}`,
    sector: result.sector,
    totalScanned: result.totalScanned,
    matchedCount: result.matchedCount,
    opportunities: result.opportunities,
  });
}

/**
 * Issue #314 — single-owner handler for the environment switcher.
 * Both spellings (`/environment/switch` and the advertised
 * `/broker/etrade/environment` from ETradeDynamicMenu.tsx) delegate here,
 * so the request/response contract, validation, and auth are identical.
 */
export async function handleEnvironmentSwitch(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const requested = String(body.environment || "PROD").toUpperCase().trim();
    if (requested === "TEST" || requested === "PROD") {
      return Response.json({ success: true, environment: requested });
    }
    return Response.json({ error: "Invalid environment. Expected TEST or PROD." }, { status: 400 });
  } catch (err) {
    return Response.json({ error: "Failed to switch environment" }, { status: 500 });
  }
}

/**
 * Handles the E*TRADE broker routes (Environment & E*TRADE Trading APIs
 * block). Returns a Response on match, null when no broker path matches
 * (the orchestrator then continues its sequential matching).
 */
export async function handleEtradeBrokerRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: EtradeBrokerRouteContext
): Promise<Response | null> {
  // ==========================================
  // Environment & E*TRADE Trading APIs
  // ==========================================

  const rawEnvHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
  const requestedEnv: "TEST" | "PROD" | undefined = (rawEnvHeader === "TEST" || rawEnvHeader === "PROD") ? rawEnvHeader : undefined;

  // Environment Switcher API (allows client to toggle between Sandbox TEST and Live PROD)
  // Issue #314: the advertised /api/broker/etrade/environment spelling
  // (ETradeDynamicMenu.tsx fallback) delegates to the same single-owner
  // handler, so both spellings share one contract.
  if (path.endsWith("/environment/switch") && request.method === "POST") {
    return handleEnvironmentSwitch(request);
  }
  if (path.endsWith("/broker/etrade/environment") && request.method === "POST") {
    return handleEnvironmentSwitch(request);
  }

  // Broker status & account metadata
  if (path.endsWith("/etrade/status") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const status = await etrade.getStatusAsync();
      return Response.json(status);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch broker status" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API Diagnostics
  if (path.endsWith("/etrade/diagnostics") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const envConfig = resolveEnvironmentConfig(ctx.env, requestedEnv);
      const valid = await getValidTokens(ctx.env, userLogin, requestedEnv);
      const client = new ETradeRestClient(ctx.env, userLogin, requestedEnv);

      let accounts: any[] = [];
      let balance: any = null;
      let lastError: string | null = null;

      if (valid) {
        accounts = await client.fetchAccounts();
        lastError = client.getLastError() || null;
        if (accounts.length > 0) {
          const key = accounts[0].accountKey || accounts[0].accountId;
          balance = await client.fetchBalance(key);
        }
      } else {
        lastError = client.getLastError() || `No active OAuth session in [${envConfig.name}] mode. Click 'Connect E*TRADE Account'.`;
      }

      return Response.json({
        status: accounts.length > 0 ? "healthy" : (valid ? "upstream_error" : "auth_required"),
        environment: envConfig.name,
        isLive: envConfig.isLive,
        apiUrl: envConfig.etrade.baseUrl,
        userLogin,
        credentials: {
          apiKeyConfigured: Boolean(envConfig.etrade.apiKey),
          apiKeyMasked: envConfig.etrade.apiKey ? `${envConfig.etrade.apiKey.slice(0, 4)}...${envConfig.etrade.apiKey.slice(-4)}` : "MISSING",
          apiSecretConfigured: Boolean(envConfig.etrade.apiSecret),
        },
        oauthToken: {
          present: Boolean(valid),
          storedAt: valid?.storedAt || null,
          environment: valid?.environment || envConfig.name,
          validUntilMidnightEt: "E*TRADE access tokens expire at midnight US Eastern Time",
        },
        upstreamAccounts: {
          count: accounts.length,
          accounts,
        },
        upstreamBalance: balance,
        lastError,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return Response.json({ error: err.message || "Failed to run diagnostics" }, { status: 500 });
    }
  }

  // Broker Accounts List (Real E*TRADE REST / OAuth 1.0a)
  if (path.endsWith("/etrade/accounts") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const accounts = await etrade.fetchAccountsRemote();
      return Response.json({ count: accounts.length, accounts });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch accounts" }, { status: 500 });
    }
  }

  // Market Screener & Scanning — delegated to ScreenerAgent (#261).
  // One agent, E*TRADE-only market data, honest failure when unavailable.
  // (The Nasdaq-listings screenLive path is kept in the repo, unwired.)
  if (path.endsWith("/etrade/screen") && (request.method === "POST" || request.method === "GET")) {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
      if (request.method === "GET") {
        if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
        if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
        if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
        if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
        if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
        if (url.searchParams.get("universe")) filters.universe = url.searchParams.get("universe");
      }
      // Issue #270: universe selection; "ALL" auto-shards into parallel runs.
      // Issue #289: default to NASDAQ100 (deterministic top-100) instead of
      // TECH (fuzzy keyword match with unpredictable symbol count).
      const universe = (filters.universe as string) || "NASDAQ100";
      const agent = ctx.getScreenerAgent(userLogin);
      if (universe === "ALL") {
        const shards = await agent.runSharded({ trigger: "manual", filters, userLogin, environment: requestedEnv });
        const orm = ctx.getOrm();
        for (const shard of shards) {
          await publishManualScreenerRun(ctx.env, orm, userLogin, shard);
        }
        const failed = shards.filter((r) => !r.success);
        if (failed.length === shards.length) {
          return Response.json({ error: failed[0]?.error || "E*TRADE unavailable" }, { status: 502 });
        }
        ctx.audit("etrade.screened", "trading", {
          filterSummary: `ALL (sharded: ${shards.length} universes)`,
          count: shards.reduce((n, r) => n + r.allStocks.length, 0),
          success: true,
        });
        // Issue #307/#308: store each shard's canonical report copy
        // (one row per generation) so manual screens are searchable.
        for (const r of shards) ctx.persistScreenerReportCanonical(r);
        return Response.json({
          sharded: true,
          universes: shards.map((r) => ({
            universe: r.universe,
            totalScanned: r.totalScanned,
            matchedCount: r.matchedCount,
            opportunities: r.opportunities,
            stocks: r.allStocks,
            discoveryMessage: r.discoveryMessage,
            scannedAt: r.timestamp,
            reportUrl: r.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(r.pdfKey)}` : undefined,
            success: r.success,
            error: r.error,
          })),
        });
      }
      const result = await agent.runScreen({
        trigger: "manual",
        filters,
        universe: universe as any,
        userLogin,
        // The screener runs in its own Durable Object, so it cannot infer the
        // environment selected on this orchestrator request. Carry the same
        // authenticated account context into the shared manual/scheduled
        // screening pipeline.
        environment: requestedEnv,
      });
      ctx.audit("etrade.screened", "trading", {
        filterSummary: result.discoveryMessage,
        count: result.allStocks.length,
        success: result.success,
      });
      // Issue #307/#308: store the canonical report copy (one row per
      // generation) so manual screens are searchable like scheduled ones.
      ctx.persistScreenerReportCanonical(result);
      await publishManualScreenerRun(ctx.env, ctx.getOrm(), userLogin, result);
      if (!result.success) {
        return Response.json({ error: result.error || "E*TRADE unavailable" }, { status: 502 });
      }
      return Response.json({
        universe: result.universe,
        totalScanned: result.totalScanned,
        matchedCount: result.matchedCount,
        opportunities: result.opportunities,
        stocks: result.allStocks,
        discoveryMessage: result.discoveryMessage,
        scannedAt: result.timestamp,
        pdfKey: result.pdfKey,
        reportUrl: result.pdfKey ? `/api/screener/report.pdf?key=${encodeURIComponent(result.pdfKey)}` : undefined,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to screen equities" }, { status: 500 });
    }
  }

  // Real-time equity quote (Real E*TRADE REST / OAuth 1.0a)
  if (path.endsWith("/etrade/quote") && request.method === "GET") {
    try {
      const rawSym = url.searchParams.get("symbol") || "NVDA";
      const symbol = rawSym.toUpperCase().trim() || "NVDA";
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const quote = await etrade.fetchQuoteRemote(symbol);
      return Response.json(quote, {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch quote" }, { status: 500 });
    }
  }

  // Order Proposal & Preview with DID Attestation (HITL)
  if (path.endsWith("/etrade/order/preview") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const symbol = (body.symbol || "").trim().toUpperCase();
      const quantity = Number(body.quantity) || 1;
      const rawAction = String(body.orderAction || body.action || "BUY").toUpperCase().trim();
      const validActions = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"];
      const orderAction = (validActions.includes(rawAction) ? rawAction : "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
      const orderType = body.orderType || "MARKET";
      const limitPrice = body.limitPrice !== undefined ? Number(body.limitPrice) : undefined;
      const stopPrice = body.stopPrice !== undefined ? Number(body.stopPrice) : undefined;
      const optionLegs = Array.isArray(body.optionLegs) ? body.optionLegs : undefined;
      const inferredAssetClass = optionLegs?.some((leg: any) => leg.securityType === "OPTN") ? "options" : "equity";
      const rawAssetClass = body.assetClass === undefined ? inferredAssetClass : String(body.assetClass).toLowerCase();
      if (rawAssetClass !== "equity" && rawAssetClass !== "options") {
        return Response.json({ error: `Unsupported order asset class: ${rawAssetClass}.` }, { status: 400 });
      }
      const assetClass = rawAssetClass as "equity" | "options";
      if (assetClass === "options" && !optionLegs?.some((leg: any) => leg.securityType === "OPTN")) {
        return Response.json({ error: "Options orders require at least one complete option contract leg." }, { status: 400 });
      }
      if (assetClass === "equity" && optionLegs?.some((leg: any) => leg.securityType === "OPTN")) {
        return Response.json({ error: "Option contract legs must be routed as an options order." }, { status: 400 });
      }

      if (!symbol) {
        return Response.json({ error: "Order symbol is required" }, { status: 400 });
      }

      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const preview = await etrade.previewOrderRemote({
        assetClass,
        sessionId,
        symbol,
        orderAction,
        quantity,
        orderType,
        limitPrice,
        stopPrice,
        optionLegs,
        strategyNetDebit: body.strategyNetDebit !== undefined ? Number(body.strategyNetDebit) : undefined,
      });

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
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to preview trade order" }, { status: 500 });
    }
  }

  // Authorize & Execute Confirmed Order Draft (HITL Execution via OAuth 1.0a)
  if (path.endsWith("/etrade/order/execute") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderId = (body.orderId || body.draftId || "").trim();
      const decision = body.decision;

      if (!orderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }

      if (decision !== "approved" && decision !== "rejected") {
        return Response.json({ error: "decision must be either 'approved' or 'rejected'" }, { status: 400 });
      }

      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const userDid = getUserDid(sessionId);

      // Strict HITL Gate: block autonomous agents
      if (userDid.startsWith("did:agent:")) {
        return Response.json({ error: "HITL Enforcement: Autonomous trade execution is strictly prohibited. Orders require verified human authorization." }, { status: 403 });
      }

      const existingRecord = ctx.getOrm().trades?.findById(orderId);
      if (!existingRecord) {
        return Response.json({ error: `Order draft '${orderId}' not found. All orders must be previewed and drafted prior to execution.` }, { status: 404 });
      }

      if (existingRecord.status !== "previewed") {
        return Response.json({ error: `Order draft '${orderId}' cannot be executed. Current status is '${existingRecord.status}'. Only 'previewed' drafts may be executed.` }, { status: 400 });
      }

      // Handle user rejection / cancellation immediately
      if (decision === "rejected") {
        if (existingRecord.expirationScheduleId) {
          try {
            await ctx.cancelSchedule(existingRecord.expirationScheduleId);
          } catch {
            // Ignore cancel error if already triggered
          }
        }
        if (ctx.getOrm().trades) {
          ctx.getOrm().trades.update(orderId, {
            status: "rejected",
            authorizerDid: userDid,
            updatedAt: new Date().toISOString(),
          });
        }
        return Response.json({
          success: true,
          orderId,
          status: "rejected",
          message: `Order draft '${orderId}' cancelled by user. No broker order submitted.`,
        });
      }

      // Strict Immutability Verification: Ensure submitted parameters strictly match the previewed draft
      const reqAction = (body.action || body.orderAction || "").toUpperCase().trim();
      if (reqAction && reqAction !== existingRecord.action.toUpperCase()) {
        return Response.json({
          error: `Order Action Mismatch: Previewed action is '${existingRecord.action}', but execution request specifies '${reqAction}'. Submission rejected. A fresh preview is required.`,
        }, { status: 422 });
      }

      const reqSymbol = (body.symbol || "").toUpperCase().trim();
      if (reqSymbol && reqSymbol !== existingRecord.symbol.toUpperCase()) {
        return Response.json({
          error: `Order Symbol Mismatch: Previewed symbol is '${existingRecord.symbol}', but execution request specifies '${reqSymbol}'. Submission rejected.`,
        }, { status: 422 });
      }

      if (body.quantity !== undefined && Number(body.quantity) !== Number(existingRecord.quantity)) {
        return Response.json({
          error: `Order Quantity Mismatch: Previewed quantity is ${existingRecord.quantity}, but execution request specifies ${body.quantity}. Submission rejected.`,
        }, { status: 422 });
      }

      const symbol = existingRecord.symbol.toUpperCase();
      const action = existingRecord.action as any;
      const quantity = Number(existingRecord.quantity);
      const orderType = existingRecord.orderType || "MARKET";
      const limitPrice = existingRecord.orderType === "LIMIT" ? existingRecord.price : undefined;
      let strategyOrder: any = undefined;
      if (existingRecord.previewNotes?.startsWith("{")) {
        try {
          const stored = JSON.parse(existingRecord.previewNotes);
          if (stored?.kind === "strategy-order-v1" && Array.isArray(stored.optionLegs)) strategyOrder = stored;
        } catch {
          // Legacy human-readable preview notes are not structured order payloads.
        }
      }

      // Autopilot policy envelope gate (autopilot Phase 1). Re-evaluated at
      // execution time because orders/day, drawdown, and exposure may have
      // moved since the draft was previewed.
      let executionVerdict: PolicyVerdict | null = null;
      try {
        const evaluated = await ctx.evaluateAndRecordAutopilotVerdict({
          userLogin,
          requestedEnv,
          sessionId,
          draftId: orderId,
          intent: {
            symbol,
            action,
            quantity,
            orderType,
            estimatedPrice: typeof existingRecord.price === "number" ? existingRecord.price : null,
            estimatedTotal: typeof existingRecord.totalValue === "number" ? existingRecord.totalValue : null,
          },
        });
        executionVerdict = evaluated.verdict;
        if (!evaluated.verdict.executionAllowed) {
          return Response.json(
            {
              error: `Autopilot policy blocked execution: ${evaluated.verdict.detail}`,
              bindingRule: evaluated.verdict.bindingRule,
              policyVerdict: evaluated.verdict,
            },
            { status: 409 }
          );
        }
      } catch (policyErr) {
        console.warn("[OrchestratorAgent] Autopilot policy evaluation failed at execute:", policyErr);
        ctx.audit("autopilot.policy_check_failed", "trading", {
          stage: "execute",
          orderId,
          error: policyErr instanceof Error ? policyErr.message : String(policyErr),
        });
        if (ctx.getAutopilotState().running) {
          return Response.json(
            { error: "Autopilot policy check could not be completed; refusing to execute while autopilot is running." },
            { status: 503 }
          );
        }
      }

      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
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
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to execute trade order" }, { status: 500 });
    }
  }

  // Positions & Account Holdings (Real E*TRADE OAuth 1.0a)
  if (path.endsWith("/etrade/positions") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const holdings = await etrade.fetchPortfolioRemote(undefined, true);
      const lastError = etrade.getLastError();
      return Response.json({
        ...holdings,
        error: lastError && holdings.account.accountId === "unconnected" ? lastError : undefined,
      });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch positions" }, { status: 500 });
    }
  }

  // Portfolio-level risk aggregation (issue #34, gap G1): aggregate Greeks,
  // SPY beta-weighted Delta, and total defined max loss from open positions.
  if (path.endsWith("/etrade/portfolio-risk") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const report = await computePortfolioRisk(etrade);
      return Response.json(report);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to compute portfolio risk" }, { status: 500 });
    }
  }

  // Post-trade evaluation (issue #34): current portfolio totals plus a
  // candidate's Greek contribution, without executing anything.
  if (path.endsWith("/etrade/portfolio-risk/evaluate") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { candidate?: CandidateGreekContribution };
      if (!body.candidate) {
        return Response.json({ error: "candidate Greek contribution is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const { account, positions } = await etrade.fetchPortfolioRemote(undefined, true);
      const resolved = await resolvePositionsSnapshot(etrade, positions);
      const spyChain = await etrade.getOptionChains({ symbol: "SPY" }).catch(() => null);
      const report = aggregatePortfolioRisk(resolved, {
        nav: account.netAccountValue || account.totalAccountValue || 0,
        spyPrice: spyChain?.underlyingPrice ?? null,
        asOf: new Date().toISOString(),
      });
      return Response.json({ current: report, postTradeTotals: evaluatePostTradeTotals(report, body.candidate) });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to evaluate post-trade totals" }, { status: 500 });
    }
  }

  // Correlation & concentration assessment (issue #35, gap G2): pairwise
  // correlations among held names plus, for an optional candidate, flags
  // naming the correlated/concentrated positions it would duplicate.
  // Correlations are measured from live history, proxied by sector, or
  // reported unknown — never silently zero.
  if (path.endsWith("/etrade/portfolio-risk/correlation") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { candidateSymbol?: string };
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const report = await computePortfolioRisk(etrade);
      const concentration = await assessPortfolioConcentration(
        report,
        (a, b) => sharedCorrelationService.estimate(a, b),
        body.candidateSymbol,
      );
      return Response.json(concentration);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to assess concentration" }, { status: 500 });
    }
  }

  // Portfolio-aware position sizing (issue #36, gap G3): size a candidate
  // against the current book's risk budgets; the response names the
  // binding constraint.
  if (path.endsWith("/etrade/portfolio-risk/size") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { candidate?: SizingCandidate };
      if (!body.candidate?.symbol || !body.candidate?.perContract) {
        return Response.json({ error: "candidate with symbol and perContract contributions is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const report = await computePortfolioRisk(etrade);
      return Response.json(sizeCandidateAgainstPortfolio(report, body.candidate));
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to size candidate" }, { status: 500 });
    }
  }

  // Hedge proposals (issue #54): DRAFT hedging proposals sized from the
  // portfolio aggregates — for the HITL order-preview flow only; this
  // endpoint never places or previews an order itself.
  // Think-harness guardrail verdicts (issue #67): the same evaluation the
  // agent/MCP tool runs (issue #37), exposed over HTTP for the UI. Inputs
  // resolve caller-provided -> live broker state -> unavailable, and the
  // harness fails closed (INPUTS_UNAVAILABLE) rather than inventing state.
  if (path.endsWith("/etrade/think/evaluate") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as { symbol?: string; action?: "BUY" | "SELL"; quantity?: number; orderType?: "MARKET" | "LIMIT" | "STOP"; price?: number; accountBalanceUSD?: number };
      if (!body.symbol || (body.action !== "BUY" && body.action !== "SELL") || !body.quantity || body.quantity <= 0) {
        return Response.json({ error: "symbol, action (BUY|SELL) and a positive quantity are required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const harness = new ETradeThinkHarness(ctx.getOrm(), ctx.env);
      const result = await harness.evaluateTradeWithThinking({
        symbol: body.symbol.toUpperCase(),
        action: body.action,
        quantity: body.quantity,
        orderType: body.orderType || "MARKET",
        price: body.price,
        accountBalanceUSD: body.accountBalanceUSD,
        userLogin,
      });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Think evaluation failed" }, { status: 500 });
    }
  }

  if (path.endsWith("/etrade/hedge/analyze") && request.method === "POST") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const analysis = await generateHedgeProposals(etrade);
      return Response.json(analysis);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to generate hedge proposals" }, { status: 500 });
    }
  }

  // Order History & Trade Audit Ledger
  if (path.endsWith("/etrade/orders") && request.method === "GET") {
    try {
      const orm = ctx.getOrm();
      const trades = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
      return Response.json({ count: trades.length, trades });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch order history" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Remote Orders on Exchange
  if (path.endsWith("/etrade/orders/remote") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const status = url.searchParams.get("status") || undefined;
      const marker = url.searchParams.get("marker") || undefined;
      const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
      const symbol = url.searchParams.get("symbol") || undefined;
      const orders = await etrade.fetchOrdersRemote(undefined, { status, marker, count, symbol });
      return Response.json({ count: orders.length, orders });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch exchange orders" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Cancel Order on Exchange
  if (path.endsWith("/etrade/orders/cancel") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as any;
      const orderId = body.orderId;
      if (!orderId) {
        return Response.json({ error: "orderId is required" }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const result = await etrade.cancelOrderRemote(orderId);
      ctx.audit("etrade.order_cancelled", "trading", { orderId, success: result.success });
      return Response.json(result, { status: result.success ? 200 : 400 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel order" }, { status: 500 });
    }
  }

  return null;
}

/**
 * Handles the E*TRADE broker account-activity routes (transactions,
 * alerts, product lookup block). Returns a Response on match, null when
 * no activity path matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleEtradeBrokerActivityRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: EtradeBrokerRouteContext
): Promise<Response | null> {
  const rawEnvHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
  const requestedEnv: "TEST" | "PROD" | undefined = (rawEnvHeader === "TEST" || rawEnvHeader === "PROD") ? rawEnvHeader : undefined;

  // Real E*TRADE REST API: Account Transactions
  if (path.endsWith("/etrade/transactions") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const startDate = url.searchParams.get("startDate") || undefined;
      const endDate = url.searchParams.get("endDate") || undefined;
      const sortOrder = (url.searchParams.get("sortOrder") as "ASC" | "DESC") || undefined;
      const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
      const transactions = await etrade.fetchTransactions(undefined, { startDate, endDate, sortOrder, count });
      return Response.json({ count: transactions.length, transactions });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Transaction Details
  if (path.includes("/etrade/transactions/") && request.method === "GET") {
    try {
      const transactionId = path.split("/etrade/transactions/")[1].split("/")[0].split("?")[0];
      const storeId = url.searchParams.get("storeId") || undefined;
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const details = await etrade.fetchTransactionDetails(transactionId, undefined, storeId);
      if (!details) {
        return Response.json({ error: "Transaction not found" }, { status: 404 });
      }
      return Response.json(details);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transaction details" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: User Alerts Inbox
  if (path.endsWith("/etrade/alerts") && request.method === "GET") {
    try {
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const category = url.searchParams.get("category") || undefined;
      const status = (url.searchParams.get("status") as "READ" | "UNREAD" | "DELETED") || undefined;
      const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
      const alerts = await etrade.fetchAlerts({ category, status, count });
      return Response.json({ count: alerts.length, alerts });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alerts" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Alert Details & Delete
  if (path.includes("/etrade/alerts/") && request.method === "GET") {
    try {
      const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const details = await etrade.fetchAlertDetails(alertId);
      if (!details) {
        return Response.json({ error: "Alert not found" }, { status: 404 });
      }
      return Response.json(details);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alert details" }, { status: 500 });
    }
  }

  if (path.includes("/etrade/alerts/") && request.method === "DELETE") {
    try {
      const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const result = await etrade.deleteAlert(alertId);
      return Response.json(result, { status: result.success ? 200 : 400 });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to delete alert" }, { status: 500 });
    }
  }

  // Real E*TRADE REST API: Product Lookup
  if (path.endsWith("/etrade/lookup") && request.method === "GET") {
    try {
      const search = url.searchParams.get("search") || url.searchParams.get("q") || "";
      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const etrade = new ETradeService(ctx.getOrm(), ctx.env, userLogin, requestedEnv);
      const items = await etrade.lookupProduct(search);
      return Response.json({ count: items.length, items });
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "Failed to lookup products" }, { status: 500 });
    }
  }

  return null;
}
