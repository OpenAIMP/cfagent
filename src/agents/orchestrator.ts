import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { getWorkersAIModel } from "./model";
import { LLMJudge } from "./judge";
import { createMAS } from "./mas";
import { planNLQ, queryConversation } from "./nlq";
import type { Env, AgentName, AuditEvent, MessageRecord, MemoryRecord } from "../types";

/**
 * Normalizes messages into valid UIMessage structures with populated `parts`.
 * Prevents AI SDK's convertToModelMessages from crashing on undefined `parts`.
 * Discards empty assistant messages from interrupted turns and merges consecutive user turns.
 */
function normalizeMessagesForSDK(messages: unknown[]): any[] {
  if (!Array.isArray(messages)) return [];
  const valid: any[] = [];

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = m as any;
    const role = item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user";
    const text = typeof item.content === "string" ? item.content.trim() : "";

    let parts = Array.isArray(item.parts) ? [...item.parts].filter(Boolean) : [];
    if (parts.length === 0 && text) {
      parts = [{ type: "text", text }];
    }

    // Skip empty assistant messages from aborted/interrupted turns
    if (role === "assistant" && !text && parts.every((p: any) => p.type === "text" && !p.text?.trim())) {
      continue;
    }

    if (parts.length === 0) {
      if (role === "user") {
        parts = [{ type: "text", text: text || "Hello" }];
      } else {
        continue;
      }
    }

    // Merge consecutive user messages to maintain strictly alternating conversation flow
    if (valid.length > 0 && valid[valid.length - 1].role === "user" && role === "user") {
      const prev = valid[valid.length - 1];
      const mergedText = `${prev.content}\n${text}`.trim();
      prev.content = mergedText;
      prev.parts = [{ type: "text", text: mergedText }];
      continue;
    }

    valid.push({
      id: item.id || crypto.randomUUID(),
      role,
      content: text,
      parts,
    });
  }

  return valid;
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
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_referrals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        category TEXT NOT NULL,
        reward_text TEXT NOT NULL,
        clicks INTEGER DEFAULT 0,
        signups INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_ads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tagline TEXT NOT NULL,
        sponsor TEXT NOT NULL,
        badge TEXT NOT NULL,
        url TEXT NOT NULL,
        cta_text TEXT NOT NULL,
        accent_color TEXT NOT NULL,
        impressions INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    // Seed default sponsor offers if ads table is empty
    try {
      const adCount = Array.from(sql.exec("SELECT COUNT(*) AS count FROM mas_ads")) as Array<{ count: number }>;
      if ((adCount[0]?.count ?? 0) === 0) {
        const now = new Date().toISOString();
        const seedAds = [
          {
            id: "ad_workers_ai",
            title: "Cloudflare Workers AI",
            tagline: "Run state-of-the-art models (GLM-4.7, Llama 3.3) on serverless GPUs with zero cold starts.",
            sponsor: "Cloudflare",
            badge: "FLAGSHIP PARTNER",
            url: "https://developers.cloudflare.com/workers-ai/",
            cta_text: "Deploy in 60s →",
            accent_color: "#f38020",
          },
          {
            id: "ad_ai_search",
            title: "Cloudflare AI Search",
            tagline: "Build enterprise RAG pipelines with native auto-chunking, Vectorize indexes, and real-time semantic retrieval.",
            sponsor: "Cloudflare AI",
            badge: "FEATURED TOOL",
            url: "https://developers.cloudflare.com/ai-search/",
            cta_text: "Explore Docs →",
            accent_color: "#38bdf8",
          },
          {
            id: "ad_durable_objects",
            title: "Durable Objects SQLite",
            tagline: "Strongly consistent transactional databases running natively at the edge for stateful AI agents.",
            sponsor: "Cloudflare Platform",
            badge: "INFRASTRUCTURE",
            url: "https://developers.cloudflare.com/durable-objects/",
            cta_text: "Learn More →",
            accent_color: "#a855f7",
          },
          {
            id: "ad_openaimp",
            title: "OpenAIMP Agent Studio",
            tagline: "Scale autonomous multi-agent workflows with real-time LLM Judge routing and persistent memory.",
            sponsor: "OpenAIMP",
            badge: "SPONSOR",
            url: "https://agent.openaimp.com",
            cta_text: "Join Program →",
            accent_color: "#10b981",
          },
        ];

        for (const ad of seedAds) {
          sql.exec(
            "INSERT OR IGNORE INTO mas_ads (id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
            ad.id,
            ad.title,
            ad.tagline,
            ad.sponsor,
            ad.badge,
            ad.url,
            ad.cta_text,
            ad.accent_color,
            now
          );
        }
      }
    } catch {
      // Ignore if seeding fails
    }

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

    // Purge any empty assistant messages from prior failed turns in session memory
    this.messages = this.messages.filter((m: any) => {
      if (!m || typeof m !== "object") return false;
      if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content.trim() : "";
        const parts = Array.isArray(m.parts) ? m.parts : [];
        const hasText = parts.some((p: any) => p && p.type === "text" && typeof p.text === "string" && p.text.trim());
        const hasTool = parts.some((p: any) => p && p.type !== "text");
        return Boolean(text || hasText || hasTool);
      }
      return true;
    });

    // Safely retrieve last user question
    const lastUserMsg = [...this.messages].reverse().find((m: unknown) => (m as { role?: string })?.role === "user");
    const userText = this.extractMessageText(lastUserMsg);

    if (userText) {
      this.recordMessage("user", userText, "orchestrator");
    }

    // Run Judge intent classification with recent conversation history
    const recentTurns = (this.messages || []).slice(-6).map((m: any) => ({
      role: m?.role,
      content: this.extractMessageText(m),
    }));

    const judge = new LLMJudge(this.env);
    const route = await judge.route(userText, recentTurns);
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

    // Fetch active session facts directly from SQLite to ground every turn
    const activeMemories = Array.from(
      sql.exec("SELECT key, value FROM mas_memory ORDER BY updated_at DESC LIMIT 8")
    ) as Array<{ key: string; value: string }>;
    const memoryContext = activeMemories.length > 0
      ? `\nActive Persistent Memory (SQLite Session Facts):\n` + activeMemories.map(m => `- ${m.key}: "${m.value}"`).join("\n")
      : "";

    const model = getWorkersAIModel(this.env);
    const maxSteps = Math.max(1, Math.min(10, Number(this.env.MAS_MAX_STEPS || 6)));

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
Intent router classified request as: [${route.agent}] (confidence: ${(route.confidence * 100).toFixed(0)}%). Rationale: ${route.reason}.${memoryContext}

Sub-agent capabilities available to you:
- 'searchKnowledge': Retrieve facts from Cloudflare AI Search knowledge base.
- 'draftPayment': Prepare payment authorization drafts (charges, refunds, invoices). NEVER execute unverified money movement.
- 'createTaskDraft': Draft actionable tasks with priorities and deadlines.
- 'confirmDraft': Formally approve, authorize, or cancel a pending payment or task draft upon explicit user confirmation.
- 'rememberFact' / 'recallFacts': Read and write persistent memory facts stored in SQLite for this session.

Agentic Best Practices & Workflow Rules:
1. RAG & Knowledge Retrieval: If 'searchKnowledge' returns matching documents, cite them accurately. If 'searchKnowledge' returns 0 documents (or empty chunks), explicitly state that no internal documents were found in the custom knowledge base, and then synthesize a comprehensive, helpful answer from verified domain knowledge so the user's question is thoroughly answered.
2. Human-in-the-Loop (HITL) Execution: For financial drafts or task proposals, always require human confirmation. When a user approves (or mentions a draft ID like pay_xxx or task_xxx), call 'confirmDraft' with decision: 'approved'.
3. Multi-Turn Context & Session Memory: Respect the active session memory facts shown above. When the user asks to remember a preference, call 'rememberFact'.
4. Be structured, transparent, accurate, and professional. Avoid repeating internal tool call boilerplate.`,
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
        onError: ({ error }) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.audit("stream.error", "orchestrator", { error: errMsg });
        },
      });

      return result.toUIMessageStreamResponse();
    } catch (streamErr) {
      const errorMsg = streamErr instanceof Error ? streamErr.message : "Error initializing agent stream";
      this.audit("stream.error", "orchestrator", { error: errorMsg });

      // Return a compliant AI SDK v5 text stream response
      const fallbackText = "I encountered a temporary issue connecting to Workers AI. Please try sending your message again.";
      const payload = [
        `data: ${JSON.stringify({ type: "text-start", id: "text-1" })}`,
        `data: ${JSON.stringify({ type: "text-delta", delta: fallbackText })}`,
        `data: ${JSON.stringify({ type: "text-end" })}`,
        "data: [DONE]",
        "",
      ].join("\n\n");

      return new Response(payload, {
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

    // Clear active conversation transcript for LLM, preserving historical SQLite analytics
    if (path.endsWith("/clear") && request.method === "POST") {
      try {
        await this.persistMessages([]);
        this.resetTurnState();
        const purge = url.searchParams.get("purge") === "true";
        if (purge) {
          sql.exec("DELETE FROM mas_messages WHERE session_id = ?", sessionId);
          this.audit("history.purged", "orchestrator", {});
        } else {
          this.audit("history.cleared", "orchestrator", {});
        }
        return Response.json({
          success: true,
          message: purge ? "All historical transcripts purged from SQLite" : "Active chat cleared; historical analytics vault preserved in SQLite",
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to clear history" }, { status: 500 });
      }
    }

    // Referrals & Affiliate Links endpoint
    if (path.endsWith("/referrals")) {
      if (request.method === "GET") {
        try {
          const raw = Array.from(
            sql.exec("SELECT id, session_id, title, url, category, reward_text, clicks, signups, created_at FROM mas_referrals ORDER BY created_at DESC LIMIT 100")
          ) as any[];
          const referrals = raw.map((r) => ({
            id: String(r.id),
            userLogin: String(r.session_id),
            title: String(r.title),
            url: String(r.url),
            category: String(r.category),
            rewardText: String(r.reward_text),
            clicks: Number(r.clicks || 0),
            signups: Number(r.signups || 0),
            createdAt: String(r.created_at),
          }));
          return Response.json({ count: referrals.length, referrals });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch referrals" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            title?: string;
            url?: string;
            category?: string;
            rewardText?: string;
          };
          const title = (body.title || "").trim();
          const targetUrl = (body.url || "").trim();
          const category = (body.category || "AI & Dev Tools").trim();
          const rewardText = (body.rewardText || "Community referral reward").trim();

          if (!title || !targetUrl) {
            return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
          }

          const id = `ref_${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          sql.exec(
            "INSERT INTO mas_referrals (id, session_id, title, url, category, reward_text, clicks, signups, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)",
            id,
            sessionId,
            title,
            targetUrl,
            category,
            rewardText,
            now
          );
          this.audit("referral.created", "orchestrator", { id, title, targetUrl });
          return Response.json({
            success: true,
            referral: { id, userLogin: sessionId, title, url: targetUrl, category, rewardText, clicks: 0, signups: 0, createdAt: now },
          });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to save referral link" }, { status: 500 });
        }
      }

      if (request.method === "DELETE") {
        try {
          const id = url.searchParams.get("id");
          if (id) {
            sql.exec("DELETE FROM mas_referrals WHERE id = ?", id);
            this.audit("referral.deleted", "orchestrator", { id });
          }
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to delete referral" }, { status: 500 });
        }
      }
    }

    if (path.endsWith("/referrals/click") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        if (body.id) {
          sql.exec("UPDATE mas_referrals SET clicks = clicks + 1 WHERE id = ?", body.id);
        }
        return Response.json({ success: true });
      } catch {
        return Response.json({ success: false });
      }
    }

    // Sponsored Ads & Marketplace endpoint
    if (path.endsWith("/ads")) {
      if (request.method === "GET") {
        try {
          // Increment impressions on fetch
          sql.exec("UPDATE mas_ads SET impressions = impressions + 1");
          const raw = Array.from(
            sql.exec("SELECT id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at FROM mas_ads ORDER BY clicks DESC, impressions ASC LIMIT 20")
          ) as any[];
          const ads = raw.map((a) => ({
            id: String(a.id),
            title: String(a.title),
            tagline: String(a.tagline),
            sponsor: String(a.sponsor),
            badge: String(a.badge),
            url: String(a.url),
            ctaText: String(a.cta_text),
            accentColor: String(a.accent_color || "#6366f1"),
            impressions: Number(a.impressions || 0),
            clicks: Number(a.clicks || 0),
            createdAt: String(a.created_at),
          }));
          return Response.json({ count: ads.length, ads });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch ads" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as {
            title?: string;
            tagline?: string;
            sponsor?: string;
            badge?: string;
            url?: string;
            ctaText?: string;
            accentColor?: string;
          };
          const title = (body.title || "").trim();
          const tagline = (body.tagline || "").trim();
          const sponsor = (body.sponsor || "Community Partner").trim();
          const badge = (body.badge || "PROMOTED").trim();
          const targetUrl = (body.url || "").trim();
          const ctaText = (body.ctaText || "Claim Deal →").trim();
          const accentColor = (body.accentColor || "#38bdf8").trim();

          if (!title || !targetUrl) {
            return Response.json({ error: "Title and Target URL are required" }, { status: 400 });
          }

          const id = `ad_${crypto.randomUUID().slice(0, 8)}`;
          const now = new Date().toISOString();
          sql.exec(
            "INSERT INTO mas_ads (id, title, tagline, sponsor, badge, url, cta_text, accent_color, impressions, clicks, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)",
            id,
            title,
            tagline,
            sponsor,
            badge,
            targetUrl,
            ctaText,
            accentColor,
            now
          );
          this.audit("ad.submitted", "orchestrator", { id, title, sponsor });
          return Response.json({
            success: true,
            ad: { id, title, tagline, sponsor, badge, url: targetUrl, ctaText, accentColor, impressions: 1, clicks: 0, createdAt: now },
          });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to submit ad" }, { status: 500 });
        }
      }
    }

    if (path.endsWith("/ads/click") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        if (body.id) {
          sql.exec("UPDATE mas_ads SET clicks = clicks + 1 WHERE id = ?", body.id);
          this.audit("ad.clicked", "orchestrator", { id: body.id });
        }
        return Response.json({ success: true });
      } catch {
        return Response.json({ success: false });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}
