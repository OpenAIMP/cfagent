import type { Env, SessionData } from "./types";
import { getSessionId, getSession, setSessionCookie } from "./session";
import { handleLogin, handleOAuthCallback, handleLogout, renderLoginPage } from "./oauth";
import { routeAgentRequest } from "agents";
import {
  getETradeRequestToken,
  exchangeETradeVerifier,
  renewETradeAccessToken,
  revokeStoredTokens,
  getETradeAuthStatus,
} from "./services/etradeOAuth";
export { OrchestratorAgent as SearchAgent } from "./agents/orchestrator";

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
    if (path === "/auth/callback") return handleOAuthCallback(env, request);
    if (path === "/auth/logout") return handleLogout(env, request);

    // --- E*TRADE OAuth 1.0a 3-Legged Lifecycle Endpoints ---
    if (path === "/auth/etrade/start" || path === "/api/etrade/oauth/start") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const callbackUrl = new URL("/auth/etrade/callback", request.url).toString();
      try {
        const result = await getETradeRequestToken(env, session.githubLogin, callbackUrl);
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
        await exchangeETradeVerifier(env, session.githubLogin, verifier);
        return Response.redirect("/?tab=trading&etrade_auth=success", 302);
      } catch (err: any) {
        return Response.redirect(`/?tab=trading&error=${encodeURIComponent(err.message || "exchange_failed")}`, 302);
      }
    }

    if (path === "/api/etrade/oauth/status") {
      const session = await requireAuth(request, env);
      if (!session) return Response.json({ authenticated: false });
      const status = await getETradeAuthStatus(env, session.githubLogin);
      return Response.json(status);
    }

    if (path === "/api/etrade/oauth/verifier" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const body = (await request.json().catch(() => ({}))) as any;
      const verifier = (body.verifier || "").trim();
      if (!verifier) return Response.json({ error: "Verifier PIN is required" }, { status: 400 });
      try {
        const tokens = await exchangeETradeVerifier(env, session.githubLogin, verifier, body.requestToken, body.requestTokenSecret);
        return Response.json({ success: true, environment: tokens.environment, storedAt: tokens.storedAt });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to exchange verifier" }, { status: 400 });
      }
    }

    if (path === "/api/etrade/oauth/renew" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });
      try {
        const renewed = await renewETradeAccessToken(env, session.githubLogin);
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
      await revokeStoredTokens(env, session.githubLogin);
      return Response.json({ success: true });
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

    // --- External Payment Webhook Listeners (Stripe, PayPal, Lemon Squeezy) ---
    if (path.startsWith("/api/payments/webhook") || path === "/payments/webhook") {
      const id = env.SEARCH_AGENT.idFromName("system_webhook_receiver");
      const targetUrl = new URL("/payments/webhook" + url.search, "https://agent.internal");
      return env.SEARCH_AGENT.get(id).fetch(new Request(targetUrl, request));
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
        return new Response(renderLoginPage(env), {
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
} satisfies ExportedHandler<Env>;

async function requireAuth(request: Request, env: Env): Promise<SessionData | null> {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  return await getSession(env, sessionId);
}
