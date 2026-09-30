import type { Env, SessionData } from "./types";
import { getSessionId, getSession, setSessionCookie } from "./session";
import { handleLogin, handleOAuthCallback, handleLogout, renderLoginPage } from "./oauth";
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
  } catch {
    return false;
  }
  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- WebSocket upgrade handling ---
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // Cross-Site WebSocket Hijacking (CSWSH) check
      if (!isAllowedOrigin(request, env)) {
        return new Response("Forbidden: Invalid Origin", { status: 403 });
      }

      const sessionId = getSessionId(request);
      if (!sessionId) return new Response("Unauthorized", { status: 401 });

      const session = await getSession(env, sessionId);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const id = env.SEARCH_AGENT.idFromName(sessionId);
      return env.SEARCH_AGENT.get(id).fetch(request);
    }

    // --- Authentication endpoints ---
    if (path === "/auth/login") return handleLogin(env);
    if (path === "/auth/callback") return handleOAuthCallback(env, request);
    if (path === "/auth/logout") return handleLogout(env, request);

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

    // --- Forwarded Durable Object APIs (NLQ, Audit, Memory, Clear) ---
    if (path.startsWith("/api/nlq") || path.startsWith("/api/audit") || path.startsWith("/api/memory") || path.startsWith("/api/clear")) {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      const sessionId = getSessionId(request)!;
      const id = env.SEARCH_AGENT.idFromName(sessionId);
      const subPath = path.replace(/^\/api/, "");
      const targetUrl = new URL(subPath + url.search, "https://agent.internal");

      return env.SEARCH_AGENT.get(id).fetch(new Request(targetUrl, request));
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
