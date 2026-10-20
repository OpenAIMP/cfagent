import type { Env, SessionData, TransactionSnapData } from "./types";
import { getSessionId, isSessionIdFormat, setSessionCookie } from "./session";
import { getSessionCached } from "./security/sessionCache";
import {
  bearerKeyFromRequest,
  listApiKeys,
  mintApiKey,
  revokeApiKey,
  verifyApiKey,
} from "./security/apiKeys";
import { serveStaticAsset } from "./security/staticAssets";
import { withErrorBoundary } from "./security/workerErrorBoundary";
import { handleLogin, handleOAuthCallback, handleLogout, renderLoginPage } from "./oauth";
import { renderLandingPage } from "./landing";
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
import { ETradeRestClient } from "./trading";
import { resolveEnvironmentConfig } from "./config/environment";
import { handleCloudflareEmailMessage, ETradeEmailTradingService } from "./trading";
import { ETradeSlackTradingService } from "./trading";
import { gateSlackRequest } from "./security/webhookSecurity";
import { checkRateLimit } from "./security/rateLimiter";
import {
  deriveNlqNonce,
  sharedMemoryReplayStore,
  validateEmailRecipient,
} from "./security/webhookReplay";
import { handleVoiceWebSocketConnection, ETradeVoiceTradingService } from "./trading";
import { ETradeWebhookService } from "./services/tradingWebhooks";
import { ETradeBrowserService } from "./services/browserAgent";
import { handleMarketQuotesWebSocket, handleMarketQuotesHttp } from "./services/marketStream";
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
  if (typeof body.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp)) ||
    Math.abs(Date.now() - Date.parse(body.timestamp)) > 5 * 60 * 1000) {
    return Response.json({ error: "Webhook timestamp is missing, invalid, or expired." }, { status: 401 });
  }
  if (body.query.length > 4_000) return Response.json({ error: "Query must be 4,000 characters or fewer." }, { status: 413 });
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
    body.query.trim(),
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
    body: JSON.stringify({ query: body.query.trim() }),
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
    // binding before `requireAuth` can spend a SESSIONS KV read on them.
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

    // PR #2 — A2A routing (issue #160): agent discovery + JSON-RPC dispatch
    if (path.startsWith("/a2a/") || path.startsWith("/.well-known/")) {
      const { handleA2A } = await import("./a2a");
      return handleA2A(request, env as any);
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
    if (path === "/auth/login") return handleLogin(env);
    if (path === "/login" && request.method === "GET") {
      return new Response(renderLoginPage(env), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/auth/callback") return handleOAuthCallback(env, request);
    if (path === "/auth/logout") return handleLogout(env, request);

    // --- E*TRADE OAuth 1.0a 3-Legged Lifecycle Endpoints ---
    const reqEnv = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase() || undefined;

    if (path === "/auth/etrade/start" || path === "/api/etrade/oauth/start") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
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
      return Response.json({ ok: true, chunks });
    }

    // Issue #159 — ScheduledAgent dashboard API.
    if (path.startsWith("/api/schedule/")) {
      const schedId = (env as any).SCHEDULED_AGENT.idFromName("default");
      const sched = (env as any).SCHEDULED_AGENT.get(schedId) as unknown as {
        listGoals(): Promise<unknown[]>;
        getTickHistory(limit?: number): Promise<unknown[]>;
        addGoal(goal: Record<string, unknown>): Promise<unknown>;
        removeGoal(id: string): Promise<boolean>;
        setGoalEnabled(id: string, enabled: boolean): Promise<boolean>;
        triggerGoal(id: string, env: unknown): Promise<unknown>;
      };

      if (path === "/api/schedule/goals" && request.method === "GET") {
        return Response.json({ ok: true, goals: await sched.listGoals() });
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
        const tick = await sched.triggerGoal(id, env);
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

    // --- User Profile API ---
    if (path === "/api/me") {
      const session = await requireAuth(request, env);
      if (!session) {
        return Response.json({ authenticated: false });
      }
      return Response.json({
        authenticated: true,
        login: session.githubLogin,
        name: session.githubName,
        avatar: session.githubAvatar,
      });
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

      // Each unique scanner session gets its own DO instance.
      const scannerSessionId =
        request.headers.get("x-scanner-session") ||
        request.headers.get("x-user-id") ||
        "public_scanner";
      const scannerId = (env as any).OPTIONS_SCANNER_MCP.idFromName(scannerSessionId);
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
          "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-user-id, x-environment",
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
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-user-id, x-environment");
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
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-user-id, x-environment");
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
      // x-user-login header (or a shared "default_trader"), letting an
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
      // header or a shared "default_trader" identity.
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
      // session proceeded under a shared "voice_trader" identity, so an
      // unauthenticated caller could open a voice trading session.
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      const userLogin = session.githubLogin;

      handleVoiceWebSocketConnection(serverWs, env, undefined, userLogin).catch(console.warn);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // --- Real-Time Market Data Quotes WebSocket Session (Issue #21) ---
    if ((path === "/api/market/quotes/ws" || path === "/api/foss/quotes/ws") && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      handleMarketQuotesWebSocket(serverWs, env).catch(console.warn);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // --- Batch Market Quotes HTTP Endpoint (Fallback for non-WebSocket clients) ---
    if ((path === "/api/market/quotes" || path === "/api/foss/quotes") && request.method === "GET") {
      const symbolsParam = url.searchParams.get("symbols") || "";
      const symbols = symbolsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return handleMarketQuotesHttp(
        symbols.length > 0
          ? symbols
          : ["NVDA", "AAPL", "MSFT", "TSLA", "SPY", "QQQ", "BTC/USD", "ETH/USD", "SOL/USD"]
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
        const userLogin = request.headers.get("x-user-login") || tx.symbol || "browser_trader";
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

      if (sub === "live" || sub === "historical") {
        const flows = await getDynamicLiveFlowItems(env, { tickers, minPremium: minPrem, marketCaps, assetTypes });
        return Response.json({
          success: true,
          count: flows.length,
          total: flows.length,
          flows,
          // Issue #119: there is no trade tape — disclose the modelled
          // basis of every item at the envelope level too.
          provenance: summarizeFlowProvenance(flows),
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
        const summary = await getDynamicFlowSummary(env, { tickers, minPremium: minPrem, marketCaps, assetTypes });
        return Response.json({
          success: true,
          summary,
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

    // --- Forwarded Durable Object APIs (NLQ, Audit, Memory, Clear, Referrals, Ads, Payments) ---
    if (path.startsWith("/api/")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const id = env.SEARCH_AGENT.idFromName(session.githubLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");

      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", session.githubLogin);
      const isImmediateSync = /^\/(?:clear|reset|memory|audit|chat)(?:\/|\?|$)/i.test(subPath);
      if (!isImmediateSync) {
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
      margin: 0; padding: 0; background: #060913; color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
    }
    .card {
      background: rgba(18, 26, 47, 0.9); border: 1px solid rgba(99, 102, 241, 0.4);
      border-radius: 20px; padding: 2.5rem; max-width: 440px; width: 90%;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6); backdrop-filter: blur(20px);
    }
    .badge { display: inline-block; background: rgba(99, 102, 241, 0.2); color: #818cf8; padding: 0.25rem 0.65rem; border-radius: 6px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; margin-bottom: 1rem; }
    h2 { margin: 0 0 0.5rem 0; font-size: 1.5rem; color: #ffffff; }
    .amount { font-size: 2.4rem; font-weight: 800; color: #38bdf8; margin: 1rem 0; }
    .did-box { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 0.85rem; font-family: monospace; font-size: 0.75rem; color: #94a3b8; word-break: break-all; margin-bottom: 1.5rem; }
    .btn { display: block; width: 100%; padding: 0.85rem; border-radius: 10px; font-size: 0.95rem; font-weight: 700; cursor: pointer; text-align: center; text-decoration: none; border: 0; margin-bottom: 0.75rem; box-sizing: border-box; }
    .btn-pay { background: linear-gradient(135deg, #6366f1 0%, #06b6d4 100%); color: #ffffff; }
    .btn-pay:hover { filter: brightness(1.15); }
    .btn-cancel { background: transparent; color: #64748b; }
    .btn-cancel:hover { color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">${provider} Sandbox Terminal</span>
    <h2>Secure Payment Authorization</h2>
    <p style="color: #94a3b8; font-size: 0.88rem; margin: 0;">Recipient: Multi-Agent Studio (${customer})</p>
    <div class="amount">$${amount} <span style="font-size: 1rem; color: #94a3b8;">${currency}</span></div>
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

        const userScript = `<script>window.__USER__=${safeUser};</script>`;
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

export default {
  // Issue #329: an escaped throw used to surface as Cloudflare error 1101 —
  // every visitor saw an edge error page. The boundary turns any failure into a
  // real 5xx with a machine-readable code (and stops KV quota throws from
  // taking authentication, and therefore the site, down).
  fetch: withErrorBoundary(handleFetch),
  async email(message: any, env: Env, ctx?: any): Promise<void> {
    await handleCloudflareEmailMessage(message, env, ctx);
  },
  async scheduled(event: any, env: Env, ctx?: any): Promise<void> {
    const userLogin = "default_trader";
    const id = env.SEARCH_AGENT.idFromName(userLogin);
    const agent = env.SEARCH_AGENT.get(id);

    // PR #4 — ScheduledAgent tick: evaluate due goals, budget-check,
    // create Orchestrator jobs (issue #166).
    if (event?.cron === "*/30 * * * *") {
      const schedId = env.SCHEDULED_AGENT.idFromName("default");
      const schedAgent = env.SCHEDULED_AGENT.get(schedId) as unknown as {
        onCron(env: unknown): Promise<unknown>;
      };
      const tickPromise = schedAgent.onCron(env);
      if (ctx?.waitUntil) ctx.waitUntil(tickPromise);
      else await tickPromise;
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
    const userLogin = "default_trader";
    const id = env.SEARCH_AGENT.idFromName(userLogin);
    const agent = env.SEARCH_AGENT.get(id);

    if (batch?.messages && Array.isArray(batch.messages)) {
      for (const msg of batch.messages) {
        try {
          const body = msg.body;
          if (body?.taskType === "options_analysis") {
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
  // before the cache and before KV — junk cookies cost a regex, not a read.
  if (!isSessionIdFormat(sessionId)) return null;
  return await getSessionCached(env, sessionId);
}

