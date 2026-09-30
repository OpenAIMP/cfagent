import { AIChatAgent } from "@cloudflare/ai-chat";
import { tool, streamText, convertToModelMessages } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { Env, SessionData } from "./types";
import { getSessionId, getSession, setSessionCookie } from "./session";
import { handleLogin, handleOAuthCallback, handleLogout, renderLoginPage } from "./oauth";

// --- The Agent (Durable Object) ---

export class SearchAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = createWorkersAI({ binding: this.env.AI })(
      "@cf/meta/llama-3.1-8b-instruct"
    );

    // Get the user's latest message as a fallback query
    const lastUserMessage = this.messages
      .filter((m: any) => m.role === "user")
      .pop();
    const fallbackQuery = lastUserMessage?.parts
      ?.filter((p: any) => p.type === "text")
      ?.map((p: any) => p.text)
      ?.join("") || "";

    const result = streamText({
      model,
      system: `You are an AI assistant with access to a search tool that queries a knowledge base.
Use the search tool when the user asks a question that requires finding information from documents.
For greetings or simple messages, respond directly without searching.
If the search returns no results, let the user know and suggest they add documents to the knowledge base.
Be concise and helpful. Base your answers on the search results.`,
      messages: await convertToModelMessages(this.messages),
      maxSteps: 5,
      tools: {
        search: tool({
          description: "Search the AI Search knowledge base for relevant information. Only use this tool when the user asks a specific question about content that might be in the knowledge base. Do not use it for greetings, simple messages, or conversational responses.",
          parameters: z.object({
            query: z.string().min(1).describe("The search query - must not be empty"),
          }),
          execute: async ({ query }) => {
            // Fallback: if model sends empty query, use the user's message
            const searchQuery = (query && query.trim()) ? query : fallbackQuery;
            if (!searchQuery) {
              return { error: "No search query available" };
            }
            const resp = await fetch(`${this.env.AI_SEARCH_ENDPOINT}/search`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: searchQuery }],
              }),
            });
            if (!resp.ok) {
              return { error: `Search failed: ${resp.status}` };
            }
            const data = await resp.json();
            return data;
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }

// --- Worker entry point ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- WebSocket upgrade: route to Agent Durable Object ---
    if (request.headers.get("Upgrade") === "websocket") {
      // Use the authenticated user's session ID as the agent name
      // so each user gets their own agent instance
      const sessionId = getSessionId(request) || "anonymous";
      const id = env.SEARCH_AGENT.idFromName(sessionId);
      const stub = env.SEARCH_AGENT.get(id);
      return stub.fetch(request);
    }

    // --- Auth routes ---
    if (path === "/auth/login") return handleLogin(env);
    if (path === "/auth/callback") return handleOAuthCallback(env, request);
    if (path === "/auth/logout") return handleLogout(env, request);

    // --- API: current user ---
    if (path === "/api/me") {
      const session = await requireAuth(request, env);
      if (!session) {
        return new Response(JSON.stringify({ authenticated: false }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          authenticated: true,
          login: session.githubLogin,
          name: session.githubName,
          avatar: session.githubAvatar,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // --- Serve app with auth check ---
    const session = await requireAuth(request, env);

    if (path === "/" || path === "/index.html") {
      if (!session) {
        return new Response(renderLoginPage(env), {
          headers: { "Content-Type": "text/html" },
        });
      }
      const asset = await env.ASSETS.fetch(request);
      if (asset.ok) {
        const html = await asset.text();
        const userScript = `<script>window.__USER__=${JSON.stringify({
          login: session.githubLogin,
          name: session.githubName,
          avatar: session.githubAvatar,
        })}</script>`;
        const modified = html.replace("</head>", `${userScript}</head>`);
        return new Response(modified, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": setSessionCookie(getSessionId(request)!),
          },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function requireAuth(
  request: Request,
  env: Env
): Promise<SessionData | null> {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  return await getSession(env, sessionId);
}
