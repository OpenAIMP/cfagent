import type { Env, SessionData, TransactionSnapData } from "./types";
import { getSessionId, isSessionIdFormat, setSessionCookie } from "./session";
import { getServiceUserLogin, isLoginShaped, SHARED_ORCHESTRATOR_INSTANCE } from "./security/serviceIdentity";
import { getSessionCached, invalidateSessionCache } from "./security/sessionCache";
import { getSession, sessionStore, updateSession } from "./security/session";
import type { DoNamespaceLike } from "./security/durableKv";
import { zonedDateParts } from "./schedule";
import { OPERATION_CATALOG } from "./orchestrate";
import {
  SOCIAL_BRIEF_MAX_CHARS,
  createSocialBriefStoreFromNamespace,
  isBriefDate,
} from "./agents/social/briefStore";
import { createSocialStoresFromNamespace } from "./agents/social/durableStores";
import {
  KNOWN_SOCIAL_CHANNELS,
  parseSocialConfig,
} from "./agents/social/config";
import {
  createMemoryDryRunSink,
  resolvePostUrl,
  resolveSubmissionEndpoint,
} from "./agents/social/publisher";
import { createFetchSocialTransport } from "./agents/social/liveTransport";
import { approveAndPublish, rejectSocialDraft } from "./agents/social/approvalActions";
import {
  handleSocialSlackInteraction,
  parseSocialAction,
} from "./agents/social/interactions";
import { checkAllTokenHealth } from "./agents/social/tokenHealth";
import { validateAndTouchWiredSession } from "./security/iaaaEnforcement";
import { requiresStepUpForMint } from "./security/iaaaGates";
import { createWiredAuditStore } from "./security/iaaaAuditStore";
import { createKvMembershipStore, grantMembership } from "./security/iaaaMembershipStore";
import { canGrantRole } from "./security/authorization";
import { createAccessRequestStore } from "./security/iaaaAccessRequests";
import { buildAdminOverview } from "./security/iaaaAdminOverview";
import { handleSeedGovernanceRoute } from "./data/seedGovernanceRoute";
import {
  handleChainStatusRoute,
  handleReconcileChainsRoute,
} from "./data/chainStatusRoute";
import { readChainStatus } from "./data/createChainSchedulePorts";
import type { ReconcileReport } from "./data/chainScheduleProjection";
import {
  handleJobHistoryRoute,
  handleReconcileJobsRoute,
} from "./data/shardJobRoute";
import {
  createShardJobAdapter,
  readJobHistory,
} from "./data/createShardJobPorts";
import { handleRetentionPurgeRoute } from "./data/retentionRoute";
import { dispatchSubscriberBatch } from "./messaging/cfQueueMessagingAdapter";
import {
  isMessageEnvelope,
  type SubscriberHandlers,
} from "./messaging/messagingPorts";
import { withRequestObservability } from "./observability/aspects";
import { createObservabilitySink } from "./observability/createObservabilityPorts";
import { writeEnvelopeToSink } from "./observability/observabilityPorts";
import { createScreenerQueueHandler } from "./messaging/screenerQueueConsumer";
import {
  createRetentionPurgeStore,
  runRetentionPurgeForTenant,
} from "./data/createRetentionPorts";
import type { ReconcileShardJobsReport } from "./data/shardJobProjection";
import {
  handleAuditHistoryRoute,
  handleReportsRoute,
  handleSeedReportsRoute,
} from "./data/auditReportRoute";
import {
  handleTelemetryDecisionActionRoute,
  handleTelemetryDecisionsRoute,
  handleTelemetryReconcileRoute,
  handleTelemetrySummaryRoute,
} from "./telemetry/telemetryRoute";
import type { TrackRecordIdeaInput } from "./telemetry/telemetryProjection";
import {
  createTelemetryAdapter,
  ensureTelemetryTables,
} from "./telemetry/createTelemetryPorts";
import { createResourceUsagePort } from "./telemetry/createResourceUsagePorts";
import type { ResourceAttribution } from "./telemetry/resourceUsagePorts";
import { defaultBreakerRegistry } from "./breakers/createBreakerPorts";
import { gatewayStatsSnapshot } from "./gateway/createGatewayPorts";
import { retrievalStatsSnapshot } from "./telemetry/retrievalStats";
import {
  createAuditReportAdapter,
  readAuditHistory,
  readReports,
} from "./data/createAuditReportPorts";
import type { SeedCanonicalReportsResult } from "./data/auditReportProjection";
import type { GovernedHaltState } from "./data/governedHalt";
import { buildOpenApiSpec, SWAGGER_UI_HTML } from "./security/openapiSpec";
import {
  checkRoutePermission,
  isLegacyPdpGraceExpired,
  resolveIaaaTenant,
  shouldEnforcePdp,
} from "./security/iaaaGithubEndToEnd";
import {
  bearerKeyFromRequest,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from "./security/apiKeys";
import { serveStaticAsset } from "./security/staticAssets";
import { withErrorBoundary } from "./security/workerErrorBoundary";
import { handleLogout, renderLoginPage } from "./oauth";
import {
  disabledLoginResponse,
  enabledProviders,
  getProvider,
  getProviderByIssuer,
  isWiringEnabled,
  resolveLoginProvider,
} from "./security/providers";
import { renderLandingPage } from "./landing";
import { SERVER_PALETTE } from "./theme/serverPalette";
import { routeAgentRequest } from "agents";
import {
  getETradeRequestToken,
  exchangeETradeVerifier,
  renewETradeAccessToken,
  revokeStoredTokens,
  revokeRemoteAccessToken,
  getETradeAuthStatus,
  getValidTokens,
  renewAllStoredETradeTokens,
} from "./services/etradeOAuth";
import {
  PublicClientRejectedError,
  completePublicOAuth,
  connectPublicPersonalToken,
  disconnectPublic,
  getPublicConnectionStatus,
  publicClientMetadataDocument,
  startPublicOAuth,
} from "./security/publicOAuth";
import { ETradeRestClient } from "./trading";
import { resolveEnvironmentConfig } from "./config/environment";
import {
  isFeatureEnabled,
  getAllFeatureFlags,
  createFeatureDisabledResponse,
  matchFeatureForRoute,
} from "./config/featureFlags";
import { handleCloudflareEmailMessage, ETradeEmailTradingService } from "./trading";
import { ETradeSlackTradingService, confirmSlackLink } from "./trading";
import {
  INBOUND_EMAIL_ORCHESTRATOR_INSTANCE,
  resolvePrincipal,
  slackPrincipalLinkStoreFromEnv,
  verifyApprovalLinkForPrincipal,
} from "./trading";
import { gateSlackRequest } from "./security/webhookSecurity";
import { sanitizeInboundText } from "./security/promptInjectionSanitize";
import { checkRateLimit } from "./security/rateLimiter";
import {
  deriveNlqNonce,
  sharedMemoryReplayStore,
  validateEmailRecipient,
} from "./security/webhookReplay";
import { handleVoiceWebSocketConnection, ETradeVoiceTradingService, createOrchestratorVoiceTurnForwarder } from "./trading";
import { ETradeWebhookService } from "./services/tradingWebhooks";
import { ETradeBrowserService } from "./services/browserAgent";
import { handleMarketQuotesWebSocket, handleMarketQuotesHttp } from "./services/marketStream";
import {
  levelsForQuoteSwitch,
  resolveQuoteExpiryMode,
  resolveQuoteHttpProviderMode,
  resolveQuoteStreamProvenance,
} from "./config/quoteModes";
import { resolveSnapIdentity } from "./config/restTwinsModes";
import {
  filterLiveFlowItems,
  filterNewsFlowItems,
  filterInsiderFlowItems,
  filterCongressFlowItems,
  calculateFlowSummary,
  DEFAULT_SAVED_PRESETS,
  getDynamicLiveFlowItems,
  getDynamicFlowSummary,
  summarizeFlowProvenance,
  fetchRealMarketNews,
  fetchRealSecInsiderFilings,
  fetchRealCongressDisclosures,
  MarketCapCategory,
  AssetClassCategory,
} from "./trading";
export { OrchestratorAgent as SearchAgent } from "./agents/orchestrator";
// Issue #1387 — the agents SDK resolves sub-agent roots through
// ctx.exports by constructor.name, so OrchestratorAgent must ALSO be
// exported under its own name (the SearchAgent alias above cannot
// satisfy the root-namespace lookup). The alias stays: it is the live
// orchestrator address and its stored state must not move.
export { OrchestratorAgent } from "./agents/orchestrator";
export { OptionsScannerMCP } from "./services/cloudflareWalletsScanner";
export { BrowserAgent } from "./agents/browserAgent";
export { SlackAgent } from "./agents/slackAgent";
// Issue #197: wrangler.jsonc binds PAYMENTS_AGENT/SCHEDULED_AGENT as Durable
// Objects — wrangler requires every bound DO class to be exported from the
// entrypoint, otherwise `wrangler deploy` fails.
export { PaymentsAgent } from "./agents/payments-agent";
export { ScheduledAgent } from "./agents/scheduled-agent";
export { ScreenerAgent } from "./agents/screener-agent";
// Issue #319 — wrangler requires every bound DO class to be exported from
// the entrypoint, otherwise `wrangler deploy` fails.
export { ResearchAgent } from "./agents/research-agent";
export { TradingAgent } from "./agents/trading-agent";
export { TradingTradeWorkflow } from "./agents/trading-trade-workflow";
export { ScreenerScreenWorkflow } from "./workflows/screenerWorkflow";
export { ReportAssetAgent } from "./agents/report-asset-agent";
export { SessionStore } from "./security/sessionStore";


function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // Non-browser clients or direct connections

  try {
    const originHost = new URL(origin).host;
    const requestHost = new URL(request.url).host;
    if (originHost === requestHost) return true;

    if (env.APP_BASE_URL) {
      const allowedHost = new URL(env.APP_BASE_URL).host;
      if (originHost === allowedHost) return true;
    }
    if (originHost === "agent.openaimp.com" || originHost.endsWith(".openaimp.com")) return true;
    if (originHost === "localhost" || originHost.startsWith("localhost:")) return true;
    if (originHost === "127.0.0.1" || originHost.startsWith("127.0.0.1:")) return true;
    if (originHost === "[::1]" || originHost.startsWith("[::1]:")) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * Issue #313: single-owner handler for the NLQ inbound webhook.
 * All three advertised spellings — /nlq/webhook, /api/trading/nlq/webhook,
 * /api/nlq/webhook — delegate here so the logic (throttle, signature
 * verification, replay protection, forwarding) exists exactly once and
 * behaves byte-identically for every spelling.
 */
async function handleNlqWebhookRequest(
  request: Request,
  env: Env,
  throttle: (route: string, maxRequests: number, windowMs: number) => Response | null
): Promise<Response> {
  // Issue #241: this route fans out to the NLQ planner + optional email —
  // throttle per source IP before touching the body.
  const limited = throttle("nlq_webhook", 30, 60_000);
  if (limited) return limited;
  if (!env.INBOUND_NLQ_WEBHOOK_SECRET) {
    return Response.json({ error: "INBOUND_NLQ_WEBHOOK_SECRET is not configured." }, { status: 503 });
  }
  const rawBody = await request.text();
  if (rawBody.length > 128_000) return Response.json({ error: "Webhook payload exceeds 128 KB." }, { status: 413 });
  const verifier = new ETradeWebhookService(undefined, env, "nlq_webhook");
  const isValid = await verifier.verifySignature(
    rawBody,
    request.headers.get("X-Signature-256"),
    env.INBOUND_NLQ_WEBHOOK_SECRET,
  );
  if (!isValid) return Response.json({ error: "Invalid NLQ webhook signature." }, { status: 401 });

  let body: { query?: unknown; emailTo?: unknown; userId?: unknown; timestamp?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof body.query !== "string" || !body.query.trim()) {
    return Response.json({ error: "A non-empty query string is required." }, { status: 400 });
  }
  // #1763 (SEC-005): sanitize the webhook query at entry — marker
  // defuse + control-strip — before the nonce, the forward, and any
  // prompt assembly downstream. Legitimate queries pass verbatim.
  // (Local const, not a re-read of body.query: the declared type
  // is unknown, so downstream uses must go through this variable.)
  const sanitizedQuery = sanitizeInboundText((body.query as string).trim());
  body.query = sanitizedQuery;
  if (typeof body.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp)) ||
    Math.abs(Date.now() - Date.parse(body.timestamp)) > 5 * 60 * 1000) {
    return Response.json({ error: "Webhook timestamp is missing, invalid, or expired." }, { status: 401 });
  }
  if (sanitizedQuery.length > 4_000) return Response.json({ error: "Query must be 4,000 characters or fewer." }, { status: 413 });
  if (body.emailTo !== undefined &&
    (typeof body.emailTo !== "string" || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(body.emailTo.trim()))) {
    return Response.json({ error: "emailTo must be a valid email address." }, { status: 400 });
  }
  // Issue #143 P0: emailTo domain allowlist. When
  // EMAIL_TO_ALLOWED_DOMAINS is configured, only listed domains are
  // accepted; otherwise behavior is unchanged (format check only).
  if (typeof body.emailTo === "string" && body.emailTo.trim()) {
    const emailCheck = validateEmailRecipient(body.emailTo, env.EMAIL_TO_ALLOWED_DOMAINS);
    if (!emailCheck.ok) return Response.json({ error: emailCheck.reason }, { status: 400 });
  }
  // Issue #143 P0: replay protection. This edge route has no ORM, so
  // the nonce claim uses the isolate-scoped fallback store; HMAC +
  // the 5-minute timestamp window above remain the primary controls.
  const nlqNonce = await deriveNlqNonce(
    sanitizedQuery,
    typeof body.emailTo === "string" ? body.emailTo.trim() : undefined,
    body.timestamp
  );
  if (await sharedMemoryReplayStore().claim(nlqNonce, "nlq")) {
    return Response.json({ error: "Duplicate NLQ webhook event rejected (replay protection)." }, { status: 409 });
  }
  const userLogin = typeof body.userId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.userId)
    ? `nlq_webhook_${body.userId}`
    : "nlq_webhook";
  const agentId = env.SEARCH_AGENT.idFromName(userLogin);
  const target = new URL("/nlq", "https://agent.internal");
  const forwarded = new Request(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-user-login": userLogin,
      "x-nlq-source": "webhook",
    },
    body: JSON.stringify({ query: sanitizedQuery }),
  });
  const response = await env.SEARCH_AGENT.get(agentId).fetch(forwarded);
  if (!response.ok) return response;
  const result = await response.json() as Record<string, unknown>;

  if (typeof body.emailTo === "string" && body.emailTo.trim()) {
    const plan = result.plan as { operation?: string; domain?: string; tradingData?: { action?: string }; scheduleData?: { action?: string }; agenticPaymentsData?: { action?: string } } | undefined;
    const action = plan?.tradingData?.action || plan?.scheduleData?.action || plan?.agenticPaymentsData?.action;
    const emailAllowed = plan?.domain !== "agentic_payments" &&
      !["preview_order", "execute_order", "watchlist_save", "create", "cancel", "paid_scan", "paid_research"].includes(action || "");
    if (!emailAllowed) return Response.json({ ...result, emailDelivery: "not sent for an action request" });
    const recipient = body.emailTo.trim();
    const emailAgent = new ETradeEmailTradingService(env, undefined, userLogin);
    const summary = typeof result.summary === "string" ? result.summary : "NLQ request processed.";
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const text = `${summary}\n\n${JSON.stringify(rows, null, 2)}`;
    const safeText = text.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    })[character] || character);
    const sent = await emailAgent.sendOutboundEmail(
      recipient,
      "NLQ webhook response",
      `<h2>NLQ response</h2><pre>${safeText}</pre>`,
      text,
    );
    if (!sent) return Response.json({ error: "NLQ succeeded, but email delivery failed." }, { status: 502 });
  }
  return Response.json(result);
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Issue #329: static assets never need a session, but `run_worker_first`
    // routes them through this handler anyway — so serve them from the ASSETS
    // binding before `requireAuth` can spend a session-store read on them.
    const staticAsset = await serveStaticAsset(request, path, env);
    if (staticAsset) return staticAsset;

    // Issue #241: abuse throttling on expensive ingress routes.
    // `null` = allowed, otherwise a 429 Response to return immediately.
    const throttle = (
      route: string,
      maxRequests: number,
      windowMs: number
    ): Response | null => {
      const client =
        request.headers.get("x-user-login") ||
        request.headers.get("cf-connecting-ip") ||
        "anonymous";
      const res = checkRateLimit(`${route}:${client}`, maxRequests, windowMs);
      if (!res.allowed) {
        return Response.json(
          { error: "Rate limit exceeded. Slow down and retry." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.max(1, Math.ceil(res.retryAfterMs / 1000))) },
          }
        );
      }
      return null;
    };

    // Issue #1247: Public.com Client ID Metadata Document — the
    // OAuth client_id for the Public resource provider IS this URL
    // (no RFC 7591 registration exists; see src/security/publicOAuth.ts).
    // Served ahead of the A2A well-known branch, which would otherwise
    // claim every /.well-known/* path. Public by design: the
    // authorization server fetches it unauthenticated.
    if (path === "/.well-known/oauth-client-id-metadata-document") {
      const origin = new URL(request.url).origin;
      return new Response(JSON.stringify(publicClientMetadataDocument(origin)), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // PR #2 — A2A routing (issue #160): agent discovery + JSON-RPC dispatch
    if (path.startsWith("/a2a/") || path.startsWith("/.well-known/")) {
      const { handleA2A } = await import("./a2a");
      return handleA2A(request, env as any);
    }

    // Issue #1806: Cloudflare feature flags — dynamic feature flags query
    if (path === "/api/features" && request.method === "GET") {
      const session = await requireAuth(request, env).catch(() => null);
      const features = await getAllFeatureFlags(env, { userLogin: session?.githubLogin });
      return Response.json({ features });
    }

    // Issue #1806: Server-side feature flag enforcement (default-closed, fail-closed).
    // An endpoint for a disabled feature is completely unreachable (HTTP 404 FEATURE_DISABLED).
    const gatedFeature = matchFeatureForRoute(path);
    if (gatedFeature) {
      const session = await requireAuth(request, env).catch(() => null);
      const isEnabled = await isFeatureEnabled(env, gatedFeature, {
        userLogin: session?.githubLogin,
      });
      if (!isEnabled) {
        return createFeatureDisabledResponse(gatedFeature, 404);
      }
    }

    if ((path === "/nlq/webhook" || path === "/api/trading/nlq/webhook" || path === "/api/nlq/webhook") && request.method === "POST") {
      // Issue #313: advertised /api spelling — same handler, no forked logic.
      return handleNlqWebhookRequest(request, env, throttle);
    }

    // --- Agents Routing (WebSockets and agent HTTP calls) ---
    const agentResponse = await routeAgentRequest(request, env, {
      cors: true,
      onBeforeConnect: async (req) => {
        // Cross-Site WebSocket Hijacking (CSWSH) check
        if (!isAllowedOrigin(req, env)) {
          return new Response("Forbidden: Invalid Origin", { status: 403 });
        }
        const session = await requireAuth(req, env);
        if (!session) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
      onBeforeRequest: async (req) => {
        const session = await requireAuth(req, env);
        if (!session) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
    });
    if (agentResponse) return agentResponse;

    // --- Authentication endpoints ---
    // #945 provider registry dispatch, completed by #1254 PR-B:
    // the generic /auth/login/<id> + /auth/callback/<id> family
    // below is the ONLY login routing — the GitHub-only exact
    // /auth/login + /auth/callback branches and the wiring-off
    // legacy flow are deleted. A disabled/unregistered provider
    // gets a 403, never a fallback. Logout is unchanged.
    if (path === "/login" && request.method === "GET") {
      // #945 Google-as-plugin — composable login page: when wiring
      // is on, the page renders one button per enabled, registered
      // provider (computed here and passed in — githubOAuth.ts must
      // not import providers.ts, which would create an import
      // cycle). When nothing is enabled (wiring off, or no
      // registered provider in the list), no argument is passed and
      // the page is exactly the legacy GitHub-only page.
      const enabled = enabledProviders(env)
        .map((id) => getProvider(id))
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => ({ id: p.providerId, displayName: p.displayName ?? p.providerId }));
      return new Response(renderLoginPage(env, enabled.length > 0 ? enabled : undefined), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    // #945 Google-as-plugin — generic provider routes: the only
    // login routing since #1254 PR-B deleted the exact GitHub-only
    // branches. A provider id segment dispatches through the
    // registry (wired-callback options: audit store, resolved
    // tenant, post-login enabled). Wiring OFF is a 403 — no legacy
    // flow exists for any provider — and an unknown or unlisted id
    // is a 403, never a fallback to another provider.
    const loginProviderMatch = path.match(/^\/auth\/login\/([^/]+)$/);
    if (loginProviderMatch) {
      if (!isWiringEnabled(env)) return disabledLoginResponse("wiring-disabled");
      const { provider, disabledReason } = resolveLoginProvider(env, loginProviderMatch[1]);
      if (!provider || disabledReason) {
        return disabledLoginResponse(disabledReason ?? "provider-not-registered");
      }
      return provider.startLogin(env);
    }
    const callbackProviderMatch = path.match(/^\/auth\/callback\/([^/]+)$/);
    if (callbackProviderMatch) {
      if (!isWiringEnabled(env)) return disabledLoginResponse("wiring-disabled");
      const { provider, disabledReason } = resolveLoginProvider(env, callbackProviderMatch[1]);
      if (!provider || disabledReason) {
        return disabledLoginResponse(disabledReason ?? "provider-not-registered");
      }
      return provider.handleCallback(env, request, {
        auditStore: createWiredAuditStore(env),
        auditTenantId: resolveIaaaTenant(env),
        postLoginEnabled: true,
      });
    }
    if (path === "/auth/logout") {
      // #945 GitHub end-to-end logout audit hook: when wiring is
      // ON, supply the audit seam with the resolved tenant
      // (IAAA_TENANT_ID else the documented default "primary"), so
      // the hook is no longer dormant when the env var is unset.
      // handleLogout records BEFORE deleteSession, best-effort.
      if (isWiringEnabled(env)) {
        return handleLogout(env, request, {
          wiringEnabled: true,
          auditStore: createWiredAuditStore(env),
          tenantId: resolveIaaaTenant(env),
        });
      }
      return handleLogout(env, request);
    }

    // --- E*TRADE OAuth 1.0a 3-Legged Lifecycle Endpoints ---
    const reqEnv = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase() || undefined;

    if (path === "/auth/etrade/start" || path === "/api/etrade/oauth/start") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // #945 GitHub end-to-end PDP gate: when IAAA_PDP_ENABLED is on
      // and the session is wired, starting an integration connection
      // requires integration:connect in the resolved tenant.
      // Flag OFF or a legacy session inside its #1749 PDP grace bound takes the pre-change path;
      // a grace-expired legacy session is PDP-enforced and denied with legacy_pdp_grace_expired (see authz.md §8).
      if (shouldEnforcePdp(env, session, Date.now())) {
        const allowed = await checkRoutePermission(
          createKvMembershipStore(sessionStore(env)),
          session,
          resolveIaaaTenant(env),
          "integration:connect",
          Date.now(),
        );
        if (!allowed) {
          if (isLegacyPdpGraceExpired(env, session, Date.now())) {
            return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
          }
          return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
        }
      }
      const callbackParam = url.searchParams.get("callback");
      const callbackUrl = callbackParam || "oob";
      try {
        const result = await getETradeRequestToken(env, session.githubLogin, callbackUrl, reqEnv);
        if (url.searchParams.get("mode") === "redirect") {
          return Response.redirect(result.authorizeUrl, 302);
        }
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to initiate E*TRADE OAuth" }, { status: 500 });
      }
    }

    if (path === "/auth/etrade/callback") {
      const session = await requireAuth(request, env);
      if (!session) return Response.redirect("/?error=unauthorized", 302);
      const verifier = url.searchParams.get("oauth_verifier");
      if (!verifier) {
        return Response.redirect("/?tab=trading&error=missing_verifier", 302);
      }
      try {
        await exchangeETradeVerifier(env, session.githubLogin, verifier, undefined, undefined, reqEnv);
        return Response.redirect("/?tab=trading&etrade_auth=success", 302);
      } catch (err: any) {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(err.message || "exchange_failed")}`, 302);
      }
    }

    if (path === "/api/etrade/oauth/status") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ authenticated: false });
      const status = await getETradeAuthStatus(env, session.githubLogin, reqEnv);
      return Response.json(status);
    }

    if (path === "/api/etrade/diagnostics") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ authenticated: false, error: "Unauthorized: Please log in with GitHub" }, { status: 401 });

      const envConfig = resolveEnvironmentConfig(env, reqEnv);
      const valid = await getValidTokens(env, session.githubLogin, reqEnv);

      const client = new ETradeRestClient(env, session.githubLogin, reqEnv);
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
        userLogin: session.githubLogin,
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
    }

    if (path === "/api/etrade/oauth/verifier" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // #945 GitHub end-to-end PDP gate: completing the integration
      // connection (verifier exchange, which stores broker tokens)
      // requires integration:connect, same rule as the start route, including the #1749 legacy grace bound.
      if (shouldEnforcePdp(env, session, Date.now())) {
        const allowed = await checkRoutePermission(
          createKvMembershipStore(sessionStore(env)),
          session,
          resolveIaaaTenant(env),
          "integration:connect",
          Date.now(),
        );
        if (!allowed) {
          if (isLegacyPdpGraceExpired(env, session, Date.now())) {
            return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
          }
          return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
        }
      }
      const body = (await request.json().catch(() => ({}))) as any;
      const verifier = (body.verifier || "").trim();
      if (!verifier) return Response.json({ error: "Verifier PIN is required" }, { status: 400 });
      try {
        const tokens = await exchangeETradeVerifier(env, session.githubLogin, verifier, body.requestToken, body.requestTokenSecret, reqEnv);
        return Response.json({ success: true, environment: tokens.environment, storedAt: tokens.storedAt });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to exchange verifier" }, { status: 400 });
      }
    }

    if (path === "/api/etrade/oauth/renew" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        const renewed = await renewETradeAccessToken(env, session.githubLogin, reqEnv);
        if (renewed) {
          return Response.json({ success: true, storedAt: renewed.storedAt });
        }
        return Response.json({ success: false, error: "Token could not be renewed. User must re-authenticate." }, { status: 400 });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to renew token" }, { status: 500 });
      }
    }

    if (path === "/api/etrade/oauth/revoke" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const result = await revokeRemoteAccessToken(env, session.githubLogin, reqEnv);
      return Response.json(result);
    }

    // --- Public.com OAuth 2.1 Resource-Provider Lifecycle (issue #1247) ---
    // Public is a RESOURCE provider in the E*TRADE shape: tokens are
    // data-API credentials bound to the signed-in user, held in the
    // SessionStore (src/security/publicOAuth.ts), and never create a
    // login session. The pasted personal access token is the alternate
    // credential and stores through the same token-set record.
    if (path === "/auth/public/start") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // Same #945 PDP gate as the E*TRADE start route, including the #1749 legacy grace bound.
      if (shouldEnforcePdp(env, session, Date.now())) {
        const allowed = await checkRoutePermission(
          createKvMembershipStore(sessionStore(env)),
          session,
          resolveIaaaTenant(env),
          "integration:connect",
          Date.now(),
        );
        if (!allowed) {
          if (isLegacyPdpGraceExpired(env, session, Date.now())) {
            return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
          }
          return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
        }
      }
      try {
        const origin = new URL(request.url).origin;
        const { authorizeUrl } = await startPublicOAuth(env, session.githubLogin, origin);
        return Response.redirect(authorizeUrl, 302);
      } catch (err: any) {
        if (err instanceof PublicClientRejectedError) {
          return new Response(err.message, { status: 502 });
        }
        return new Response(
          "Could not start the Public.com sign-in: " + (err?.message || String(err)) +
            "\n\nYou can still connect with a personal access token (POST /api/public/connect).",
          { status: 502 }
        );
      }
    }

    if (path === "/auth/public/callback") {
      const session = await requireAuth(request, env);
      if (!session) return Response.redirect("/?error=unauthorized", 302);
      const errorParam = url.searchParams.get("error");
      if (errorParam) {
        const detail = url.searchParams.get("error_description") || errorParam;
        return Response.redirect(`/?tab=settings&public_error=${encodeURIComponent(detail)}`, 302);
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        return Response.redirect("/?tab=settings&public_error=missing_code_or_state", 302);
      }
      try {
        // The state is verified inside (session.ts primitives), and the
        // pending flow must belong to THIS session's login.
        const result = await completePublicOAuth(env, state, code, session.githubLogin);
        return Response.redirect(`/?tab=settings&public_connected=${result.toolCount}`, 302);
      } catch (err: any) {
        return Response.redirect(
          `/?tab=settings&public_error=${encodeURIComponent(err?.message || "exchange_failed")}`,
          302
        );
      }
    }

    if (path === "/api/public/status") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ connected: false });
      return Response.json(await getPublicConnectionStatus(env, session.githubLogin));
    }

    if (path === "/api/public/connect" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      // Same #945 PDP gate as the E*TRADE verifier route (this stores
      // a broker credential), including the #1749 legacy grace bound.
      if (shouldEnforcePdp(env, session, Date.now())) {
        const allowed = await checkRoutePermission(
          createKvMembershipStore(sessionStore(env)),
          session,
          resolveIaaaTenant(env),
          "integration:connect",
          Date.now(),
        );
        if (!allowed) {
          if (isLegacyPdpGraceExpired(env, session, Date.now())) {
            return Response.json({ error: "Legacy session PDP grace expired: re-login through wiring to restore gated actions.", code: "legacy_pdp_grace_expired" }, { status: 403 });
          }
          return Response.json({ error: "Authorization denied: integration:connect permission required." }, { status: 403 });
        }
      }
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      const token = (body?.token || "").trim();
      if (!token) return Response.json({ error: "A personal access token is required." }, { status: 400 });
      try {
        // Verified against the MCP server before it is stored.
        const result = await connectPublicPersonalToken(env, session.githubLogin, token);
        return Response.json({ ok: true, toolCount: result.toolCount, tools: result.tools });
      } catch (err: any) {
        return Response.json(
          { error: "Public.com rejected that token: " + (err?.message || String(err)) },
          { status: 502 }
        );
      }
    }

    if (path === "/api/public/disconnect" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      await disconnectPublic(env, session.githubLogin);
      return Response.json({ ok: true });
    }

    // --- Factor 14 Telemetry: Health & Observability Endpoint ---
    if (path === "/health" || path === "/api/health") {
      return Response.json({
        status: "healthy",
        service: "cfagent-multi-agent-studio",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        environment: reqEnv,
        runtime: "cloudflare-workers",
        telemetry: {
          durableObjects: "healthy",
          mcp: "available",
          apiFirst: true,
          fifteenFactorCompliant: true,
        },
      });
    }

    // Issue #162 — QA self-healing: LLM investigation of a post-deploy failure.
    // Called by scripts/qa-smoke.mjs after filing the GitHub issue; the
    // returned diagnosis is posted as an issue comment for human supervision.
    if (path === "/api/qa/investigate" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        operation?: unknown;
        errorClass?: unknown;
        detail?: unknown;
        runLink?: unknown;
      } | null;
      const operation = typeof body?.operation === "string" ? body.operation.slice(0, 200) : "";
      const errorClass = typeof body?.errorClass === "string" ? body.errorClass.slice(0, 200) : "";
      const detail = typeof body?.detail === "string" ? body.detail.slice(0, 8000) : "";
      const runLink = typeof body?.runLink === "string" ? body.runLink.slice(0, 500) : undefined;
      if (!operation || !errorClass || !detail) {
        return Response.json(
          { error: "operation, errorClass, and detail are required." },
          { status: 400 }
        );
      }
      const { investigateQAFailure } = await import("./qa/investigate");
      const investigation = await investigateQAFailure(env as any, {
        operation,
        errorClass,
        detail,
        runLink,
      });
      return Response.json({ ok: true, investigation });
    }

    // Issue #164 — VectorMemory browser: semantic search over past outcomes.
    // Also serves as the live-accumulation check: non-empty results prove
    // vectors are landing in the index.
    if (path === "/api/memory/search" && request.method === "POST") {
      // Issue #241: vector search is billed per query — throttle per caller.
      const limited = throttle("memory_search", 60, 60_000);
      if (limited) return limited;
      const body = (await request.json().catch(() => null)) as {
        query?: unknown;
        topK?: unknown;
        operationFilter?: unknown;
      } | null;
      const query = typeof body?.query === "string" ? body.query.slice(0, 1000) : "";
      const topK = typeof body?.topK === "number" ? body.topK : 10;
      const operationFilter =
        typeof body?.operationFilter === "string" && body.operationFilter
          ? body.operationFilter.slice(0, 120)
          : undefined;
      if (!query) {
        return Response.json({ error: "query is required." }, { status: 400 });
      }
      if (!env.AI || !env.VECTOR_MEMORY) {
        return Response.json({ error: "Vector memory is not configured." }, { status: 503 });
      }
      const { VectorMemory } = await import("./memory/vector-memory");
      const vm = new VectorMemory(env.AI, env.VECTOR_MEMORY, undefined);
      const chunks = await vm.recallForPlan(query, operationFilter, topK);
      // Issue #1740 (Hybrid RAG): additive graph expansion. The
      // dense leg above is unchanged; when AgentDB is bound, the
      // same query gains graph-adjacent market context. Unbound
      // or failed graph means chunks-only, exactly as before.
      let graph: unknown[] = [];
      let graphDegraded = false;
      if ((env as any).AGENT_DB) {
        try {
          const { createMarketGraphAdapter, ensureMarketGraphTables } =
            await import("./retrieval/createRetrievalPorts");
          const { expandGraphContext } = await import(
            "./retrieval/hybridRetrieval"
          );
          const adapter = createMarketGraphAdapter(env as any);
          if (adapter) {
            await ensureMarketGraphTables(adapter);
            const expanded = await expandGraphContext(
              adapter,
              resolveIaaaTenant(env),
              query,
              chunks.map((c) => c.summary),
              { graphTopK: 12 },
            );
            graph = expanded.rows;
            graphDegraded = expanded.degraded;
          }
        } catch (err) {
          console.warn(
            "[retrieval] memory_search graph expansion failed, dense-only:",
            err instanceof Error ? err.message : String(err),
          );
          graphDegraded = true;
        }
      }
      // Issue #1742: consume #1740's retrieval.completed hook —
      // fold this retrieval's counts into the telemetry summary.
      // Best-effort, swallowed: telemetry never fails a search.
      try {
        const { toRetrievalCompletedEnvelope } = await import(
          "./retrieval/hybridRetrieval"
        );
        const { ingestRetrievalCompleted } = await import(
          "./telemetry/retrievalStats"
        );
        ingestRetrievalCompleted(
          toRetrievalCompletedEnvelope({
            denseCount: chunks.length,
            graphCount: graph.length,
            degraded: graphDegraded,
          }),
        );
      } catch (err) {
        console.warn(
          "[telemetry] retrieval.completed ingestion failed (ignored):",
          err instanceof Error ? err.message : String(err),
        );
      }
      return Response.json({ ok: true, chunks, graph, graphDegraded });
    }

    // Issue #159 — ScheduledAgent dashboard API.
    // Issue #1156: session-gated, like the social brief/approval routes
    // below — unauthenticated → 401. Any signed-in user may use the
    // dashboard; no admin gate is invented here. The gate sits before
    // the DO stub so an unauthenticated call never reaches the
    // ScheduledAgent.
    if (path.startsWith("/api/schedule/")) {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const schedId = (env as any).SCHEDULED_AGENT.idFromName("default");
      const sched = (env as any).SCHEDULED_AGENT.get(schedId) as unknown as {
        listGoals(): Promise<unknown[]>;
        getTickHistory(limit?: number): Promise<unknown[]>;
        addGoal(goal: Record<string, unknown>): Promise<unknown>;
        removeGoal(id: string): Promise<boolean>;
        setGoalEnabled(id: string, enabled: boolean): Promise<boolean>;
        triggerGoal(id: string): Promise<unknown>;
      };

      if (path === "/api/schedule/goals" && request.method === "GET") {
        return Response.json({ ok: true, goals: await sched.listGoals() });
      }
      // Issue #1922 — operation catalog for the goals UI dropdown.
      // Session-gated like every other /api/schedule/* route above
      // (unauthenticated → 401); the list is derived from the server
      // catalog at request time, never hardcoded in the client, so
      // the dropdown tracks OPERATION_CATALOG exactly.
      if (path === "/api/schedule/operations" && request.method === "GET") {
        const operations = OPERATION_CATALOG.flatMap((entry) =>
          entry.operations.map((operation) => ({
            operation,
            agent: entry.agent,
            blurb: entry.blurb,
          })),
        );
        return Response.json({ ok: true, operations });
      }
      if (path === "/api/schedule/goals" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return Response.json({ error: "JSON body required." }, { status: 400 });
        try {
          const goal = await sched.addGoal(body);
          return Response.json({ ok: true, goal });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Could not add goal." },
            { status: 400 }
          );
        }
      }
      if (path === "/api/schedule/ticks" && request.method === "GET") {
        const limit = Number(new URL(request.url).searchParams.get("limit") || 20);
        return Response.json({ ok: true, ticks: await sched.getTickHistory(limit) });
      }
      const goalMatch = path.match(/^\/api\/schedule\/goals\/([^/]+)\/(enabled|trigger)$/);
      if (goalMatch && request.method === "POST") {
        const [, id, action] = goalMatch;
        if (action === "enabled") {
          const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
          const enabled = body?.enabled === true;
          const updated = await sched.setGoalEnabled(id, enabled);
          if (!updated) return Response.json({ error: "Goal not found." }, { status: 404 });
          return Response.json({ ok: true });
        }
        const tick = await sched.triggerGoal(id);
        return Response.json({ ok: true, tick });
      }
      const deleteMatch = path.match(/^\/api\/schedule\/goals\/([^/]+)$/);
      if (deleteMatch && request.method === "DELETE") {
        const removed = await sched.removeGoal(deleteMatch[1]);
        if (!removed) return Response.json({ error: "Goal not found." }, { status: 404 });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Unknown schedule endpoint." }, { status: 404 });
    }

    // #1077 Phase 5b slice 2 — social brief provisioning (human path).
    // Placed before the generic /api/ forwarder. Session-gated,
    // like /api/schedule/* above (gated since #1156):
    // unauthenticated → 401.
    // Any signed-in user may provision; gating provisioning to
    // admins is a later item (the IAAA admin panel could own it).
    // Overwrite semantics: the most recent provision wins for the
    // date. A stored brief is content for the social goal only — it
    // is never auto-posted by this route.
    if (path === "/api/social/brief") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const briefStore = createSocialBriefStoreFromNamespace(
        (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
      );
      if (!briefStore) {
        return Response.json({ error: "Social brief store unavailable." }, { status: 500 });
      }
      if (request.method === "GET") {
        const rawDate = new URL(request.url).searchParams.get("date");
        const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
        if (!isBriefDate(date)) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        try {
          const brief = await briefStore.getBrief(date);
          return Response.json({ ok: true, date, brief });
        } catch {
          return Response.json({ error: "Social brief store unavailable." }, { status: 500 });
        }
      }
      if (request.method === "POST") {
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return Response.json({ error: "JSON body required." }, { status: 400 });
        const text = body.text;
        if (typeof text !== "string" || !text.trim()) {
          return Response.json({ error: "text must be a non-empty string." }, { status: 400 });
        }
        if (text.length > SOCIAL_BRIEF_MAX_CHARS) {
          return Response.json(
            { error: `text must be ${SOCIAL_BRIEF_MAX_CHARS} characters or fewer.` },
            { status: 413 },
          );
        }
        const rawDate =
          body.date === undefined ? undefined : typeof body.date === "string" ? body.date : null;
        if (rawDate === null) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
        if (!isBriefDate(date)) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        try {
          await briefStore.putBrief(date, text);
        } catch {
          return Response.json({ error: "Social brief store unavailable." }, { status: 500 });
        }
        return Response.json({ ok: true, date });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // #1077 Phase 5b slice 3 — social approval routes (human path).
    // Placed before the generic /api/ forwarder, next to the brief
    // routes. Session-gated (401 unauthenticated), like the brief
    // routes — never an unauthenticated approve endpoint. Any
    // signed-in user may decide; the workspace trust model is the
    // same as the Slack cards (any workspace member with access).
    // POST /api/social/approval {date, channel, action} approves
    // (publishes promptly through the existing path) or rejects
    // (publishes nothing, record retained). Missing draft → 404;
    // already posted/rejected for the requested decision → 409.
    // GET /api/social/approvals lists pending approvals for a date
    // with draft text, so a reviewer can decide without Slack.
    if (path === "/api/social/approval" || path === "/api/social/approvals") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      const stores = createSocialStoresFromNamespace(
        (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
      );
      if (!stores) {
        return Response.json({ error: "Social stores unavailable." }, { status: 500 });
      }
      if (path === "/api/social/approvals") {
        if (request.method !== "GET") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const rawDate = new URL(request.url).searchParams.get("date");
        const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
        if (!isBriefDate(date)) {
          return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
        }
        try {
          const pending = await stores.approvals.listPending(date);
          const approvals: unknown[] = [];
          for (const record of pending) {
            const draft = await stores.ledger.getDraft(date, record.channel);
            if (!draft) continue;
            approvals.push({
              date,
              channel: record.channel,
              draftId: record.draftId,
              requestedAtMs: record.requestedAtMs,
              text: draft.text,
              status: draft.status,
            });
          }
          return Response.json({ ok: true, date, approvals });
        } catch {
          return Response.json({ error: "Social stores unavailable." }, { status: 500 });
        }
      }
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return Response.json({ error: "JSON body required." }, { status: 400 });
      const date = body.date;
      const channel = body.channel;
      const action = body.action;
      if (
        typeof date !== "string" ||
        !isBriefDate(date) ||
        typeof channel !== "string" ||
        !(KNOWN_SOCIAL_CHANNELS as readonly string[]).includes(channel) ||
        (action !== "approve" && action !== "reject")
      ) {
        return Response.json(
          { error: "date must be YYYY-MM-DD, channel must be a known social channel, action must be approve or reject." },
          { status: 400 },
        );
      }
      const draft = await stores.ledger.getDraft(date, channel);
      if (!draft) {
        return Response.json({ error: `no draft for ${channel} on ${date}` }, { status: 404 });
      }
      if (draft.status === "posted" || draft.status === "failed") {
        return Response.json(
          { error: `draft for ${channel} on ${date} is already ${draft.status}` },
          { status: 409 },
        );
      }
      const rawEnv = env as unknown as Record<string, string | undefined>;
      const socialEnv = {
        SOCIAL_POSTING_ENABLED: rawEnv.SOCIAL_POSTING_ENABLED,
        SOCIAL_AUTONOMOUS_CHANNELS: rawEnv.SOCIAL_AUTONOMOUS_CHANNELS,
        SOCIAL_APPROVAL_CHANNELS: rawEnv.SOCIAL_APPROVAL_CHANNELS,
        SOCIAL_LIVE_PUBLISHING: rawEnv.SOCIAL_LIVE_PUBLISHING,
      };
      if (action === "reject") {
        const rejected = await rejectSocialDraft({
          store: stores.ledger,
          approvals: stores.approvals,
          date,
          channel,
        });
        if (!rejected.ok) {
          return Response.json({ error: rejected.error }, { status: 409 });
        }
        return Response.json({ ok: true, rejected: true, date, channel });
      }
      if (!parseSocialConfig(socialEnv).postingEnabled) {
        return Response.json({ error: "social posting is not enabled" }, { status: 409 });
      }
      const approver = session.internalUserId ?? session.githubLogin ?? "session-user";
      const approved = await approveAndPublish({
        env: socialEnv,
        tokens: {
          X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
          THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
          FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
          INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
          LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
          LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
        },
        store: stores.ledger,
        approvals: stores.approvals,
        transport: createFetchSocialTransport(),
        dryRunSink: createMemoryDryRunSink(),
        nowMs: Date.now(),
        date,
        channel,
        approver,
      });
      if (!approved.ok) {
        return Response.json({ error: approved.error }, { status: 409 });
      }
      return Response.json({
        ok: true,
        approved: true,
        date,
        channel,
        publish: approved.channelResult,
      });
    }

    // Issue #1391: list posts / drafts for date, including submitted platform URLs
    if (path === "/api/social/posts") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const stores = createSocialStoresFromNamespace(
        (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
      );
      if (!stores) {
        return Response.json({ error: "Social stores unavailable." }, { status: 500 });
      }
      const rawDate = new URL(request.url).searchParams.get("date");
      const date = rawDate ?? zonedDateParts(Date.now(), "America/New_York").date;
      if (!isBriefDate(date)) {
        return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
      }
      try {
        const drafts = await stores.ledger.listDrafts(date);
        const posts = drafts.map((draft) => ({
          channel: draft.channel,
          draftId: draft.id,
          date: draft.date,
          status: draft.status,
          text: draft.text,
          platformPostId: draft.platformPostId ?? null,
          submissionEndpoint: resolveSubmissionEndpoint(draft.channel),
          postUrl: resolvePostUrl(draft.channel, draft.platformPostId),
          createdAtMs: draft.createdAtMs,
          approval: draft.approval,
        }));
        return Response.json({ ok: true, date, posts });
      } catch {
        return Response.json({ error: "Social stores unavailable." }, { status: 500 });
      }
    }

    // #1077 token-health slice (#1160) — token presence + validity probe.
    // Session-gated (401 unauthenticated), like the brief/approval
    // routes. Any signed-in user may query; no admin gate invented.
    // GET only; 405 other methods. The response is status only:
    // configured/unconfigured + valid/invalid/unknown per channel,
    // never a token value. No live transport is wired in this slice,
    // so validity is unknown by design until activation wiring passes
    // one — never assumed valid. The goal executor does NOT call this.
    if (path === "/api/social/token-health") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const rawEnv = env as unknown as Record<string, string | undefined>;
      const channels = await checkAllTokenHealth({
        X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
        THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
        FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
        INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
        LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
        LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
      });
      return Response.json({ ok: true, channels });
    }

    // --- User Profile API ---
    if (path === "/api/me") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ authenticated: false });
      }
      // #1274: login-provider display. Derived from the session's own
      // providerIssuer (set at wired login from the binding, never
      // from user input) via the provider registry — so a future
      // provider displays with only a registry entry. Legacy sessions
      // carry no internalUserId/providerIssuer, and unknown issuers
      // resolve to null, so the key is absent in both cases.
      const provider = session.internalUserId
        ? getProviderByIssuer(session.providerIssuer)
        : null;
      return Response.json({
        authenticated: true,
        login: session.githubLogin,
        name: session.githubName,
        avatar: session.githubAvatar,
        // #945 activation enabler (user-authorized): the caller's OWN
        // stable internal id, present only on wired sessions (legacy
        // sessions carry no internalUserId, so the key is absent for
        // them). requireAuth guarantees this is the caller's own
        // session; the id is an identifier, not a credential, and
        // knowing it grants nothing without a login as that user
        // plus the owner-controlled bootstrap env list. It lets the
        // owner read the exact bootstrap value after a wired login
        // instead of looking up their GitHub numeric subject.
        ...(session.internalUserId
          ? { internalUserId: session.internalUserId }
          : {}),
        ...(provider
          ? {
              provider: {
                id: provider.providerId,
                name: provider.displayName,
                issuer: provider.issuer,
              },
            }
          : {}),
      });
    }

    // --- IAAA Admin overview (issue #945, IAAA-UI v1: READ-ONLY) ---
    // GET /api/iaaa/overview: the caller's own memberships, the
    // tenant's platform-genesis status, and recent tenant audit
    // events. Gating is fail-closed and server-side (see
    // iaaaAdminOverview.ts): unauthenticated → 401; legacy session
    // (no internalUserId) or wired non-admin → 403 with NO data;
    // only a live platform-admin membership returns 200. This route
    // performs no store write of any kind, and a corrupt store read
    // answers 500 with a generic error and no partial data.
    if (path === "/api/iaaa/overview") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      if (!session.internalUserId) {
        return Response.json({ error: "Forbidden: IAAA admin access requires a wired session." }, { status: 403 });
      }
      try {
        const overview = await buildAdminOverview(
          {
            membershipStore: createKvMembershipStore(sessionStore(env)),
            auditStore: createWiredAuditStore(env),
            kv: sessionStore(env),
            tenantId: resolveIaaaTenant(env),
            nowMs: Date.now(),
          },
          { callerInternalUserId: session.internalUserId },
        );
        if (!overview.allowed) {
          return Response.json({ error: "Forbidden: IAAA admin access requires platform-admin membership." }, { status: 403 });
        }
        return Response.json(overview);
      } catch {
        return Response.json({ error: "IAAA admin overview unavailable." }, { status: 500 });
      }
    }

    // --- Governance halt seed (issue #1559, slice-0 cutover) ---
    // POST /api/governance/seed-halt: the one-time cutover seed
    // for the AgentDB halt mirror. Gating reuses the IAAA admin
    // pattern exactly (requireAuth → wired session → live
    // platform-admin membership, fail-closed, no data on 403).
    // The seed runs on the shared Orchestrator instance, whose
    // mas_settings holds the canonical kill switch; it writes
    // the mirror row only, never the DO setting, and a second
    // run returns seeded:false with the same state. No boot
    // logic, no auto-run on deploy or tick.
    if (path === "/api/governance/seed-halt") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Governance seed unavailable." }, { status: 500 });
        }
      }
      const stub = env.SEARCH_AGENT.get(
        env.SEARCH_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE),
      ) as unknown as {
        seedGovernanceHalt(
          setBy: string,
          tenantId: string,
        ): Promise<{ seeded: boolean; state: GovernedHaltState }>;
      };
      return handleSeedGovernanceRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runSeed: ({ tenantId, setBy }) => stub.seedGovernanceHalt(setBy, tenantId),
      });
    }

    // --- Chain/schedule projection status (issue #1651, slice 1) ---
    // GET /api/chains/status?chainId=: tenant-scoped read of the
    // AgentDB projection ONLY — never the durable object. Gated
    // by requireAuth (any signed-in user); the tenant comes from
    // the IAAA tenant resolution, so a caller can only ever see
    // their own tenant's rows. Unbound AgentDB → 503.
    if (path === "/api/chains/status") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const chainId = url.searchParams.get("chainId") ?? "";
      const status = session
        ? await readChainStatus(env, tenantId, chainId)
        : null;
      if (!session) {
        return handleChainStatusRoute({
          session: null,
          method: request.method,
          tenantId,
          chainId,
          readStatus: async () => ({ chain: null, schedule: null }),
        });
      }
      if (status === null) {
        return Response.json(
          { error: "Chain status unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleChainStatusRoute({
        session,
        method: request.method,
        tenantId,
        chainId,
        readStatus: async () => status,
      });
    }

    // --- Chain/schedule reconciliation (issue #1651, slice 1) ---
    // POST /api/chains/reconcile: the deliberate operator
    // invocation point for projection reconciliation. Gating
    // reuses the IAAA admin pattern exactly (requireAuth → wired
    // session → live platform-admin membership, fail-closed, no
    // data on 403). Never auto-run: no boot, deploy, or tick
    // path calls it. Runs on the shared ScheduledAgent "default"
    // instance, whose synthesizedSchedules key is authoritative.
    if (path === "/api/chains/reconcile") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Chain reconciliation unavailable." }, { status: 500 });
        }
      }
      const schedId = (env as any).SCHEDULED_AGENT.idFromName("default");
      const sched = (env as any).SCHEDULED_AGENT.get(schedId) as unknown as {
        reconcileChainScheduleProjection(
          tenantId: string,
        ): Promise<ReconcileReport>;
      };
      return handleReconcileChainsRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runReconcile: ({ tenantId }) =>
          sched.reconcileChainScheduleProjection(tenantId),
      });
    }

    // --- Shard job projection history (issue #1676, slice 2) ---
    // GET /api/jobs/history?chainId=: tenant-scoped read of the
    // AgentDB projection ONLY — never the durable object. Gated
    // by requireAuth (any signed-in user); the tenant comes from
    // the IAAA tenant resolution, so a caller can only ever see
    // their own tenant's rows. Unbound AgentDB → 503.
    if (path === "/api/jobs/history") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const chainId = url.searchParams.get("chainId") ?? "";
      const history = session
        ? await readJobHistory(env, tenantId, chainId)
        : null;
      if (!session) {
        return handleJobHistoryRoute({
          session: null,
          method: request.method,
          tenantId,
          chainId,
          readHistory: async () => [],
        });
      }
      if (history === null) {
        return Response.json(
          { error: "Job history unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleJobHistoryRoute({
        session,
        method: request.method,
        tenantId,
        chainId,
        readHistory: async () => history,
      });
    }

    // --- Shard job reconciliation (issue #1676, slice 2) ---
    // POST /api/jobs/reconcile: the deliberate operator
    // invocation point for shard job reconciliation. Gating
    // reuses the IAAA admin pattern exactly (requireAuth → wired
    // session → live platform-admin membership, fail-closed, no
    // data on 403). Never auto-run: no boot, deploy, or tick
    // path calls it. Runs on the shared Orchestrator instance,
    // whose mas_async_jobs rows are the rails source of truth.
    // Unbound AgentDB → 503 (checked before the handler runs).
    if (path === "/api/jobs/reconcile") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Job reconciliation unavailable." }, { status: 500 });
        }
      }
      if (!createShardJobAdapter(env)) {
        return Response.json(
          { error: "Job reconciliation unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      const stub = env.SEARCH_AGENT.get(
        env.SEARCH_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE),
      ) as unknown as {
        reconcileShardJobProjection(
          tenantId: string,
        ): Promise<ReconcileShardJobsReport>;
      };
      return handleReconcileJobsRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runReconcile: ({ tenantId }) =>
          stub.reconcileShardJobProjection(tenantId),
      });
    }

    // --- AgentDB retention purge (issue #1701, slice 6) ---
    // POST /api/retention/purge: the deliberate operator
    // invocation point for retention enforcement. Gating
    // reuses the IAAA admin pattern exactly (requireAuth →
    // wired session → live platform-admin membership,
    // fail-closed, no data on 403). Never auto-run: no boot,
    // deploy, or tick path calls it. Unlike reconciliation,
    // the purge needs no durable-object hop — it touches
    // only the AgentDB projection, so the server calls it
    // directly. Unbound AgentDB → 503 (checked before the
    // handler runs). The governed job definition
    // (RETENTION_PURGE_JOB) is activated by an operator as
    // a separate step; nothing here schedules it.
    if (path === "/api/retention/purge") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Retention purge unavailable." }, { status: 500 });
        }
      }
      if (!createRetentionPurgeStore(env)) {
        return Response.json(
          { error: "Retention purge unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleRetentionPurgeRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runPurge: async ({ tenantId }) => {
          // Null is unreachable here (unbound store returned 503
          // above); the throw keeps the handler's contract total
          // and maps to 500 rather than a silent null.
          const report = await runRetentionPurgeForTenant(env, tenantId, {
            nowMs: Date.now(),
          });
          if (!report) {
            throw new Error(
              "Retention purge unavailable: AgentDB is not bound.",
            );
          }
          return report;
        },
      });
    }

    // --- Telemetry & calibration (issue #1742) ---
    // GET /api/telemetry/summary: any signed-in user; D1 metrics
    // (all five dimensions) + active calibrated notes + live
    // breaker health (#1745 registry snapshots) + retrieval
    // stats (folded #1740 retrieval.completed envelopes).
    // GET /api/telemetry/decisions: any signed-in user.
    // POST /api/telemetry/decisions/:id/decide|apply|supersede|expire:
    // platform-admin only (IAAA admin pattern, same as the
    // reconcile routes). POST /api/telemetry/reconcile:
    // platform-admin only; imports scored track-record ideas
    // for one research:<login> instance (default: the admin's
    // login; ?userLogin= overrides), bounded 500/call, repeat
    // calls converge. Never auto-run: no boot, deploy, or tick
    // path calls these. Reads pass a null store through to the
    // handler (401/503 there); governance paths check the
    // binding first, like the reconcile routes.
    if (
      path === "/api/telemetry/summary" ||
      path === "/api/telemetry/decisions" ||
      path === "/api/telemetry/reconcile" ||
      /^\/api\/telemetry\/decisions\/[^/]+\/(decide|apply|supersede|expire)$/.test(path)
    ) {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const store = createTelemetryAdapter(env as any);
      if (path === "/api/telemetry/summary") {
        if (store) await ensureTelemetryTables(store);
        // Issue #1888: enrichment quality feeds the telemetry
        // summary. Best-effort read of the session user's
        // orchestrator DO enrichment status (the DO owns the run
        // records); any failure leaves the field absent and never
        // fails the summary.
        let enrichmentQuality: import("./enrichment/enrichmentPorts").EnrichmentQualitySummary | null = null;
        if (session?.githubLogin) {
          try {
            const id = env.SEARCH_AGENT.idFromName(session.githubLogin);
            const targetUrl = new URL("/enrichment/status", "https://agent.internal");
            const freq = new Request(targetUrl, {
              headers: { "x-user-login": session.githubLogin },
              signal: AbortSignal.timeout(3000),
            });
            const fres = await env.SEARCH_AGENT.get(id).fetch(freq);
            if (fres.ok) {
              const data = (await fres.json().catch(() => null)) as {
                quality?: import("./enrichment/enrichmentPorts").EnrichmentQualitySummary;
              } | null;
              enrichmentQuality = data?.quality ?? null;
            }
          } catch {
            enrichmentQuality = null;
          }
        }
        return handleTelemetrySummaryRoute({
          session,
          method: request.method,
          tenantId,
          store,
          breakerSnapshots: () => defaultBreakerRegistry().snapshots(),
          retrievalStats: () => retrievalStatsSnapshot(),
          gatewayStats: () => gatewayStatsSnapshot(),
          enrichmentStats: enrichmentQuality ? () => enrichmentQuality : undefined,
        });
      }
      if (path === "/api/telemetry/decisions") {
        if (store) await ensureTelemetryTables(store);
        return handleTelemetryDecisionsRoute({
          session,
          method: request.method,
          tenantId,
          store,
          status: url.searchParams.get("status") ?? undefined,
          actorKey: url.searchParams.get("actorKey") ?? undefined,
          promptKey: url.searchParams.get("promptKey") ?? undefined,
        });
      }
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Telemetry operation unavailable." }, { status: 500 });
        }
      }
      if (!store) {
        return Response.json(
          { error: "Telemetry unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      await ensureTelemetryTables(store);
      if (path === "/api/telemetry/reconcile") {
        const userLogin =
          url.searchParams.get("userLogin") ?? session?.githubLogin ?? "default";
        const researchNs = (env as any).RESEARCH_AGENT as
          | {
              idFromName(name: string): unknown;
              get(id: unknown): unknown;
            }
          | undefined;
        return handleTelemetryReconcileRoute({
          session,
          method: request.method,
          isPlatformAdmin,
          tenantId,
          store,
          userLogin,
          loadTrackRecord: async () => {
            if (!researchNs) {
              throw new Error("ResearchAgent binding not configured.");
            }
            const id = researchNs.idFromName(`research:${userLogin}`);
            const agent = researchNs.get(id) as unknown as {
              getTrackRecord(): Promise<{ ideas: unknown[] }>;
            };
            const record = await agent.getTrackRecord();
            return { ideas: record.ideas as unknown as TrackRecordIdeaInput[] };
          },
        });
      }
      const match = path.match(
        /^\/api\/telemetry\/decisions\/([^/]+)\/(decide|apply|supersede|expire)$/,
      );
      const decisionId = match ? decodeURIComponent(match[1]) : "";
      const action = (match ? match[2] : "decide") as
        | "decide"
        | "apply"
        | "supersede"
        | "expire";
      let verdict: string | undefined;
      if (action === "decide") {
        const body = (await request.json().catch(() => null)) as {
          verdict?: unknown;
        } | null;
        verdict = typeof body?.verdict === "string" ? body.verdict : undefined;
      }
      return handleTelemetryDecisionActionRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId,
        store,
        decisionId,
        action,
        verdict,
        // Issue #1743 — calibration envelopes flow to the stream
        // (calibration_applied on apply); best-effort by engine.
        emit: (envelope) => {
          void writeEnvelopeToSink(
            createObservabilitySink(env),
            envelope,
          );
        },
      });
    }

    // --- Audit history (issue #1688, slice 3) ---
    // GET /api/audit/history?chainId=: tenant-scoped read of the
    // AgentDB audit projection ONLY — never the durable object.
    // Gated by requireAuth (any signed-in user); the tenant comes
    // from the IAAA tenant resolution, so a caller can only ever
    // see their own tenant's rows. Unbound AgentDB → 503.
    if (path === "/api/audit/history") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const chainId = url.searchParams.get("chainId") ?? "";
      const history = session
        ? await readAuditHistory(env, tenantId, chainId)
        : null;
      if (!session) {
        return handleAuditHistoryRoute({
          session: null,
          method: request.method,
          tenantId,
          chainId,
          readHistory: async () => [],
        });
      }
      if (history === null) {
        return Response.json(
          { error: "Audit history unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleAuditHistoryRoute({
        session,
        method: request.method,
        tenantId,
        chainId,
        readHistory: async () => history,
      });
    }

    // --- Canonical reports list (issue #1688, slice 3) ---
    // GET /api/reports/list[?reportId=]: tenant-scoped read of
    // the AgentDB report projection ONLY — never the durable
    // object. Without reportId, latest row per report, newest
    // first; with reportId, that one report. Gated by
    // requireAuth (any signed-in user); tenant from IAAA
    // resolution. Unbound AgentDB → 503. Bodies stay out of
    // the list shape — the durable object holds the full copy.
    if (path === "/api/reports/list") {
      const session = await requireAuth(request, env);
      const tenantId = resolveIaaaTenant(env);
      const reportId = url.searchParams.get("reportId");
      const reports = session
        ? await readReports(env, tenantId, reportId)
        : null;
      if (!session) {
        return handleReportsRoute({
          session: null,
          method: request.method,
          tenantId,
          reportId,
          readReports: async () => [],
        });
      }
      if (reports === null) {
        return Response.json(
          { error: "Reports unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handleReportsRoute({
        session,
        method: request.method,
        tenantId,
        reportId,
        readReports: async () => reports,
      });
    }

    // --- Canonical reports seed (issue #1688, slice 3) ---
    // POST /api/reports/seed-canonical: the deliberate operator
    // invocation point for the one-time canonical mas_reports
    // seed. Gating reuses the IAAA admin pattern exactly
    // (requireAuth → wired session → live platform-admin
    // membership, fail-closed, no data on 403). Never
    // auto-run: no boot, deploy, or tick path calls it. Runs
    // on the shared Orchestrator instance, whose mas_reports
    // is the canonical copy; it writes projection rows only,
    // never the DO table, and a second run seeds zero rows.
    if (path === "/api/reports/seed-canonical") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Reports seed unavailable." }, { status: 500 });
        }
      }
      if (!createAuditReportAdapter(env)) {
        return Response.json(
          { error: "Reports seed unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      const stub = env.SEARCH_AGENT.get(
        env.SEARCH_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE),
      ) as unknown as {
        seedCanonicalReports(
          setBy: string,
          tenantId: string,
        ): Promise<SeedCanonicalReportsResult>;
      };
      return handleSeedReportsRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runSeed: ({ tenantId, setBy }) => stub.seedCanonicalReports(setBy, tenantId),
      });
    }

    // --- Market graph population (issue #1740, Hybrid RAG) ---
    // POST /api/retrieval/populate-market-graph: the deliberate
    // operator invocation point for seeding the D1 market
    // adjacency graph from the curated stock universe. Gating
    // reuses the IAAA admin pattern exactly (requireAuth →
    // wired session → live platform-admin membership,
    // fail-closed, no data on 403). Never auto-run: no boot,
    // deploy, or tick path calls it. Population runs in the
    // Worker (it reads the static universe and writes D1 via
    // the Worker's own AGENT_DB binding — no DO hop needed) and
    // is idempotent: a second run refreshes labels/weights and
    // reports the same counts. Unbound AgentDB → 503.
    if (path === "/api/retrieval/populate-market-graph") {
      const session = await requireAuth(request, env);
      let isPlatformAdmin = false;
      if (session?.internalUserId) {
        try {
          const overview = await buildAdminOverview(
            {
              membershipStore: createKvMembershipStore(sessionStore(env)),
              auditStore: createWiredAuditStore(env),
              kv: sessionStore(env),
              tenantId: resolveIaaaTenant(env),
              nowMs: Date.now(),
            },
            { callerInternalUserId: session.internalUserId },
          );
          isPlatformAdmin = overview.allowed;
        } catch {
          return Response.json({ error: "Market graph population unavailable." }, { status: 500 });
        }
      }
      const { handlePopulateMarketGraphRoute } = await import(
        "./retrieval/populateMarketGraphRoute"
      );
      const { createMarketGraphAdapter, ensureMarketGraphTables } =
        await import("./retrieval/createRetrievalPorts");
      const { populateFromCuratedUniverse } = await import(
        "./retrieval/marketGraphPopulation"
      );
      const adapter = createMarketGraphAdapter(env as any);
      if (!adapter) {
        return Response.json(
          { error: "Market graph population unavailable: AgentDB is not bound." },
          { status: 503 },
        );
      }
      return handlePopulateMarketGraphRoute({
        session,
        method: request.method,
        isPlatformAdmin,
        tenantId: resolveIaaaTenant(env),
        runPopulate: async ({ tenantId }) => {
          await ensureMarketGraphTables(adapter);
          return populateFromCuratedUniverse(adapter, tenantId, Date.now());
        },
      });
    }

    // --- Access requests (issue #1274): request access + admin decide.
    // A signed-in member asks for tenant-admin; an admin approves or
    // denies. Requests NEVER auto-grant: approval calls grantMembership
    // (with its canGrantRole enforcement), and the approval is
    // idempotent — a requester who already holds tenant-admin is
    // marked approved without a duplicate grant. Gating is fail-closed:
    // 401 unauthenticated; 403 legacy sessions, callers with no active
    // membership in the tenant (create), and callers who cannot grant
    // the requested role (list/decide). Only tenant-admin may be
    // requested in this cut; platform-admin requests are 400.
    if (
      path === "/api/iaaa/access-request" ||
      path === "/api/iaaa/access-requests" ||
      path === "/api/iaaa/access-request/decision"
    ) {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (!session.internalUserId) {
        return Response.json({ error: "Forbidden: access requests require a wired session." }, { status: 403 });
      }
      const tenantId = resolveIaaaTenant(env);
      const membershipStore = createKvMembershipStore(sessionStore(env));
      const requestStore = createAccessRequestStore(sessionStore(env));
      const nowMs = Date.now();
      const callerHasActiveMembership = async (): Promise<boolean> => {
        const memberships = await membershipStore.getMembershipsByUser(session.internalUserId as string);
        return memberships.some(
          (m) =>
            m.tenantId === tenantId &&
            m.revokedAtMs === undefined &&
            m.roleBindings.some((b) => b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
        );
      };
      try {
        if (path === "/api/iaaa/access-request") {
          if (request.method !== "POST") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          if (!(await callerHasActiveMembership())) {
            return Response.json({ error: "Forbidden: access requests require an active membership." }, { status: 403 });
          }
          const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
          const requestedRole = typeof body?.requestedRole === "string" ? body.requestedRole : "";
          const created = await requestStore.create({
            requesterInternalUserId: session.internalUserId,
            requestedRole,
            tenantId,
            nowMs,
          });
          if (!created.ok && created.code === "INVALID_ROLE") {
            return Response.json({ error: "Only tenant-admin may be requested." }, { status: 400 });
          }
          if (!created.ok && created.code === "ALREADY_PENDING") {
            return Response.json({ error: "A pending request for this role already exists.", request: created.request }, { status: 409 });
          }
          if (!created.ok) {
            return Response.json({ error: "Access request could not be created." }, { status: 400 });
          }
          return Response.json({ ok: true, request: created.request }, { status: 201 });
        }
        if (path === "/api/iaaa/access-requests") {
          if (request.method !== "GET") {
            return Response.json({ error: "Method not allowed" }, { status: 405 });
          }
          const grantCheck = await canGrantRole(membershipStore, {
            granterInternalUserId: session.internalUserId,
            targetTenantId: tenantId,
            targetScope: "tenant",
            targetRole: "tenant-admin",
            nowMs,
          });
          if (grantCheck.decision === "deny") {
            return Response.json({ error: "Forbidden: listing access requests requires tenant-admin." }, { status: 403 });
          }
          return Response.json({ ok: true, requests: await requestStore.list() });
        }
        // POST /api/iaaa/access-request/decision
        if (request.method !== "POST") {
          return Response.json({ error: "Method not allowed" }, { status: 405 });
        }
        const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
        const requestId = typeof body?.requestId === "string" ? body.requestId : "";
        const decision = body?.decision === "approve" || body?.decision === "deny" ? body.decision : "";
        if (requestId === "" || decision === "") {
          return Response.json({ error: "requestId and decision (approve|deny) are required." }, { status: 400 });
        }
        const existing = await requestStore.get(requestId);
        if (!existing) {
          return Response.json({ error: "Access request not found." }, { status: 404 });
        }
        const grantCheck = await canGrantRole(membershipStore, {
          granterInternalUserId: session.internalUserId,
          targetTenantId: tenantId,
          targetScope: "tenant",
          targetRole: existing.requestedRole,
          nowMs,
        });
        if (grantCheck.decision === "deny") {
          return Response.json({ error: "Forbidden: deciding access requests requires tenant-admin." }, { status: 403 });
        }
        if (existing.status !== "pending") {
          return Response.json({ error: "Access request is no longer pending.", request: existing }, { status: 409 });
        }
        if (decision === "approve") {
          const targetMemberships = await membershipStore.getMembershipsByUser(existing.requesterInternalUserId);
          const alreadyAdmin = targetMemberships.some(
            (m) =>
              m.tenantId === tenantId &&
              m.revokedAtMs === undefined &&
              m.roleBindings.some(
                (b) => b.role === "tenant-admin" && (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
              ),
          );
          if (!alreadyAdmin) {
            const granted = await grantMembership(membershipStore, {
              granterInternalUserId: session.internalUserId,
              internalUserId: existing.requesterInternalUserId,
              tenantId,
              roleBindings: [{ role: existing.requestedRole, scope: "tenant", grantedBy: session.internalUserId }],
              nowMs,
            });
            if (!granted.ok) {
              return Response.json({ error: "Forbidden: grant denied." }, { status: 403 });
            }
          }
        }
        const decided = await requestStore.decide(requestId, decision === "approve" ? "approved" : "denied", session.internalUserId, nowMs);
        if (!decided.ok) {
          return Response.json({ error: "Access request is no longer pending." }, { status: 409 });
        }
        return Response.json({ ok: true, request: decided.request });
      } catch {
        return Response.json({ error: "Access requests unavailable." }, { status: 500 });
      }
    }

    // --- API Keys (issue #180): per-user keys for the MCP transport ---
    // Session-required, and a session can only ever list, mint, or revoke
    // its OWN keys (the #154 pattern: identity = session login only).
    // Minting returns the plaintext secret exactly once; the server stores
    // only its SHA-256 hash (src/security/apiKeys.ts).
    if (path === "/api/api-keys") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in with GitHub" }, { status: 401 });
      }
      const login = session.githubLogin;

      if (request.method === "GET") {
        return Response.json({ keys: await listApiKeys(env, login) });
      }
      if (request.method === "POST") {
        // #945 Phase 2b-part1 step-up pilot: minting a credential
        // is a sensitive action. Wiring ON + stale authentication
        // (including every legacy session, which has no authTimeMs)
        // fails closed with 403 and mints nothing; the user
        // re-authenticates and retries. Listing and revoking keys
        // are deliberately NOT gated: revocation especially must
        // never be blocked by staleness.
        // #945 GitHub end-to-end: minting is NOT additionally PDP
        // gated — no Slice 3 permission maps to credential minting
        // (there is no credential:issue permission), so step-up
        // remains the sole gate here. See the defaults doc.
        if (requiresStepUpForMint(session, isWiringEnabled(env), Date.now())) {
          return Response.json({ error: "Step-up authentication required: please sign in again and retry." }, { status: 403 });
        }
        const body = (await request.json().catch(() => ({}))) as { label?: unknown };
        const label = typeof body.label === "string" ? body.label : "";
        const minted = await mintApiKey(env, login, label);
        return Response.json({ key: minted.key, secret: minted.secret }, { status: 201 });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    if (path.startsWith("/api/api-keys/")) {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in with GitHub" }, { status: 401 });
      }
      if (request.method === "DELETE") {
        const keyId = decodeURIComponent(path.slice("/api/api-keys/".length));
        const revoked = keyId ? await revokeApiKey(env, session.githubLogin, keyId) : false;
        if (!revoked) return Response.json({ error: "API key not found." }, { status: 404 });
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // --- Model Context Protocol (MCP) JSON-RPC 2.0 & Discovery Endpoint ---
    // Issue #180: transport identity is the app session OR a per-user API
    // key (Authorization: Bearer cfk_…, see src/security/apiKeys.ts) bound
    // to the login that minted it. The caller-asserted `x-user-id` header
    // no longer asserts anything — it previously SELECTED the agent DO
    // instance, so asserting a victim's login ran the full tool registry
    // inside their instance, and anonymous callers shared an "mcp_client"
    // instance. No credential → 401 before any DO access. The in-app
    // explorer (McpApiExplorer) rides the session cookie and is unchanged.
    if (path === "/mcp" || path === "/api/mcp") {
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      const session = await requireAuth(request, env);
      let userLogin = session?.githubLogin;
      if (!userLogin) {
        const verified = await verifyApiKey(env, bearerKeyFromRequest(request));
        userLogin = verified?.login;
      }
      if (!userLogin) {
        return Response.json(
          { error: "Unauthorized: an app session or a valid API key is required." },
          { status: 401, headers: corsHeaders }
        );
      }
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/mcp" + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      // #1744: principal kind for the MCP permission gate — the DO
      // cannot tell session from API-key auth from the login alone.
      forwardReq.headers.set("x-principal-kind", session ? "session" : "api-key");

      const resp = await env.SEARCH_AGENT.get(id).fetch(forwardReq);
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Cloudflare Wallets / x402 Pay-Per-Use Options Scanner MCP Endpoint ---
    // No session auth required — payment IS the access control (x402 paidTool).
    // MCP clients connect to /mcp/scanner and pay $0.05 USDC via Cloudflare Wallets.
    if (path === "/mcp/scanner" || path.startsWith("/mcp/scanner/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED",
            "Access-Control-Expose-Headers":
              "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Payment-Receipt",
          },
        });
      }

      // Session AFFINITY, not identity (issue #700): this value only
      // picks which OptionsScannerMCP instance serves the client, so a
      // client's queued scans stay on one instance. No identity
      // propagates downstream on this route — the scanner DO never reads
      // either header and forwards under its own context — so a
      // login-shaped value asserts nothing (contrast the #154/#180/#183
      // routes, where the established identity selects the caller's own
      // agent instance). The honest header is `x-scanner-session`;
      // `x-user-id` is a DEPRECATED alias retained only for instance
      // continuity: dropping it would strand in-flight clients on a
      // different instance and orphan their queued scan jobs. With
      // neither header, traffic shares the "public_scanner" instance.
      const scannerAffinityId =
        request.headers.get("x-scanner-session") ||
        request.headers.get("x-user-id") ||
        "public_scanner";
      const scannerId = (env as any).OPTIONS_SCANNER_MCP.idFromName(scannerAffinityId);
      const scannerUrl = new URL(
        path.replace("/mcp/scanner", "") || "/" + url.search,
        "https://scanner.internal",
      );

      const resp = await (env as any).OPTIONS_SCANNER_MCP.get(scannerId).fetch(
        new Request(scannerUrl, request),
      );
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE");
      headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Cloudflare Agentic Payments: CORS preflight (premium + wallet families) ---
    if ((path.startsWith("/api/premium/") || path.startsWith("/api/payments/agentic/")) && request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-environment",
          "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt",
        },
      });
    }

    // --- Agentic Wallet API (/api/payments/agentic/*) ---
    // Issue #183: a session is REQUIRED for the wallet family (the #154
    // pattern) — the wallet and its HITL auto-approve limit are the
    // signed-in user's own state. Previously a null session fell back
    // to the caller-supplied x-user-id header or a shared
    // "agentic_consumer" instance, so an unauthenticated caller could
    // read and mutate a shared wallet (and select any user's instance
    // by asserting their login). The fallback identities are removed;
    // the only in-app caller (AgenticWalletPanel) is signed in.
    if (path.startsWith("/api/payments/agentic/")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);

      const resp = await env.SEARCH_AGENT.get(id).fetch(forwardReq);
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-environment");
      headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- Premium Paid Endpoints (/api/premium/*) ---
    // Issue #183: payment (x402) is the access control for premium
    // endpoints, so anonymous paid access stays — but identity is never
    // asserted. With a session, traffic runs under the session login,
    // exactly as before. Without one, caller-supplied identity headers
    // are stripped and the request is served by the dedicated
    // PREMIUM_GATEWAY instance (nobody's user instance — the instance
    // name itself is the downstream signal that this is anonymous
    // traffic); the premium handlers bind every persisted payment row
    // and the fulfillment identity to the VERIFIED payer instead.
    // Previously an asserted x-user-id selected ANY user's instance
    // and premium fulfillment ran under that asserted login.
    if (path.startsWith("/api/premium/")) {
      const session = await requireAuth(request, env);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      let id;
      if (session) {
        forwardReq.headers.set("x-user-login", session.githubLogin);
        id = env.SEARCH_AGENT.idFromName(session.githubLogin);
      } else {
        forwardReq.headers.delete("x-user-login");
        forwardReq.headers.delete("x-user-id");
        id = env.SEARCH_AGENT.idFromName(PREMIUM_GATEWAY_INSTANCE);
      }

      const resp = await env.SEARCH_AGENT.get(id).fetch(forwardReq);
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-environment");
      headers.set("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt");
      return new Response(resp.body, { status: resp.status, headers });
    }

    // --- External Payment Webhook Listeners (Stripe, PayPal, Lemon Squeezy) ---
    if (path.startsWith("/api/payments/webhook") || path === "/payments/webhook") {
      const id = env.SEARCH_AGENT.idFromName("system_webhook_receiver");
      const targetUrl = new URL("/payments/webhook" + url.search, "https://agent.internal");
      return env.SEARCH_AGENT.get(id).fetch(new Request(targetUrl, request));
    }

    // --- Omnichannel Trading Agent: Inbound Email Webhook & Simulator ---
    // Issue #154: a session is REQUIRED for the omnichannel test/simulator
    // routes (this one and the Slack/voice siblings below). They forward
    // into the caller's agent, whose handlers process trade commands
    // (inbound-email APPROVE, Slack events, voice turns) — previously a
    // null session silently proceeded under a shared hard-coded fallback
    // identity, so an UNAUTHENTICATED caller could drive them. The
    // fallback identities are removed (the #149 pattern); the in-app
    // callers (ETradeTradingHub, ResearchReportActions) are signed in
    // and unaffected.
    if (path === "/api/trading/email/inbound" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/email/inbound", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Signed Email Approval Link Click ---
    // Issue #1262 Phase 5: a link click is NOT session-authenticated —
    // the signed token is the authorization (HMAC + expiry + login
    // binding, #149 pattern). The worker verifies the token's shape
    // fast (fail-closed HTML page, no DO round-trip for junk), then
    // forwards to the Orchestrator DO /trading/email/approve-link,
    // which verifies again (signature + expiry + principal-map
    // re-check) and executes through the shared engine. The DO
    // instance is the inbound-email instance constant (imported, not
    // copied — its value is #1289's scope; a rebase onto post-#1289
    // main picks up the new value automatically).
    if (path === "/api/trading/email/approve" && request.method === "GET") {
      const escapeHtml = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const renderPage = (title: string, body: string) =>
        new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
            `<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">` +
            `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      const token = url.searchParams.get("token") || "";
      const fastCheck = await verifyApprovalLinkForPrincipal(env, token, undefined);
      if (!fastCheck.ok) {
        return renderPage("Approval link invalid", fastCheck.error);
      }
      const id = env.SEARCH_AGENT.idFromName(INBOUND_EMAIL_ORCHESTRATOR_INSTANCE);
      const targetUrl = new URL("/trading/email/approve-link", "https://agent.internal");
      const forwardRes = await env.SEARCH_AGENT.get(id).fetch(
        new Request(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        })
      );
      const result = (await forwardRes.json().catch(() => ({}))) as any;
      if (result.success) {
        return renderPage(
          "Order executed",
          `Order ${result.orderId ?? ""} executed on E*TRADE${result.execId ? ` (reference ${result.execId})` : ""}.`
        );
      }
      return renderPage(
        "Approval not completed",
        result.message || "The approval link could not be completed. The order was not executed."
      );
    }

    // --- Omnichannel Trading Agent: Slack Test Simulator ---
    if (path === "/api/trading/slack/test" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/slack/event", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Principal Link Confirm ---
    // Issue #1262 Phase 1: a signed-in user confirms the connect code
    // the bot issued in a Slack DM (`link`). The code names the Slack
    // user (team_id + user_id); the SESSION names the account — the
    // binding written is slack user → session.githubLogin at tier
    // "trade". Self-binding only: no request field can name the login.
    if (path === "/api/trading/slack/link" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const body = (await request.json().catch(() => ({}))) as any;
      const result = await confirmSlackLink(
        env,
        typeof body.code === "string" ? body.code : "",
        session.githubLogin
      );
      if (!result.ok) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }
      return Response.json({
        ok: true,
        teamId: result.teamId,
        slackUserId: result.userId,
        login: result.login,
        tier: result.tier,
      });
    }

    // --- Omnichannel Trading Agent: Voice Trading Turn Simulator & API ---
    if ((path === "/api/trading/voice/turn" || path === "/api/trading/voice/test") && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/voice/turn", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Voice Welcome Greeting ---
    if (path === "/api/trading/voice/greeting" && request.method === "GET") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/voice/greeting", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Options Intelligence: Forwarder for Options Endpoints (Catalog, Strategies, Screen, Unified, Config) ---
    if ((path.startsWith("/api/trading/options/") || path.startsWith("/trading/options/")) && (request.method === "POST" || request.method === "GET")) {
      // Issue #154: session required, identity is the SESSION login only.
      // Previously a null session fell back to the caller-supplied
      // x-user-login header (or a shared synthetic identity), letting an
      // unauthenticated caller select ANY user's agent instance. This
      // matches the session-required catch-all /api/ forwarder below;
      // in-app callers send their session cookie and are unaffected.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Cloudflare Agents Task Scheduling Management APIs ---
    if (path.startsWith("/api/schedules") || path === "/api/schedules") {
      // Issue #154: session required, identity is the SESSION login only
      // (schedules are per-user state: create/cancel/trigger). Previously
      // a null session fell back to the caller-supplied x-user-login
      // header or a shared synthetic identity.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Voice WebSocket Session ---
    if ((path === "/voice/trade" || path === "/api/trading/voice/ws") && request.headers.get("Upgrade") === "websocket") {
      // Issue #154: the voice-trading session requires an app session,
      // checked BEFORE the WebSocket is accepted. Previously a null
      // session proceeded under a shared synthetic voice identity, so an
      // unauthenticated caller could open a voice trading session.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      const userLogin = session.githubLogin;

      // Issue #815: the worker isolate has no ORM (an ORM wraps a
      // specific Durable Object's storage.sql), so voice turns are
      // forwarded per-turn to the session user's orchestrator DO, whose
      // POST /trading/voice/turn route runs the voice service against
      // the DO's real ORM. The forwarder keys the DO instance by, and
      // sets the identity header from, the verified session login above
      // — never from caller input.
      const forwardVoiceTurn = createOrchestratorVoiceTurnForwarder(env, userLogin);
      handleVoiceWebSocketConnection(serverWs, env, undefined, userLogin, forwardVoiceTurn).catch(console.warn);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // --- Real-Time Market Data Quotes WebSocket Session (Issue #21) ---
    if ((path === "/api/market-data/quotes/ws" || path === "/api/market/quotes/ws" || path === "/api/foss/quotes/ws") && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      // #1725: WS run carriers are the x-quote-expiry-mode /
      // x-quote-stream-provenance headers; the WS branch always
      // passes env (Alpaca possible), unlike the HTTP branch below.
      // No auth and no audit on this surface, in every mode (M10).
      handleMarketQuotesWebSocket(serverWs, env, {
        expiryMode: request.headers.get("x-quote-expiry-mode") ?? undefined,
        streamProvenance: request.headers.get("x-quote-stream-provenance") ?? undefined,
      }).catch(console.warn);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // --- Batch Market Quotes HTTP Endpoint (Fallback for non-WebSocket clients) ---
    if ((path === "/api/market-data/quotes" || path === "/api/market/quotes" || path === "/api/foss/quotes") && request.method === "GET") {
      const symbolsParam = url.searchParams.get("symbols") || "";
      const symbols = symbolsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // #1725 (M2b): QUOTE_HTTP_PROVIDER_MODE, default "yahoo-only"
      // (the verified call-site fact — this branch previously passed
      // no env at all). Run carriers: x-quote-http-provider-mode
      // header, ?httpProviderMode= query param. Under "env" the
      // Worker env is passed through and HTTP refreshes can use
      // Alpaca when configured; under "yahoo-only" (and on any
      // invalid value, which fails closed with a console warning)
      // env is withheld. The handler still receives env for MODE
      // resolution via envForModes, so the QUOTE_EXPIRY_MODE env
      // level is not lost when the fetch env is withheld. No auth
      // and no audit on this surface, in every mode (M10 stands);
      // the response stays 200 with unavailable[] even when every
      // symbol is unavailable.
      const httpProviderMode = resolveQuoteHttpProviderMode(
        levelsForQuoteSwitch(
          undefined,
          request.headers.get("x-quote-http-provider-mode") ?? url.searchParams.get("httpProviderMode") ?? undefined,
          env.QUOTE_HTTP_PROVIDER_MODE
        ),
        "yahoo-only"
      ).mode;
      const expiryMode = resolveQuoteExpiryMode(
        levelsForQuoteSwitch(
          undefined,
          request.headers.get("x-quote-expiry-mode") ?? url.searchParams.get("expiryMode") ?? undefined,
          env.QUOTE_EXPIRY_MODE
        ),
        "honour"
      ).mode;
      return handleMarketQuotesHttp(
        symbols.length > 0
          ? symbols
          : ["NVDA", "AAPL", "MSFT", "TSLA", "SPY", "QQQ", "BTC/USD", "ETH/USD", "SOL/USD"],
        httpProviderMode === "env" ? env : undefined,
        { expiryMode, envForModes: env }
      );
    }

    // --- Cloudflare Browser Agent: Webhook Snapshot API ---
    if ((path === "/api/browser/snapshot" || path === "/browser/snapshot") && request.method === "POST") {
      // Issue #181: snapshots dispatch Slack posts — require a valid app session.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        const body = (await request.json()) as any;
        const targetUrl = body.url || "https://etrade.com";
        const browserService = new ETradeBrowserService(env);
        const snapResult = await browserService.captureAndSendToSlack(targetUrl, {
          webhookUrl: body.webhookUrl || env.SLACK_WEBHOOK_URL,
          caption: body.caption,
          channel: body.channel,
        });
        return Response.json(snapResult);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // --- Cloudflare Browser Agent: Transaction Snap to Slack via Webhook API ---
    if ((path === "/api/browser/transaction-snap" || path === "/browser/transaction-snap" || path === "/api/browser/snap/transaction") && request.method === "POST") {
      // Issue #181: see above — require a valid app session.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const tx: TransactionSnapData = body.transaction || body;
        if (!tx || !tx.symbol) {
          return Response.json({ error: "Transaction data with symbol is required." }, { status: 400 });
        }
        // #1733 (R06): the identity fallback chain lives in the
        // port helper — no behavior change. Session conditions:
        // requireAuth above already 401'd without a valid app
        // session, and a missing tx.symbol already 400'd, so the
        // header or tx.symbol always wins on the reachable path
        // and the "browser_trader" literal is a defensive default
        // only. The DO route has no fallback (one shared block).
        const userLogin = resolveSnapIdentity(request.headers.get("x-user-login"), tx.symbol);
        const id = env.SEARCH_AGENT.idFromName(userLogin);
        const targetUrl = new URL("/trading/browser/transaction-snap", "https://agent.internal");
        const forwardReq = new Request(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-user-login": userLogin },
          body: JSON.stringify(body),
        });
        return env.SEARCH_AGENT.get(id).fetch(forwardReq);
      } catch (err: any) {
        return Response.json({ success: false, error: err.message }, { status: 500 });
      }
    }

    // --- Omnichannel Trading Agent: Slack Slash Commands (/snap, /trade, /quote, /screen, etc.) ---
    if ((path === "/slack/commands" || path === "/slack/slash") && request.method === "POST") {
      // Issue #147: signature verification is mandatory — unconfigured
      // is a loud 503, never a silent pass-through (see gateSlackRequest).
      const gate = await gateSlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      const rawBody = gate.rawBody;

      const params = new URLSearchParams(rawBody);
      const teamId = params.get("team_id") || "default_workspace";
      const id = env.SEARCH_AGENT.idFromName(`slack_${teamId}`);
      const targetUrl = new URL("/trading/slack/command", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: rawBody,
      });
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Events Webhook ---
    if ((path === "/slack" || path === "/slack/events") && request.method === "POST") {
      // Issue #147: signature verification is mandatory — unconfigured
      // is a loud 503, never a silent pass-through (see gateSlackRequest).
      const gate = await gateSlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      const rawBody = gate.rawBody;

      let parsed: any;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (parsed.type === "url_verification") {
        return Response.json({ challenge: parsed.challenge });
      }

      // Multi-tenant: Route to workspace DO or fallback receiver
      const teamId = parsed.team_id || "default_workspace";
      const id = env.SEARCH_AGENT.idFromName(`slack_${teamId}`);
      const targetUrl = new URL("/trading/slack/event", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Interactive Component Actions ---
    if (path === "/slack/interactions" && request.method === "POST") {
      // Issue #147: signature verification is mandatory — unconfigured
      // is a loud 503, never a silent pass-through (see gateSlackRequest).
      const gate = await gateSlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!gate.ok) return gate.response;
      const rawBody = gate.rawBody;

      const params = new URLSearchParams(rawBody);
      const payloadRaw = params.get("payload");
      if (!payloadRaw) {
        return new Response("Missing payload", { status: 400 });
      }

      let payload: any;
      try {
        payload = JSON.parse(payloadRaw);
      } catch {
        return new Response("Invalid payload JSON", { status: 400 });
      }

      // #1077 Phase 5b slice 3: social approval cards are answered
      // here, AFTER the #147 gate above and BEFORE the trading
      // forward. A social action_id (social_approve/social_reject)
      // never reaches trading; any other action_id falls through to
      // trading exactly as before. The handler verifies the card's
      // draftId against the pending record, so a stale card cannot
      // approve a rebuilt draft. Production passes no live transport
      // (the Phase 5a gap): live publish-on-approve fails honestly
      // here exactly as the goal path does; dry-run works end to end.
      const socialParsed = parseSocialAction(payload);
      if (socialParsed.kind !== "other") {
        const socialStores = createSocialStoresFromNamespace(
          (env as unknown as { SESSION_STORE?: DoNamespaceLike }).SESSION_STORE ?? null,
        );
        if (!socialStores) {
          return new Response("Social stores unavailable", { status: 500 });
        }
        const rawEnv = env as unknown as Record<string, string | undefined>;
        // Issue #1262 Phase 2 (social convergence): a social APPROVE
        // requires a resolved principal — the clicker's Slack identity
        // linked to a trading login (Phase 1 link store). Unlinked
        // clickers get a refusal with a link hint; REJECT stays open
        // to any clicker (fail-safe: rejecting only prevents
        // publication). The handler stamps the resolved login as the
        // approver when one exists, else the legacy slack:<userId>.
        const clickerPrincipal = await resolvePrincipal(
          env,
          {
            channel: "slack",
            channelUserId: payload.user?.id ?? "",
            channelScopeId: payload.team?.id ?? "",
            text: "",
          },
          { slackLinks: slackPrincipalLinkStoreFromEnv(env) }
        );
        const outcome = await handleSocialSlackInteraction({
          payload,
          principal: clickerPrincipal,
          env: {
            SOCIAL_POSTING_ENABLED: rawEnv.SOCIAL_POSTING_ENABLED,
            SOCIAL_AUTONOMOUS_CHANNELS: rawEnv.SOCIAL_AUTONOMOUS_CHANNELS,
            SOCIAL_APPROVAL_CHANNELS: rawEnv.SOCIAL_APPROVAL_CHANNELS,
            SOCIAL_LIVE_PUBLISHING: rawEnv.SOCIAL_LIVE_PUBLISHING,
          },
          tokens: {
            X_ACCESS_TOKEN: rawEnv.X_ACCESS_TOKEN,
            THREADS_ACCESS_TOKEN: rawEnv.THREADS_ACCESS_TOKEN,
            FACEBOOK_PAGE_ACCESS_TOKEN: rawEnv.FACEBOOK_PAGE_ACCESS_TOKEN,
            INSTAGRAM_ACCESS_TOKEN: rawEnv.INSTAGRAM_ACCESS_TOKEN,
            LINKEDIN_ACCESS_TOKEN: rawEnv.LINKEDIN_ACCESS_TOKEN,
            LINKEDIN_AUTHOR_URN: rawEnv.LINKEDIN_AUTHOR_URN,
          },
          store: socialStores.ledger,
          approvals: socialStores.approvals,
          transport: undefined,
          dryRunSink: createMemoryDryRunSink(),
          nowMs: Date.now(),
        });
        if (outcome.handled) {
          return Response.json({
            response_type: "in_channel",
            replace_original: true,
            text: outcome.message,
            blocks: outcome.blocks,
          });
        }
      }

      const teamId = payload.team?.id || "default_workspace";
      const id = env.SEARCH_AGENT.idFromName(`slack_${teamId}`);
      const targetUrl = new URL("/trading/slack/interaction", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack OAuth Install & Callback ---
    if (path === "/slack/install") {
      const clientId = env.SLACK_CLIENT_ID;
      if (!clientId) {
        return new Response("SLACK_CLIENT_ID is not configured in environment.", { status: 500 });
      }
      const redirectUri = `${env.APP_BASE_URL || "https://agent.openaimp.com"}/slack/oauth_callback`;
      const installUrl = ETradeSlackTradingService.getInstallUrl(clientId, redirectUri);
      return Response.redirect(installUrl, 302);
    }

    if (path === "/slack/oauth_callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return Response.redirect("/?tab=trading&error=missing_slack_code", 302);
      }
      const clientId = env.SLACK_CLIENT_ID || "";
      const clientSecret = env.SLACK_CLIENT_SECRET || "";
      const redirectUri = `${env.APP_BASE_URL || "https://agent.openaimp.com"}/slack/oauth_callback`;
      try {
        const tokens = await ETradeSlackTradingService.exchangeOAuthCode(code, clientId, clientSecret, redirectUri);
        // Issue #329: the team token used to be written to KV under
        // `slack_token_{teamId}`, but nothing in the Worker ever read it back —
        // pure write-quota spend. Posting goes through the Slack service itself.
        return Response.redirect(`/?tab=trading&slack=connected&team=${encodeURIComponent(tokens.teamName)}`, 302);
      } catch (err: any) {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(err.message || "slack_oauth_failed")}`, 302);
      }
    }

    // --- Session-Authenticated HITL Trade Approval Shortcut ---
    // Issue #149: no signed/bearer approval links exist in this product —
    // nothing mints signature-carrying approval links for this route (the copy that
    // claimed HMAC-signed links with a 300s expiry was fiction and has been
    // corrected). Approval requires the caller's own app session, exactly
    // like the in-app approval buttons: this route forwards the decision
    // to the session user's agent, whose /etrade/order/execute handler
    // re-checks the HITL gate, that the draft exists and is still
    // "previewed" (drafts expire unexecuted via expireStaleOrderDraft),
    // and that execution parameters match the preview. Previously this
    // route proceeded under a hard-coded fallback identity when no session
    // existed, letting an UNAUTHENTICATED request attempt execution under
    // an assumed identity — that fallback is removed.
    if (path === "/trade/approve") {
      const orderId = url.searchParams.get("orderId");
      if (!orderId) {
        return new Response("Missing orderId parameter", { status: 400 });
      }
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response("Unauthorized: sign in to approve a trade.", { status: 401 });
      }
      const userLogin = session.githubLogin;
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/etrade/order/execute", "https://agent.internal");
      const forwardReq = new Request(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-login": userLogin },
        body: JSON.stringify({ orderId, decision: "approved" }),
      });
      const res = await env.SEARCH_AGENT.get(id).fetch(forwardReq);
      const json = (await res.json().catch(() => ({}))) as any;

      if (json.success) {
        return Response.redirect(`/?tab=trading&executedOrder=${encodeURIComponent(orderId)}&brokerRef=${encodeURIComponent(json.brokerOrderRef || json.executionId || "")}`, 302);
      } else {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(json.error || "Execution failed")}`, 302);
      }
    }

    // --- Direct Clear & Reset Session Endpoints (Always Synchronous) ---
    if (path === "/clear" || path === "/reset" || path === "/api/clear" || path === "/api/reset") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const id = env.SEARCH_AGENT.idFromName(session.githubLogin);
      const targetUrl = new URL(`/clear${url.search}`, "https://agent.internal");

      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", session.githubLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Options Flows Endpoints (Live, Historical, News, Insider, Congress, Summary, Presets) ---
    if (path.startsWith("/api/options/flows/")) {
      const sub = path.replace("/api/options/flows/", "").split("?")[0];
      const tickerParam = url.searchParams.get("tickers");
      const tickers = tickerParam ? tickerParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
      const minPrem = Number(url.searchParams.get("minPremium") || 0);
      const marketCapsParam = url.searchParams.get("marketCaps");
      const marketCaps = marketCapsParam ? (marketCapsParam.split(",").map((c) => c.trim()).filter(Boolean) as MarketCapCategory[]) : undefined;
      const assetTypesParam = url.searchParams.get("assetTypes");
      const assetTypes = assetTypesParam ? (assetTypesParam.split(",").map((c) => c.trim()).filter(Boolean) as AssetClassCategory[]) : undefined;
      // Issue #925: the generated sample universe is demo-regime only —
      // it takes an explicit dataMode=demo request on top of the #65 demo
      // gate; a live request never receives generated items as fallback.
      const dataMode = url.searchParams.get("dataMode") === "demo" ? "demo" : "live";
      // Issue #925: when no chain data is available, the envelope says so
      // explicitly instead of silently carrying substitute numbers.
      const flowDataUnavailableReason =
        "No live option-chain data is available; generated sample data is not served outside demo mode.";

      if (sub === "live" || sub === "historical") {
        const flows = await getDynamicLiveFlowItems(env, { tickers, minPremium: minPrem, marketCaps, assetTypes }, { dataMode });
        return Response.json({
          success: true,
          count: flows.length,
          total: flows.length,
          flows,
          // Issue #119: there is no trade tape — disclose the modelled
          // basis of every item at the envelope level too.
          provenance: summarizeFlowProvenance(flows),
          ...(flows.length === 0
            ? { dataUnavailable: true, unavailableReason: flowDataUnavailableReason }
            : {}),
          ...(sub === "historical"
            ? {
              note: "No historical options trade tape is available in this product; this returns the current modelled flow estimates, not archived prints.",
            }
            : {}),
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "news") {
        const liveNews = await fetchRealMarketNews(tickers, env);
        return Response.json({
          success: true,
          count: liveNews.length,
          total: liveNews.length,
          news: liveNews,
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "insider") {
        const liveInsiders = await fetchRealSecInsiderFilings({ tickers, minPremium: minPrem });
        return Response.json({
          success: true,
          count: liveInsiders.length,
          total: liveInsiders.length,
          insiders: liveInsiders,
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "congress") {
        const chamber = url.searchParams.get("chamber") || undefined;
        const party = url.searchParams.get("party") || undefined;
        const liveCongress = await fetchRealCongressDisclosures({ tickers, chamber, party });
        return Response.json({
          success: true,
          count: liveCongress.length,
          total: liveCongress.length,
          congress: liveCongress,
          isDynamic: true,
          updatedAt: new Date().toISOString(),
        });
      }
      if (sub === "summary") {
        const summary = await getDynamicFlowSummary(env, { tickers, minPremium: minPrem, marketCaps, assetTypes }, { dataMode });
        return Response.json({
          success: true,
          summary,
          ...(summary.totalTrades === 0
            ? { dataUnavailable: true, unavailableReason: flowDataUnavailableReason }
            : {}),
          isDynamic: true,
        });
      }
      if (sub === "presets") {
        return Response.json({
          success: true,
          presets: DEFAULT_SAVED_PRESETS,
        });
      }
    }

    // --- OpenAPI + Swagger spike (issue #1024 Phase 1) ---
    // GET /openapi.json serves the generated spec; GET /api/docs serves
    // the Swagger UI page against it. PROVISIONAL gating: both routes
    // require an authenticated session (unauthenticated → 401). The
    // #1024 design decision on docs exposure is still open; this
    // session gate is the safe spike default, not the final decision.
    // Placed before the generic /api/ forwarder so /api/docs is not
    // forwarded to the DO.
    if (path === "/openapi.json" || path === "/api/docs") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ error: "Unauthorized: Please log in." }, { status: 401 });
      }
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      if (path === "/openapi.json") {
        return Response.json(buildOpenApiSpec());
      }
      return new Response(SWAGGER_UI_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // --- Forwarded Durable Object APIs (NLQ, Audit, Memory, Clear, Referrals, Ads, Payments) ---
    if (path.startsWith("/api/")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const id = env.SEARCH_AGENT.idFromName(session.githubLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");

      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", session.githubLogin);
      const isImmediateSync = /^\/(?:clear|reset|memory|audit|chat|etrade|broker|trading|screener|options)(?:\/|\?|$)/i.test(subPath);
      // #1724: the caller's `x-delivery-mode` header (copied through
      // by the Request construction above) adjusts eligibility ONLY:
      // "queued" grants x-async-eligible even to an immediate-prefix
      // request, "sync" suppresses it even for a non-immediate one.
      // The DO entry remains the decider (it resolves the same header
      // in run > session > user > env > per-prefix-legacy order); the
      // Worker never reroutes the special branches above, and an
      // unrecognized value keeps legacy marking (the DO/MCP decision
      // then fails closed with a jobs.config_error audit).
      const deliveryOverride = (request.headers.get("x-delivery-mode") || "").trim().toLowerCase();
      if (deliveryOverride !== "sync" && (deliveryOverride === "queued" || !isImmediateSync)) {
        forwardReq.headers.set("x-async-eligible", "1");
      }
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Simulated Sandbox Terminal for Payment Gateways ---
    if (path === "/checkout/sandbox") {
      const provider = (url.searchParams.get("provider") || "stripe").toUpperCase();
      const draftId = url.searchParams.get("id") || "pay_demo";
      const amount = url.searchParams.get("amt") || "25.00";
      const currency = url.searchParams.get("curr") || "USD";
      const customer = decodeURIComponent(url.searchParams.get("cust") || "Enterprise Customer");
      const sig = url.searchParams.get("sig") || "0x_demo_signature";

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${provider} Payment Terminal — Multi-Agent Studio</title>
  <style>
    body {
      margin: 0; padding: 0; background: ${SERVER_PALETTE.surface}; color: ${SERVER_PALETTE.textPrimary};
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
    }
    .card {
      background: ${SERVER_PALETTE.checkoutCard}; border: 1px solid ${SERVER_PALETTE.indigoAlpha40};
      border-radius: 20px; padding: 2.5rem; max-width: 440px; width: 90%;
      box-shadow: 0 20px 50px ${SERVER_PALETTE.blackAlpha60}; backdrop-filter: blur(20px);
    }
    .badge { display: inline-block; background: ${SERVER_PALETTE.indigoAlpha20}; color: ${SERVER_PALETTE.indigo400}; padding: 0.25rem 0.65rem; border-radius: 6px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; margin-bottom: 1rem; }
    h2 { margin: 0 0 0.5rem 0; font-size: 1.5rem; color: ${SERVER_PALETTE.onGradient}; }
    .amount { font-size: 2.4rem; font-weight: 800; color: ${SERVER_PALETTE.accent}; margin: 1rem 0; }
    .did-box { background: ${SERVER_PALETTE.blackAlpha40}; border: 1px solid ${SERVER_PALETTE.cardBorder}; border-radius: 10px; padding: 0.85rem; font-family: monospace; font-size: 0.75rem; color: ${SERVER_PALETTE.textMuted}; word-break: break-all; margin-bottom: 1.5rem; }
    .btn { display: block; width: 100%; padding: 0.85rem; border-radius: 10px; font-size: 0.95rem; font-weight: 700; cursor: pointer; text-align: center; text-decoration: none; border: 0; margin-bottom: 0.75rem; box-sizing: border-box; }
    .btn-pay { background: linear-gradient(135deg, ${SERVER_PALETTE.indigo500} 0%, ${SERVER_PALETTE.cyan500} 100%); color: ${SERVER_PALETTE.onGradient}; }
    .btn-pay:hover { filter: brightness(1.15); }
    .btn-cancel { background: transparent; color: ${SERVER_PALETTE.slate500}; }
    .btn-cancel:hover { color: ${SERVER_PALETTE.dangerText}; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">${provider} Sandbox Terminal</span>
    <h2>Secure Payment Authorization</h2>
    <p style="color: ${SERVER_PALETTE.textMuted}; font-size: 0.88rem; margin: 0;">Recipient: Multi-Agent Studio (${customer})</p>
    <div class="amount">$${amount} <span style="font-size: 1rem; color: ${SERVER_PALETTE.textMuted};">${currency}</span></div>
    <div class="did-box">
      <div><strong>Proposer:</strong> did:agent:openaimp:payments</div>
      <div><strong>Intent Hash:</strong> ${sig}...</div>
    </div>
    <a href="/?payment=success&draft=${encodeURIComponent(draftId)}&provider=${encodeURIComponent(provider)}" class="btn btn-pay">
      ✓ Authorize & Complete Payment
    </a>
    <a href="/?payment=cancel" class="btn btn-cancel">Cancel Transaction</a>
  </div>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // --- Serve App or Login Page ---
    const session = await requireAuth(request, env);
    if (path === "/" || path === "/index.html") {
      if (!session) {
        return new Response(renderLandingPage(env.APP_NAME), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const asset = await env.ASSETS.fetch(request);
      if (asset.ok) {
        const html = await asset.text();
        const safeUser = JSON.stringify({
          login: session.githubLogin,
          name: session.githubName,
          avatar: session.githubAvatar,
        }).replace(/</g, "\\u003c");

        // Issue #1806: Inject evaluated feature flags for zero-latency client boot
        const flags = await getAllFeatureFlags(env, { userLogin: session.githubLogin });
        const safeFeatures = JSON.stringify(flags).replace(/</g, "\\u003c");

        const userScript = `<script>window.__USER__=${safeUser};window.__FEATURES__=${safeFeatures};</script>`;
        const modified = html.replace("</head>", `${userScript}</head>`);
        const sessionId = getSessionId(request)!;

        return new Response(modified, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": setSessionCookie(sessionId),
          },
        });
      }
    }

    return env.ASSETS.fetch(request);
}

/**
 * Issue #183: the dedicated Durable Object instance that serves
 * ANONYMOUS premium (x402-paid) traffic. It is deliberately not any
 * user's instance name: the premium handlers recognise anonymous
 * traffic by the absence of an x-user-login header (the worker sets
 * that header only from a verified session) and bind all persisted
 * payment state to the verified payer instead of the instance.
 */
export const PREMIUM_GATEWAY_INSTANCE = "premium-gateway";

// Issue #1739 — per-subscriber dedup for screener-event delivery
// batches. Module-level so it survives across batches in one
// isolate; cross-isolate redelivery is possible under at-least-once
// delivery (see the messaging port docstring), and downstream
// scheduled deliveries already dedup on their own stable delivery id.
const screenerDeliverySeen = new Set<string>();

export default {
  // Issue #329: an escaped throw used to surface as Cloudflare error 1101 —
  // every visitor saw an edge error page. The boundary turns any failure into a
  // real 5xx with a machine-readable code (and stops KV quota throws from
  // taking authentication, and therefore the site, down).
  // Issue #1743 — HTTP boundary observability: honor the
  // incoming traceparent (or start a fresh trace), time the
  // request, stream one http.request event. Purely
  // observational — the response passes through unchanged,
  // and the error boundary still converts throws to 5xx.
  fetch: withRequestObservability(withErrorBoundary(handleFetch)),
  async email(message: any, env: Env, ctx?: any): Promise<void> {
    await handleCloudflareEmailMessage(message, env, ctx);
  },
  async scheduled(event: any, env: Env, ctx?: any): Promise<void> {
    // #1185 / #1066 — unattended work runs under the explicit service
    // identity (SERVICE_USER_LOGIN), never a hardcoded synthetic login.
    // The shared Orchestrator instance is addressed by its established
    // address (an address, not an identity). When no service identity is
    // configured, the identity-bearing dispatches below are skipped and
    // logged — failing closed instead of fabricating an identity. The
    // 03:00 UTC token-renewal pass asserts no identity (it enumerates
    // every stored token) and runs either way.
    const userLogin = getServiceUserLogin(env);
    const id = env.SEARCH_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE);
    const agent = env.SEARCH_AGENT.get(id);

    // PR #4 — ScheduledAgent tick: evaluate due goals, budget-check,
    // create Orchestrator jobs (issue #166).
    if (event?.cron === "*/30 * * * *") {
      const schedId = env.SCHEDULED_AGENT.idFromName("default");
      const schedAgent = env.SCHEDULED_AGENT.get(schedId) as unknown as {
        onCron(): Promise<unknown>;
      };
      const tickPromise = schedAgent.onCron();
      if (ctx?.waitUntil) ctx.waitUntil(tickPromise);
      else await tickPromise;
      if (!userLogin) {
        console.error(
          "[scheduled] SERVICE_USER_LOGIN is not configured — skipping the research/reflection/adaptation dispatches rather than fabricating an identity (#1185)."
        );
        return;
      }
      // Issue #354 — the daily options-research run (after market close)
      // rides this tick: the dedicated 0 21 * * 1-5 trigger cannot exist
      // (Workers Free ceiling of 5 cron triggers/account, error 10072; it
      // was never in wrangler.jsonc, so the old branch below was dead code).
      // Fire/no-fire is decided inside the tick route (weekday, >= 21:00
      // UTC, not already fired today — durable guard in mas_settings), so
      // this dispatch is unconditional; skips are cheap and explicit.
      const researchPromise = agent.fetch(
        new Request("https://agent.internal/research/scheduled-tick", {
          method: "POST",
          headers: { "x-user-login": userLogin },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(researchPromise);
      else await researchPromise;
      // Issue #705 — the weekly reflection job rides this tick (same
      // Workers Free ceiling constraint as #354). Fire/no-fire is decided
      // inside the route (Sunday, not already fired this week — durable
      // guard in mas_settings), so this dispatch is unconditional.
      const reflectionPromise = agent.fetch(
        new Request("https://agent.internal/reflection/run", {
          method: "POST",
          headers: { "x-user-login": userLogin },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(reflectionPromise);
      else await reflectionPromise;
      // Issue #754 — the weekly strategy-weight adjustment rides this
      // tick (same Workers Free ceiling constraint as #354/#705).
      // Fire/no-fire is decided inside the job (ISO-week guard +
      // adaptation kill switch in mas_settings), so this dispatch is
      // unconditional; skips are cheap and explicit in the job result.
      const weightsPromise = agent.fetch(
        new Request("https://agent.internal/adaptation/weights/run", {
          method: "POST",
          headers: { "x-user-login": userLogin },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(weightsPromise);
      else await weightsPromise;
      // Issue #1077 Phase 5b slice 1: the parallel social tick is gone.
      // Social posting is now a ScheduledAgent goal ("daily-social-post",
      // disabled by default) evaluated by the onCron call at the top of
      // this branch — no second scheduler, no second fire check.
      return;
    }
    // Renew all account-scoped Durable Object tokens before midnight ET.
    if (event?.cron === "0 3 * * *") {
      const renewPromise = renewAllStoredETradeTokens(env).then((counts) => {
        console.info("[scheduled] E*TRADE account-token renewal completed", counts);
      });
      if (ctx?.waitUntil) ctx.waitUntil(renewPromise);
      else await renewPromise;
      // Issue #255 — nightly mas_messages retention pass (0 4 * * * cron in
      // wrangler.jsonc). Enforces the retention window and records one
      // mas_events row per run.
    } else if (event?.cron === "0 4 * * *") {
      if (!userLogin) {
        console.error(
          "[scheduled] SERVICE_USER_LOGIN is not configured — skipping the retention dispatch rather than fabricating an identity (#1185)."
        );
        return;
      }
      const retentionPromise = agent.fetch(
        new Request("https://agent.internal/schedules/trigger-retention", {
          method: "POST",
          headers: { "x-user-login": userLogin },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(retentionPromise);
      else await retentionPromise;
    }
  },
  async queue(batch: any, env: Env, ctx?: any): Promise<void> {
    // Issue #1739 — durable screener-event delivery. The delivery
    // subscriber queue is dispatched through the broadcast core with
    // per-subscriber dedup; every other batch falls through to the
    // existing path untouched (options_analysis + ack-all behavior
    // preserved).
    if (batch?.queue === "screener-events-delivery") {
      const deliveryHandler = createScreenerQueueHandler({ env });
      const handlers: SubscriberHandlers = new Map([
        [
          "delivery",
          new Map([
            ["screener.completed", deliveryHandler],
            ["screener.failed", deliveryHandler],
          ]),
        ],
      ]);
      await dispatchSubscriberBatch(
        batch,
        "delivery",
        handlers,
        screenerDeliverySeen
      );
      // Issue #1743 — passive observability tap: fold the same
      // delivery envelopes into the Analytics Engine stream.
      // This tap NEVER owns ack/retry (delivery above does) and
      // NEVER fails the batch — a tap failure is warned, and
      // the delivery outcome stands.
      try {
        const sink = createObservabilitySink(env);
        for (const msg of batch.messages ?? []) {
          if (isMessageEnvelope(msg.body)) {
            await writeEnvelopeToSink(sink, msg.body);
          }
        }
      } catch (tapErr) {
        console.warn(
          "[observability] delivery tap failed (ignored):",
          tapErr,
        );
      }
      return;
    }
    // #1185 / #1066 — queue work runs under the message payload's stored
    // owner when it carries one, else the explicit service identity. With
    // neither, the message is retried (the existing catch path) rather
    // than dispatched under a fabricated identity.
    const serviceUserLogin = getServiceUserLogin(env);
    const id = env.SEARCH_AGENT.idFromName(SHARED_ORCHESTRATOR_INSTANCE);
    const agent = env.SEARCH_AGENT.get(id);

    if (batch?.messages && Array.isArray(batch.messages)) {
      for (const msg of batch.messages) {
        try {
          const body = msg.body;
          if (body?.taskType === "options_analysis") {
            const payloadOwner = isLoginShaped(body?.payload?.userLogin)
              ? body.payload.userLogin
              : null;
            const userLogin = payloadOwner ?? serviceUserLogin;
            if (!userLogin) {
              throw new Error(
                "options_analysis queue message has no payload owner and SERVICE_USER_LOGIN is not configured — refusing to dispatch under a fabricated identity (#1185)."
              );
            }
            const queuePromise = agent.fetch(
              new Request("https://agent.internal/schedules/trigger-options-analysis", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-user-login": userLogin },
                body: JSON.stringify(body.payload || {}),
              })
            );
            if (ctx?.waitUntil) ctx.waitUntil(queuePromise);
            else await queuePromise;
          }
          if (typeof msg.ack === "function") msg.ack();
        } catch (queueErr) {
          console.warn("[Queue Handler] Failed to process queue message:", queueErr);
          if (typeof msg.retry === "function") msg.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function requireAuth(request: Request, env: Env): Promise<SessionData | null> {
  const sessionId = getSessionId(request);
  // Issue #329: a value that isn't a UUID cannot name a session, so reject it
  // before the cache and before the session store — junk cookies cost a
  // regex, not a read.
  if (!isSessionIdFormat(sessionId)) return null;
  // #1819: the auth path is the top SessionStore source, so its backing
  // reads are attributed (caller requireAuth / validateAndTouchWiredSession,
  // trigger user) and forwarded to the resource sink when one is durably
  // bound. withProjection: true fans out to the Analytics Engine stream
  // AND the D1 projection, because the ScheduledAgent rollup/alert/
  // comparison goals can only query D1 from inside the Worker. When no
  // durable sink is bound the opts are undefined and the store_op v2
  // log lines remain the record — a per-isolate sink that silently
  // dropped events would be worse than none. A cache hit emits
  // nothing: no rows were read.
  const resourceSink = createResourceUsagePort(env, { withProjection: true });
  const authResource = resourceSink
    ? { resourceSink, attribution: { caller: "requireAuth", trigger: "user" } as ResourceAttribution }
    : undefined;
  const cached = await getSessionCached(env, sessionId, authResource);
  // #945 Phase 2b-part1: when wiring is ON, a session that already
  // carries an internalUserId (a wired session) is validated through
  // the wired path — fresh read, absolute + idle expiry, touch +
  // persist + cache invalidation (see iaaaEnforcement.ts). Every
  // other case returns the cached session exactly as before:
  // wiring OFF is the original single line, and non-wired sessions
  // under wiring ON stay on the legacy cached path, idle-exempt.
  if (isWiringEnabled(env) && cached?.internalUserId) {
    const wiredResource = resourceSink
      ? {
          resourceSink,
          attribution: { caller: "validateAndTouchWiredSession", trigger: "user" } as ResourceAttribution,
        }
      : undefined;
    const result = await validateAndTouchWiredSession(
      {
        freshRead: (id) => getSession(env, id, wiredResource),
        persist: (id, data, nowMs) => updateSession(env, id, data, nowMs, wiredResource),
        invalidate: (id) => invalidateSessionCache(id),
      },
      cached,
      sessionId,
      Date.now(),
    );
    if (result.wired) return result.session;
  }
  return cached;
}

