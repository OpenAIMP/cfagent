import { AIChatAgent } from "@cloudflare/ai-chat";
import { tool, streamText, convertToModelMessages } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { Env, SessionData } from "./types";
import { getSessionId, getSession, setSessionCookie } from "./session";
import { handleLogin, handleOAuthCallback, handleLogout, renderLoginPage } from "./oauth";
export { OrchestratorAgent as SearchAgent } from "./agents/orchestrator";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const sessionId = getSessionId(request);
      if (!sessionId) return new Response("Unauthorized", { status: 401 });
      const session = await getSession(env, sessionId);
      if (!session) return new Response("Unauthorized", { status: 401 });
      const id = env.SEARCH_AGENT.idFromName(sessionId);
      return env.SEARCH_AGENT.get(id).fetch(request);
    }

    if (path === "/auth/login") return handleLogin(env);
    if (path === "/auth/callback") return handleOAuthCallback(env, request);
    if (path === "/auth/logout") return handleLogout(env, request);

    if (path === "/api/me") {
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response(JSON.stringify({ authenticated: false }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ authenticated: true, login: session.githubLogin, name: session.githubName, avatar: session.githubAvatar }), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "/api/nlq" && request.method === "POST") {
      const session = await requireAuth(request, env);
      if (!session) return new Response("Unauthorized", { status: 401 });

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }

      const query = String(body.query || "").trim();
      if (!query) {
        return new Response(JSON.stringify({ error: "query is required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }

      const rows = [{ query, note: "NLQ is available on the orchestrator. This placeholder response is prepared for the read-only query mode." }];
      return new Response(JSON.stringify({ plan: { operation: "search", terms: query, role: "any", since: null, limit: 25 }, count: rows.length, rows }), { headers: { "Content-Type": "application/json" } });
    }

    const session = await requireAuth(request, env);
    if (path === "/" || path === "/index.html") {
      if (!session) {
        return new Response(renderLoginPage(env), { headers: { "Content-Type": "text/html" } });
      }
      const asset = await env.ASSETS.fetch(request);
      if (asset.ok) {
        const html = await asset.text();
        const userScript = `<script>window.__USER__=${JSON.stringify({ login: session.githubLogin, name: session.githubName, avatar: session.githubAvatar })}</script>`;
        return new Response(html.replace("</head>", `${userScript}</head>`), { headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": setSessionCookie(getSessionId(request)!) } });
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
