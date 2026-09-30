import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { LLMJudge } from "./judge";
import { createMAS } from "./mas";
import { planNLQ, queryConversation } from "./nlq";
import type { Env, AgentName, AuditEvent, MessageRecord, MemoryRecord } from "../types";

/**
 * Normalizes messages into valid UIMessage structures with populated `parts`.
 * Prevents AI SDK's convertToModelMessages from crashing on undefined `parts`.
 */
function normalizeMessagesForSDK(messages: unknown[]): any[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m: any) => {
      if (!m || typeof m !== "object") return null;
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
      const text = typeof m.content === "string" ? m.content.trim() : "";

      let parts = Array.isArray(m.parts) ? [...m.parts] : [];
      if (parts.length === 0 && text) {
        parts = [{ type: "text", text }];
      } else if (parts.length === 0) {
        // Discard completely empty messages to protect model context
        return null;
      } else {
        parts = parts.filter(Boolean);
      }

      return {
        id: m.id || crypto.randomUUID(),
        role,
        content: text,
        parts,
      };
    })
    .filter(Boolean);
}

export class OrchestratorAgent extends AIChatAgent<Env> {
  private ensureTables() {
    const storage = this.ctx.storage;
    const sql = storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        agent TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    return sql;
  }

  private sessionKey(): string {
    return this.ctx.id.toString();
  }

  private audit(type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) {
    try {
      const sql = this.ensureTables();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      sql.exec(
        "INSERT INTO mas_events (id, session_id, type, agent, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        this.sessionKey(),
        type,
        agent,
        JSON.stringify(payload),
        now
      );
    } catch {
      // Don't fail execution if audit insertion fails
    }
  }

  private recordMessage(role: "user" | "assistant" | "system", content: string, agent: AgentName | "orchestrator") {
    try {
      const sql = this.ensureTables();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      sql.exec(
        "INSERT INTO mas_messages (id, session_id, role, content, agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        this.sessionKey(),
        role,
        content.slice(0, 30000),
        agent,
        now
      );
    } catch {
      // Don't fail execution if record insertion fails
    }
  }

  private extractMessageText(message: unknown): string {
    if (!message || typeof message !== "object") return "";
    const m = message as { content?: unknown; parts?: Array<{ type?: string; text?: string }> };

    if (typeof m.content === "string" && m.content.trim()) {
      return m.content.trim();
    }

    if (Array.isArray(m.parts)) {
      return m.parts
        .filter((p) => p && p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("")
        .trim();
    }

    return "";
  }

  async onChatMessage() {
    const requestId = crypto.randomUUID();
    const sql = this.ensureTables();
    const sessionId = this.sessionKey();

    // Safely retrieve last user question
    const lastUserMsg = [...this.messages].reverse().find((m: unknown) => (m as { role?: string })?.role === "user");
    const userText = this.extractMessageText(lastUserMsg);

    if (userText) {
      this.recordMessage("user", userText, "orchestrator");
    }

    // Run Judge intent classification
    const judge = new LLMJudge(this.env);
    const route = await judge.route(userText);
    this.audit("route.decided", "judge", {
      route: route.agent,
      confidence: route.confidence,
      reason: route.reason,
      needsConfirmation: route.needsConfirmation,
    });

    // Provide unified toolset
    const tools = createMAS({
      env: this.env,
      sessionId,
      requestId,
      sql,
      audit: (type, agent, payload) => this.audit(type, agent, payload),
    });

    const model = createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.1-8b-instruct");
    const maxSteps = Math.max(1, Math.min(10, Number(this.env.MAS_MAX_STEPS || 4)));

    // Safely normalize messages to prevent AI SDK convertToModelMessages crashes
    let modelMessages: any[];
    try {
      const cleanMessages = normalizeMessagesForSDK(this.messages);
      modelMessages = await convertToModelMessages(cleanMessages);
      if (!modelMessages || modelMessages.length === 0) {
        modelMessages = [{ role: "user", content: [{ type: "text", text: userText || "Hello" }] }];
      }
    } catch {
      modelMessages = [{ role: "user", content: [{ type: "text", text: userText || "Hello" }] }];
    }

    try {
      const result = streamText({
        model,
        system: `You are the master orchestrator for an enterprise multi-agent assistant powered by Cloudflare Agents and SQLite.
Intent router classified request as: [${route.agent}] (confidence: ${(route.confidence * 100).toFixed(0)}%). Rationale: ${route.reason}.

Sub-agent capabilities available to you:
- 'searchKnowledge': Retrieve facts from Cloudflare AI Search knowledge base. Always cite relevant facts.
- 'draftPayment': Prepare payment authorization drafts (charges, refunds, invoices). NEVER execute or claim money was transferred.
- 'createTaskDraft': Draft actionable tasks with priorities and deadlines.
- 'rememberFact' / 'recallFacts': Read and write persistent memory facts stored in SQLite for this session.

Guidelines:
1. Be helpful, concise, transparent, and accurate.
2. If tool results say 'awaiting_confirmation' or 'draft', make it clearly visible that human approval is required.
3. If search yields no relevant results, clearly acknowledge this without fabricating data.`,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        onFinish: async ({ text }) => {
          if (text) {
            this.recordMessage("assistant", text, route.agent);
            // Run background quality evaluation
            const quality = await judge.evaluate({ question: userText, answer: text, agent: route.agent });
            this.audit("response.evaluated", "judge", {
              score: quality.score,
              grounded: quality.grounded,
              safe: quality.safe,
              issues: quality.issues,
            });
          }
        },
      });

      return result.toUIMessageStreamResponse();
    } catch (streamErr) {
      const errorMsg = streamErr instanceof Error ? streamErr.message : "Error initializing agent stream";
      this.audit("stream.error", "orchestrator", { error: errorMsg });

      // Return a clean fallback response if streamText initialization failed
      return new Response(`event: message\ndata: ${JSON.stringify({ type: "text-delta", text: "I experienced a temporary error connecting to Workers AI. Please try again." })}\n\n`, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const sql = this.ensureTables();
    const sessionId = this.sessionKey();

    // Natural Language Query (NLQ) endpoint
    if (path.endsWith("/nlq") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { query?: string };
        const query = (body.query || "").trim();
        if (!query) {
          return Response.json({ error: "Query parameter is required" }, { status: 400 });
        }

        const plan = await planNLQ(this.env, query);
        const result = queryConversation(sql, sessionId, plan);
        this.audit("nlq.executed", "nlq", { query, operation: plan.operation, count: result.count });

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "NLQ query processing failed" }, { status: 500 });
      }
    }

    // Audit logs endpoint
    if (path.endsWith("/audit") && request.method === "GET") {
      try {
        const limitParam = Number(url.searchParams.get("limit") || 50);
        const limit = Math.max(1, Math.min(100, limitParam));
        const events = Array.from(
          sql.exec(
            "SELECT id, type, agent, payload, created_at FROM mas_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
            sessionId,
            limit
          )
        ) as Array<{ id: string; type: string; agent: string; payload: string; created_at: string }>;

        const parsed = events.map((e) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(e.payload);
          } catch {
            payload = { raw: e.payload };
          }
          return { ...e, payload };
        });

        return Response.json({ count: parsed.length, events: parsed });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch audit log" }, { status: 500 });
      }
    }

    // Persistent Memory facts endpoint
    if (path.endsWith("/memory")) {
      if (request.method === "GET") {
        try {
          const rawMemories = Array.from(
            sql.exec("SELECT key, value, updated_at FROM mas_memory ORDER BY updated_at DESC LIMIT 100")
          ) as Array<{ key: string; value: string; updated_at: string }>;
          const memories: MemoryRecord[] = rawMemories.map((m) => ({
            key: String(m.key),
            value: String(m.value),
            updatedAt: String(m.updated_at),
          }));
          return Response.json({ count: memories.length, memories });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch memories" }, { status: 500 });
        }
      }

      if (request.method === "DELETE") {
        try {
          const key = url.searchParams.get("key");
          if (key) {
            sql.exec("DELETE FROM mas_memory WHERE key = ?", key);
            this.audit("memory.deleted", "memory", { key });
          } else {
            sql.exec("DELETE FROM mas_memory");
            this.audit("memory.cleared", "memory", {});
          }
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to delete memory" }, { status: 500 });
        }
      }
    }

    // Clear conversation transcript
    if (path.endsWith("/clear") && request.method === "POST") {
      try {
        sql.exec("DELETE FROM mas_messages WHERE session_id = ?", sessionId);
        this.audit("history.cleared", "orchestrator", {});
        return Response.json({ success: true, message: "Conversation history cleared" });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to clear history" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}
