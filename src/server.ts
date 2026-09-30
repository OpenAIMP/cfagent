import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Env, SessionData, AgentName } from "./types";
import { getSessionId, getSession, setSessionCookie } from "./session";
import { handleLogin, handleOAuthCallback, handleLogout, renderLoginPage } from "./oauth";
import { LLMJudge } from "./agents/judge";
import { createMAS } from "./agents/mas";
import { planNLQ, queryConversation } from "./agents/nlq";

export class SearchAgent extends AIChatAgent<Env> {
  private ensureTables() { const sql = (this as any).sql; sql.exec("CREATE TABLE IF NOT EXISTS mas_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, agent TEXT NOT NULL, created_at TEXT NOT NULL)"); return sql; }
  private sessionKey() { return this.ctx.id.toString(); }
  private audit(type: string, agent: AgentName | "judge" | "nlq", payload: Record<string, unknown>) { const sql = this.ensureTables(); sql.exec("CREATE TABLE IF NOT EXISTS mas_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, agent TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)",); sql.exec("INSERT INTO mas_events VALUES (?, ?, ?, ?, ?, ?)", crypto.randomUUID(), this.sessionKey(), type, agent, JSON.stringify(payload), new Date().toISOString()); }
  private record(role: string, content: string, agent: string) { this.ensureTables().exec("INSERT INTO mas_messages VALUES (?, ?, ?, ?, ?, ?)", crypto.randomUUID(), this.sessionKey(), role, content.slice(0, 20000), agent, new Date().toISOString()); }

  async onChatMessage() {
    const requestId = crypto.randomUUID();
    const last = [...this.messages].reverse().find((m: any) => m.role === "user");
    const question = last?.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") || "";
    this.record("user", question, "orchestrator");
    const judge = new LLMJudge(this.env);
    const route = await judge.route(question);
    this.audit("route.decided", "judge", route as any);
    const tools = createMAS(this.env, this.sessionKey(), requestId, (type, agent, payload) => this.audit(type, agent, payload));
    const model = createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.1-8b-instruct");
    const result = streamText({ model, temperature: 0.3, maxSteps: Number(this.env.MAS_MAX_STEPS || 4), system: `You are the orchestrator of a multi-agent system. Route selected: ${route.agent}. Confidence: ${route.confidence}. Delegate only when useful. Never claim an action happened when a tool says draft or awaiting confirmation. Payments require explicit confirmation and must never move money in this demo. Cite knowledge-base evidence when search is used.`, messages: await convertToModelMessages(this.messages), tools, onFinish: async ({ text }) => { this.record("assistant", text, route.agent); const quality = await judge.evaluate({ question, answer: text, agent: route.agent }); this.audit("response.evaluated", "judge", quality as any); } });
    return result.toUIMessageStreamResponse();
  }

  async onRequest(request: Request) {
    if (new URL(request.url).pathname === "/nlq" && request.method === "POST") {
      const body = await request.json() as { query?: string };
      if (!body.query?.trim()) return Response.json({ error: "query is required" }, { status: 400 });
      const plan = await planNLQ(this.env, body.query);
      const sql: any = this.ensureTables(); sql.__sessionId = this.sessionKey();
      const result = queryConversation(sql, plan);
      this.audit("nlq.executed", "nlq", { plan, count: result.count });
      return Response.json(result);
    }
    return new Response("Not found", { status: 404 });
  }
}

export default { async fetch(request: Request, env: Env): Promise<Response> { const url = new URL(request.url); const path = url.pathname; const sessionId = getSessionId(request);
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") { if (!sessionId || !(await getSession(env, sessionId))) return new Response("Unauthorized", { status: 401 }); return env.SEARCH_AGENT.get(env.SEARCH_AGENT.idFromName(sessionId)).fetch(request); }
  if (path === "/auth/login") return handleLogin(env); if (path === "/auth/callback") return handleOAuthCallback(env, request); if (path === "/auth/logout") return handleLogout(env, request);
  if (path === "/api/nlq" && request.method === "POST") { if (!sessionId || !(await getSession(env, sessionId))) return new Response("Unauthorized", { status: 401 }); return env.SEARCH_AGENT.get(env.SEARCH_AGENT.idFromName(sessionId)).fetch(new Request(new URL("/nlq", request.url), request)); }
  if (path === "/api/me") { const session = await requireAuth(request, env); return Response.json(session ? { authenticated: true, login: session.githubLogin, name: session.githubName, avatar: session.githubAvatar } : { authenticated: false }); }
  const session = await requireAuth(request, env); if (path === "/" || path === "/index.html") { if (!session) return new Response(renderLoginPage(env), { headers: { "Content-Type": "text/html" } }); const asset = await env.ASSETS.fetch(request); if (asset.ok) { const html = await asset.text(); const userScript = `<script>window.__USER__=${JSON.stringify({ login: session.githubLogin, name: session.githubName, avatar: session.githubAvatar })}</script>`; return new Response(html.replace("</head>", `${userScript}</head>`), { headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": setSessionCookie(sessionId!) } }); } }
  return env.ASSETS.fetch(request);
} } satisfies ExportedHandler<Env>;

async function requireAuth(request: Request, env: Env): Promise<SessionData | null> { const id = getSessionId(request); return id ? getSession(env, id) : null; }
