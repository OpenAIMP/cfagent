import type { Env, SessionData } from "./types";
import { getSessionId, getSession, setSessionCookie } from "./session";
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
} from "./services/etradeOAuth";
import { ETradeRestClient } from "./trading/etrade/client";
import { resolveEnvironmentConfig } from "./config/environment";
import { handleCloudflareEmailMessage, ETradeEmailTradingService } from "./trading/email/agent";
import { verifySlackSignature, ETradeSlackTradingService } from "./trading/slack/agent";
import { handleVoiceWebSocketConnection, ETradeVoiceTradingService } from "./trading/voice/agent";
import { ETradeWebhookService } from "./services/tradingWebhooks";
export { OrchestratorAgent as SearchAgent } from "./agents/orchestrator";
export { OptionsScannerMCP } from "./services/cloudflareWalletsScanner";


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
  } catch {
    return false;
  }
  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if ((path === "/nlq/webhook" || path === "/api/trading/nlq/webhook") && request.method === "POST") {
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

    // --- Model Context Protocol (MCP) JSON-RPC 2.0 & Discovery Endpoint ---
    if (path === "/mcp" || path === "/api/mcp") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
          },
        });
      }

      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || request.headers.get("x-user-id") || "mcp_client";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/mcp" + url.search, "https://agent.internal");

      const resp = await env.SEARCH_AGENT.get(id).fetch(new Request(targetUrl, request));
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id");
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

    // --- Cloudflare Agentic Payments (HTTP 402 Gated Endpoints & Wallet API) ---
    if (path.startsWith("/api/premium/") || path.startsWith("/api/payments/agentic/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, PAYMENT-SIGNATURE, PAYMENT-REQUIRED, x-user-id, x-environment",
            "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, WWW-Authenticate, PAYMENT-RESPONSE, Payment-Receipt",
          },
        });
      }

      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || request.headers.get("x-user-id") || "agentic_consumer";
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

    // --- External Payment Webhook Listeners (Stripe, PayPal, Lemon Squeezy) ---
    if (path.startsWith("/api/payments/webhook") || path === "/payments/webhook") {
      const id = env.SEARCH_AGENT.idFromName("system_webhook_receiver");
      const targetUrl = new URL("/payments/webhook" + url.search, "https://agent.internal");
      return env.SEARCH_AGENT.get(id).fetch(new Request(targetUrl, request));
    }

    // --- Omnichannel Trading Agent: Inbound Email Webhook & Simulator ---
    if (path === "/api/trading/email/inbound" && request.method === "POST") {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || "omnichannel_email_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/email/inbound", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Slack Test Simulator ---
    if (path === "/api/trading/slack/test" && request.method === "POST") {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || "omnichannel_slack_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/slack/event", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Voice Trading Turn Simulator & API ---
    if ((path === "/api/trading/voice/turn" || path === "/api/trading/voice/test") && request.method === "POST") {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || "omnichannel_voice_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/voice/turn", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Voice Welcome Greeting ---
    if (path === "/api/trading/voice/greeting" && request.method === "GET") {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || "omnichannel_voice_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/voice/greeting", "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Options Intelligence: Unified Options API Forwarder ---
    if ((path === "/api/trading/options/unified" || path === "/trading/options/unified") && (request.method === "POST" || request.method === "GET")) {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || request.headers.get("x-user-login") || "default_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/options/unified" + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Dynamic ETAPI Config & Tuning API Forwarder ---
    if ((path === "/api/trading/options/config" || path === "/trading/options/config") && (request.method === "POST" || request.method === "GET")) {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || request.headers.get("x-user-login") || "default_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const targetUrl = new URL("/trading/options/config" + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Cloudflare Agents Task Scheduling Management APIs ---
    if (path.startsWith("/api/schedules") || path === "/api/schedules") {
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || request.headers.get("x-user-login") || "default_trader";
      const id = env.SEARCH_AGENT.idFromName(userLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");
      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", userLogin);
      return env.SEARCH_AGENT.get(id).fetch(forwardReq);
    }

    // --- Omnichannel Trading Agent: Voice WebSocket Session ---
    if ((path === "/voice/trade" || path === "/api/trading/voice/ws") && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [clientWs, serverWs] = Object.values(pair);
      serverWs.accept();

      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || "voice_trader";

      handleVoiceWebSocketConnection(serverWs, env, undefined, userLogin).catch(console.warn);

      return new Response(null, { status: 101, webSocket: clientWs });
    }

    // --- Omnichannel Trading Agent: Slack Events Webhook ---
    if ((path === "/slack" || path === "/slack/events") && request.method === "POST") {
      const rawBody = await request.text();
      const sig = request.headers.get("x-slack-signature");
      const ts = request.headers.get("x-slack-request-timestamp");

      if (env.SLACK_SIGNING_SECRET) {
        const isValid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, ts, rawBody, sig);
        if (!isValid) {
          return new Response("Invalid Slack signature", { status: 401 });
        }
      }

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
      const rawBody = await request.text();
      const sig = request.headers.get("x-slack-signature");
      const ts = request.headers.get("x-slack-request-timestamp");

      if (env.SLACK_SIGNING_SECRET) {
        const isValid = await verifySlackSignature(env.SLACK_SIGNING_SECRET, ts, rawBody, sig);
        if (!isValid) {
          return new Response("Invalid Slack signature", { status: 401 });
        }
      }

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
        const kv = env.ETRADE_KV || env.SESSIONS;
        if (kv) {
          await kv.put(`slack_token_${tokens.teamId}`, tokens.accessToken);
        }
        return Response.redirect(`/?tab=trading&slack=connected&team=${encodeURIComponent(tokens.teamName)}`, 302);
      } catch (err: any) {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(err.message || "slack_oauth_failed")}`, 302);
      }
    }

    // --- One-Click Email HITL Trade Approval Endpoint ---
    if (path === "/trade/approve") {
      const orderId = url.searchParams.get("orderId");
      if (!orderId) {
        return new Response("Missing orderId parameter", { status: 400 });
      }
      const session = await requireAuth(request, env);
      const userLogin = session?.githubLogin || "email_authorized_user";
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

    // --- Forwarded Durable Object APIs (NLQ, Audit, Memory, Clear, Referrals, Ads, Payments) ---
    if (path.startsWith("/api/")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const id = env.SEARCH_AGENT.idFromName(session.githubLogin);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");

      const forwardReq = new Request(targetUrl, request);
      forwardReq.headers.set("x-user-login", session.githubLogin);
      forwardReq.headers.set("x-async-eligible", "1");
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
  },
  async email(message: any, env: Env, ctx?: any): Promise<void> {
    await handleCloudflareEmailMessage(message, env, ctx);
  },
  async scheduled(event: any, env: Env, ctx?: any): Promise<void> {
    const userLogin = "default_trader";
    const id = env.SEARCH_AGENT.idFromName(userLogin);
    const agent = env.SEARCH_AGENT.get(id);

    if (event?.cron === "0 23 * * *") {
      const renewPromise = agent.fetch(
        new Request("https://agent.internal/schedules/trigger-renew", {
          method: "POST",
          headers: { "x-user-login": userLogin },
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(renewPromise);
      else await renewPromise;
    } else {
      const optionsPromise = agent.fetch(
        new Request("https://agent.internal/schedules/trigger-options-analysis", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-user-login": userLogin,
          },
          body: JSON.stringify({
            symbols: ["AAPL", "NVDA", "SPY", "MSFT"],
            thesis: "bullish",
            pushToSlack: true,
          }),
        })
      );
      if (ctx?.waitUntil) ctx.waitUntil(optionsPromise);
      else await optionsPromise;
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
  if (!sessionId) return null;
  return await getSession(env, sessionId);
}
