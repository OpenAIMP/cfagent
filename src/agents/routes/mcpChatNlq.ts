/**
 * Issue #359-02: MCP + chat + NLQ routes extracted from
 * OrchestratorAgent.routeRequest (src/agents/orchestrator.ts). Pure move —
 * no behavior change.
 *
 * The module handles the three contiguous AI-interaction blocks: the MCP
 * server endpoint (JSON-RPC 2.0 + discovery), POST /api/chat (thin adapter
 * over the single-owner runAgenticChatTurn pipeline, PR #320), and the
 * POST /nlq natural-language query route. It is invoked from routeRequest at
 * the EXACT position the original blocks occupied in the sequential
 * path.endsWith matching sequence. It returns a Response when one of its
 * paths matches, or null when none does — matching order relative to all
 * other handlers is preserved by the call site.
 *
 * Handlers that used OrchestratorAgent private helpers/state receive them via
 * the explicit McpChatNlqRouteContext parameter; there are no new globals
 * and no back-references into the class.
 *
 * NOT moved (documented so no one re-litigates):
 * - The POST /nlq/webhook spellings live in src/server.ts, delegating to
 *   the single-owner handleNlqWebhookRequest (issue #313) — they were never
 *   in routeRequest.
 * - /schema/tables and /schema/query are generic ORM introspection routes
 *   and belong to a future schema/admin slice, not the MCP/chat/NLQ slice.
 *
 * Safety notes carried over verbatim from the original code:
 * - POST /api/chat delegates to runAgenticChatTurn (the same judge-routed
 *   pipeline the WebSocket chat runs); the route shell here does no chat
 *   logic of its own.
 * - The NLQ safety invariants (NLQ table allowlist seam, zod-validated plan,
 *   bound parameters) live inside executeNaturalLanguageQuery in
 *   src/agents/nlq.ts — untouched by this move; this file calls it, the
 *   same single-owner pipeline.
 * - PRE-EXISTING HYGIENE (noted, not fixed): the chat block's leading
 *   comment says "Natural Language Query (NLQ) endpoint" — that line was
 *   already mislabeled in orchestrator.ts before this move.
 */

import type { AgentName, AsyncJobRecord, AsyncJobSubmission, Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import {
  handleMCPRequest,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_SERVER_INFO,
  MCP_TOOLS,
} from "../../mcp";
import { executeNaturalLanguageQuery, type NLQSchedulingPort } from "../nlq";
import { resolveAiModelName } from "../model";
import { getUserDid } from "../did";
import { SqlScanRunStore, SqlStrategyProfileStore } from "../../trading";
import { createDiscoveryService } from "../../services/discoveryService";

/** The subset of OrchestratorAgent surface the MCP/chat/NLQ handlers need. */
export interface McpChatNlqRouteContext {
  getOrm(): DatabaseORM;
  getStorageSql(): any;
  env: Env;
  audit(
    type: string,
    agent: AgentName | "judge" | "nlq" | "orchestrator",
    payload: Record<string, unknown>
  ): void;
  submitAsyncJob(
    job: AsyncJobSubmission
  ): Promise<{ jobId: string; status: "queued"; statusUrl: string }>;
  getAsyncJob(jobId: string): AsyncJobRecord | undefined;
  listAsyncJobs(): AsyncJobRecord[];
  extractMessageText(message: unknown): string;
  /** Issue #686: the Think session's async message read. */
  getMessages(): Promise<any[]>;
  recordMessage(
    role: "user" | "assistant" | "system",
    content: string,
    agent: AgentName | "orchestrator"
  ): void;
  runAgenticChatTurn(opts: {
    userText: string;
    recentTurns: Array<{ role?: string; content: string }>;
    userLogin: string;
    isAutoOptionsResearchRequest: boolean;
  }): Promise<{
    result: any;
    route: {
      agent: string;
      confidence: number;
      reason: string;
      needsConfirmation: boolean;
    };
  }>;
  buildChatErrorFallback(err: unknown, userText: string, userLogin: string): Promise<string>;
  nlqSchedulingPort(): NLQSchedulingPort;
}

/**
 * Handles the MCP + chat + NLQ routes. Returns a Response on match, null
 * when none of its paths matches (the orchestrator then continues its
 * sequential matching).
 */
export async function handleMcpChatNlqRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: McpChatNlqRouteContext
): Promise<Response | null> {
  // Model Context Protocol (MCP) Server Endpoint (JSON-RPC 2.0 & Discovery)
  if (path.endsWith("/mcp")) {
    const orm = ctx.getOrm();

    if (request.method === "GET") {
      return Response.json({
        server: MCP_SERVER_INFO,
        tools: MCP_TOOLS,
        resources: MCP_RESOURCES,
        prompts: MCP_PROMPTS,
        endpoints: {
          jsonrpc: "/api/mcp",
          protocol: "MCP JSON-RPC 2.0",
        },
      });
    }

    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const response = await handleMCPRequest(body, {
          env: ctx.env,
          orm,
          sessionId,
          audit: (type, agent, payload) => ctx.audit(type, agent, payload),
          submitJob: (job) => ctx.submitAsyncJob(job),
          getJob: (jobId) => ctx.getAsyncJob(jobId),
          listJobs: () => ctx.listAsyncJobs().map(({ result: _result, ...job }) => job),
        });
        return Response.json(response);
      } catch (err: any) {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message || "Internal error" } },
          { status: 500 }
        );
      }
    }
  }

  // Natural Language Query (NLQ) endpoint
  // Issue #312: the advertised POST /api/chat. The Worker strips the /api
  // prefix when forwarding, so it arrives here as /chat (also registered as
  // an immediate endpoint in onRequest so it is not queued as an async job).
  // This is a thin adapter over the single-owner agentic chat turn
  // (runAgenticChatTurn) — the same judge-routed pipeline the WebSocket chat
  // runs. The HTTP response carries the completed turn as JSON; true
  // streaming remains available over the agent WebSocket chat the UI uses.
  // One turn per request, executed against the per-user conversation state.
  if ((path === "/chat" || path === "/api/chat") && request.method === "POST") {
    const chatBody = (await request.json().catch(() => null)) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    } | null;
    const incoming = Array.isArray(chatBody?.messages) ? chatBody.messages : [];
    const lastUserMessage = [...incoming]
      .reverse()
      .find((m) => typeof m?.role === "string" && (m.role as string).toLowerCase() === "user");
    const chatUserText = ctx.extractMessageText(lastUserMessage);
    if (!chatUserText) {
      return Response.json(
        { error: "messages must be a non-empty array with a final user message containing text." },
        { status: 400 }
      );
    }
    const chatUserLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
    try {
      // Run the pipeline against the per-user conversation state.
      // Issue #686: conversation state is the Think session. The turn
      // driver owns session appends (the user message enters through
      // runTurn's factory input, delta-by-id, so a re-sent history is
      // not duplicated; Think persists the assistant reply), and
      // beforeTurn is the single writer of the user mas_messages
      // record. This adapter only reads history for the judge's
      // recent-turns context.
      const existingMessages = await ctx.getMessages();
      const tailUser = [...existingMessages]
        .reverse()
        .find((m: any) => m?.role === "user");
      const chatRecentTurns = [
        ...existingMessages.slice(-6).map((m: any) => ({
          role: m?.role,
          content: ctx.extractMessageText(m),
        })),
        ...(ctx.extractMessageText(tailUser) !== chatUserText
          ? [{ role: "user", content: chatUserText }]
          : []),
      ].slice(-6);

      const { result: chatResult, route: chatRoute } = await ctx.runAgenticChatTurn({
        userText: chatUserText,
        recentTurns: chatRecentTurns,
        userLogin: chatUserLogin,
        isAutoOptionsResearchRequest: false,
      });
      const chatText = await chatResult.text;
      ctx.audit("chat.http_turn", "orchestrator", {
        route: chatRoute.agent,
        confidence: chatRoute.confidence,
        reason: chatRoute.reason,
      });

      return Response.json({
        reply: chatText,
        route: {
          agent: chatRoute.agent,
          confidence: chatRoute.confidence,
          reason: chatRoute.reason,
          needsConfirmation: chatRoute.needsConfirmation,
        },
        model: resolveAiModelName(ctx.env),
        streaming: false,
      });
    } catch (err) {
      // Same degraded content the WebSocket chat would stream, as JSON.
      const fallbackText = await ctx.buildChatErrorFallback(err, chatUserText, chatUserLogin);
      ctx.recordMessage("assistant", fallbackText, "orchestrator");
      return Response.json({ reply: fallbackText, fallback: true, streaming: false });
    }
  }

  if (path.endsWith("/nlq") && request.method === "POST") {
    try {
      const body = (await request.json().catch(() => ({}))) as {
        query?: string;
        context?: string;
        validateWithLLM?: boolean;
      };
      const query = (body.query || "").trim();
      if (!query) {
        return Response.json({ error: "Query parameter is required" }, { status: 400 });
      }

      const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
      const contextHeader = request.headers.get("x-nlq-context") || body.context;
      const userDid = getUserDid(sessionId);
      const orm = ctx.getOrm();
      const { plan, result } = await executeNaturalLanguageQuery(
        orm,
        sessionId,
        query,
        ctx.env,
        userLogin,
        userDid,
        { context: contextHeader, validateWithLLM: body.validateWithLLM, scanRunStore: new SqlScanRunStore(ctx.getStorageSql()), profileStore: new SqlStrategyProfileStore(ctx.getStorageSql()), schedulingPort: ctx.nlqSchedulingPort(), discoveryRunner: createDiscoveryService({ env: ctx.env, userLogin, orm, sql: ctx.getStorageSql() }) }
      );
      ctx.audit("nlq.executed", "nlq", {
        query,
        domain: result.domain,
        operation: plan.operation,
        count: result.count,
      });

      return Response.json(result);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : "NLQ query processing failed" }, { status: 500 });
    }
  }
  return null;
}
