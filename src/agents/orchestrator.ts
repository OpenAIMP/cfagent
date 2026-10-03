import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, stepCountIs } from "ai";
import { DEFAULT_AI_MODEL, getWorkersAIModel } from "./model";
import { LLMJudge } from "./judge";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync } from "./nlq";
import { DatabaseORM } from "../orm";
import { PaymentGatewayService, type SupportedGateway } from "../services/payments";
import { ETradeService } from "../services/etrade";
import { resolveEnvironmentConfig } from "../config/environment";
import { getValidTokens } from "../security/etradeOAuth";
import { ETradeRestClient } from "../trading/etrade/client";
import { FossResearchService } from "../services/fossResearch";
import { YFinanceMarketScreener } from "../trading/yfinanceScreener";
import { DynamicOptionsScreener } from "../trading/optionsScreener";
import { recommendOptionStrategies, type StrategyRequest } from "../trading/options/strategyEngine";
import { OptionsAgentPipeline, validateStrategyRequest, type StrategyScreenFilter, type RiskProfile } from "../trading/options";
import { generateLlmCandidateIdeas, rankCandidatesWithLlm } from "../trading/options/llmComparison";
import { AGENT_DIDS, createDidAttestation, getUserDid, resolveAgentDidDocument } from "./did";
import { createMAS } from "./mas";
import { createAgentMcpTools } from "./mcpAdapter";
import { ETradeEmailTradingService } from "../trading/email/agent";
import { ETradeSlackTradingService } from "../trading/slack/agent";
import { ETradeVoiceTradingService } from "../trading/voice/agent";
import { ETradeWebhookService } from "../services/tradingWebhooks";
import { McpSystemFacade } from "../patterns/facade";
import { handleMCPRequest, MCP_SERVER_INFO, MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS } from "../mcp";
import { ScheduledTasksService } from "../services/scheduledTasks";
import { ETradeAgenticPaymentService, TRADING_PAID_SERVICES } from "../services/agenticPayments";
import type {
  Env,
  AgentName,
  AuditEvent,
  MessageRecord,
  MemoryRecord,
  TransactionRecord,
  CategoryRecord,
  ExternalAdRecord,
  RevenueSummary,
} from "../types";

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
  /**
   * Cloudflare Agents Lifecycle: onStart
   * Initializes SQLite tables and registers baseline idempotent cron and interval schedules
   */
  async onStart(props?: Record<string, unknown>): Promise<void> {
    this.ensureTables();

    try {
      // 1. Proactive daily E*TRADE token renewal at 23:00 ET (idempotent by default for cron)
      if (typeof (this as any).schedule === "function") {
        await (this as any).schedule(
          "0 23 * * *",
          "autoRenewETradeTokens",
          { userLogin: this.sessionKey() },
          { idempotent: true }
        );
      }

      // 2. Autonomous market screening interval (runs every 300 seconds / 5 min)
      if (typeof (this as any).scheduleEvery === "function") {
        await (this as any).scheduleEvery(
          300,
          "autonomousMarketScreen",
          { sector: "Technology", maxItems: 5 }
        );
      }
    } catch (schedErr) {
      console.warn("[OrchestratorAgent][onStart] Note on schedule registration:", schedErr);
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Proactively renews E*TRADE tokens before midnight ET
   */
  async autoRenewETradeTokens(payload?: { userLogin?: string; env?: string }): Promise<void> {
    const user = payload?.userLogin || this.sessionKey();
    const service = new ScheduledTasksService(this.env, this.getOrm(), user);
    const res = await service.autoRenewETradeTokens(user, payload?.env);
    if (!res.success) {
      console.warn("[OrchestratorAgent] autoRenewETradeTokens error:", res.error);
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Runs periodic market screening
   * Protected with keepAliveWhile to avoid DO inactivity eviction
   */
  async autonomousMarketScreen(payload?: { sector?: string; maxItems?: number; broadcast?: boolean }): Promise<void> {
    const runScreen = async () => {
      const service = new ScheduledTasksService(this.env, this.getOrm(), this.sessionKey());
      const res = await service.autonomousMarketScreen(payload);
      if (res.success && res.data?.opportunities && res.data.opportunities.length > 0) {
        if (typeof (this as any).broadcast === "function") {
          try {
            (this as any).broadcast(
              JSON.stringify({
                type: "market_alert",
                title: "Autonomous Screener Alert",
                count: res.data.opportunities.length,
                opportunities: res.data.opportunities,
                timestamp: res.timestamp,
              })
            );
          } catch {
            // Non-critical broadcast error
          }
        }
      }
    };

    if (typeof (this as any).keepAliveWhile === "function") {
      await (this as any).keepAliveWhile(runScreen);
    } else {
      await runScreen();
    }
  }

  /**
   * Cloudflare Agents Scheduled Callback: Auto-expires a stale unconfirmed order draft
   */
  async expireStaleOrderDraft(payload: { orderId: string; userLogin?: string }): Promise<void> {
    if (!payload?.orderId) return;
    const service = new ScheduledTasksService(this.env, this.getOrm(), payload.userLogin || this.sessionKey());
    await service.expireStaleOrderDraft(payload.orderId);
  }

  /**
   * Cloudflare Agents Scheduled Callback: Dispatches a user reminder
   */
  async sendScheduledReminder(payload: { reminderId: string; message: string; userLogin?: string }): Promise<void> {
    if (!payload?.reminderId) return;
    const service = new ScheduledTasksService(this.env, this.getOrm(), payload.userLogin || this.sessionKey());
    const res = await service.dispatchReminder(payload.reminderId, payload.message);
    if (typeof (this as any).broadcast === "function") {
      try {
        (this as any).broadcast(
          JSON.stringify({
            type: "scheduled_reminder",
            reminderId: payload.reminderId,
            message: payload.message,
            timestamp: res.timestamp,
          })
        );
      } catch {
        // Non-critical broadcast error
      }
    }
  }

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

    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_watchlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        user_login TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        items_json TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

    sql.exec(`
      CREATE TABLE IF NOT EXISTS mas_transactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        customer TEXT NOT NULL,
        gateway TEXT NOT NULL,
        gateway_ref TEXT,
        status TEXT NOT NULL,
        checkout_url TEXT,
        proposer_did TEXT NOT NULL,
        authorizer_did TEXT,
        proof_signature TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Seed default transactions if table is empty
    try {
      const txCount = Array.from(sql.exec("SELECT COUNT(*) AS count FROM mas_transactions")) as Array<{ count: number }>;
      if ((txCount[0]?.count ?? 0) === 0) {
        const now = new Date().toISOString();
        const sessionId = this.sessionKey();
        const userDid = getUserDid(sessionId);

        sql.exec(
          "INSERT OR IGNORE INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "pay_init_stripe",
          sessionId,
          "charge",
          25.00,
          "USD",
          "Enterprise Team",
          "stripe",
          "cs_live_seed_compute_tokens",
          "completed",
          "https://checkout.stripe.com/c/pay/cs_live_seed",
          AGENT_DIDS.PAYMENTS,
          userDid,
          "sig_0x4b78a9c2e1f40d89e5a1b3c7d6e8f2a4",
          "500,000 AI Inference Token Credits Bundle",
          now,
          now
        );

        sql.exec(
          "INSERT OR IGNORE INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          "pay_init_paypal",
          sessionId,
          "charge",
          15.00,
          "USD",
          "Acme Partner Corp",
          "paypal",
          "ORDER-789012345",
          "completed",
          "https://www.paypal.com/checkoutnow?token=ORDER-789012345",
          AGENT_DIDS.PAYMENTS,
          userDid,
          "sig_0x8f2d1e4c9b3a7f0e6d5c2a1b4e9f8a7d",
          "Developer Sandbox Token Allowance",
          now,
          now
        );
      }
    } catch {
      // Ignore if seeding fails
    }

    return sql;
  }

  private sessionKey(): string {
    return this.ctx.id.toString();
  }

  private getOrm(): DatabaseORM {
    this.ensureTables();
    const orm = new DatabaseORM(this.ctx.storage.sql);
    orm.initializeSchema(this.sessionKey());
    return orm;
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

    // Instantiate GoF Facade & GRASP Controller
    const orm = this.getOrm();
    const facade = new McpSystemFacade(this.env, orm, sessionId);

    // Provide unified toolset adapting all 14 MCP commands directly into the AI SDK agent (GoF Adapter Pattern)
    const tools = createAgentMcpTools({
      env: this.env,
      orm,
      sessionId,
      requestId,
      facade,
      audit: (type: string, agent: any, payload: Record<string, unknown>) =>
        this.audit(type, agent, payload),
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

Sub-agent & MCP capabilities directly available to you (GoF Command & Adapter Architecture):
- 'knowledge_search' / 'searchKnowledge': Retrieve facts from Cloudflare AI Search knowledge base.
- 'draft_payment' / 'draftPayment': Prepare payment authorization drafts with Agent DIDs (charges, refunds, invoices) across Stripe, PayPal, Lemon Squeezy, Sandbox. NEVER execute unverified money movement.
- 'confirm_payment_draft' / 'confirmDraft': Formally approve, authorize, or cancel a pending payment or task draft upon explicit user confirmation.
- 'get_payment_gateways': Inspect processor health status and registered agent DIDs.
- 'get_transactions': Query transaction ledger and cryptographic proof signatures.
- 'execute_nlq': Execute natural language queries over database tables, schemas, trading, or conversations.
- 'list_database_tables': Inspect database tables, schema columns, and row counts via DatabaseORM.
- 'query_table_data': Query rows from any table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_events, mas_trades) with filters and pagination.
- 'manage_categories': Full CRUD for referral categories taxonomy in SQLite.
- 'manage_referrals': Manage developer referral links and track click attribution.
- 'manage_external_ads': Manage external ad placements (EthicalAds, Carbon, AdSense, Direct) and track CPM/CPC impressions.
- 'get_revenue_summary': Compute platform financial analytics across ad networks, transaction fees, and net profit.
- 'manage_session_memory' / 'rememberFact': Read, persist, or clear session facts in SQLite.
- 'get_audit_events': Stream real-time routing decisions, judge evaluations, and security logs.
- 'createTaskDraft': Draft actionable tasks with priorities and deadlines.
- 'etrade_market_scan': Screen and scan equities across technical and fundamental indicators (RSI, Market Cap, Sector, Price, MACD, Volume, Gainers/Losers).
- 'etrade_get_quote': Look up real-time equity quotes with Bid, Ask, Volume, and 52-week statistics.
- 'etrade_preview_order': Prepare an order proposal draft with cryptographic Agent DID attestation ('did:agent:openaimp:trading'). NEVER execute without human confirmation.
- 'etrade_execute_order': Submit and execute a confirmed order draft after explicit human authorization.
- 'etrade_get_positions': Retrieve broker account balances, equity holdings, and real-time unrealized P&L.

Agentic Best Practices & Workflow Rules:
1. Direct MCP Tool Self-Consumption: You have direct access to database tables, revenue analytics, categories, ads, transactions, and trading. Always invoke these tools when answering user questions about data, finances, or system state.
2. RAG & Knowledge Retrieval: If 'knowledge_search' returns matching documents, cite them accurately. If it returns 0 documents, explicitly state that no internal documents were found in the custom knowledge base, then synthesize a comprehensive, helpful answer from verified domain knowledge so the user's question is thoroughly answered.
3. Human-in-the-Loop (HITL) Execution: For financial operations or task proposals, always require human confirmation. When a user approves (or mentions a draft ID like pay_xxx or task_xxx), call 'confirm_payment_draft' with decision: 'approved'.
4. Multi-Turn Context & Session Memory: Respect the active session memory facts shown above. When the user asks to remember a preference, call 'manage_session_memory' with action: 'remember'.
5. E*TRADE Trading & Market Screening: When user asks to scan, screen, quote, or trade stocks, invoke 'etrade_market_scan' or 'etrade_get_quote'. For trade orders (buy/sell), ALWAYS use 'etrade_preview_order' to draft a proposal. Only execute via 'etrade_execute_order' when the user explicitly confirms approval.
6. Be structured, transparent, accurate, and professional. Avoid repeating internal tool call boilerplate.`,
        messages: modelMessages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        onFinish: async ({ text }: { text?: string }) => {
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
        onError: ({ error }: { error: unknown }) => {
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

    if (path.endsWith("/trading/reports/email") && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        to?: string;
        fileName?: string;
        attachmentBase64?: string;
        title?: string;
      } | null;
      const recipient = typeof body?.to === "string" ? body.to.trim() : "";
      const fileName = typeof body?.fileName === "string" ? body.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") : "";
      const attachmentBase64 = typeof body?.attachmentBase64 === "string" ? body.attachmentBase64 : "";
      if (!body || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient)) {
        return Response.json({ error: "A valid email recipient is required." }, { status: 400 });
      }
      if (!fileName.toLowerCase().endsWith(".xlsx") || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachmentBase64) || attachmentBase64.length > 7_000_000) {
        return Response.json({ error: "A valid .xlsx workbook under 5 MB is required." }, { status: 400 });
      }
      let workbookBytes: Uint8Array;
      try {
        const binary = atob(attachmentBase64);
        workbookBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      } catch {
        return Response.json({ error: "The workbook attachment is not valid base64." }, { status: 400 });
      }
      if (workbookBytes.length > 5 * 1024 * 1024 || workbookBytes[0] !== 0x50 || workbookBytes[1] !== 0x4b) {
        return Response.json({ error: "The attachment must be a valid .xlsx workbook under 5 MB." }, { status: 400 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const emailService = new ETradeEmailTradingService(this.env, this.getOrm(), userLogin);
      const title = (typeof body.title === "string" ? body.title : "Research report").replace(/[\r\n]/g, " ").slice(0, 120);
      const sent = await emailService.sendOutboundEmail(
        recipient,
        `Research report: ${title}`,
        "<p>Your requested research workbook is attached.</p><p>Research only; no trades were placed.</p>",
        "Your requested research workbook is attached.\nResearch only; no trades were placed.",
        {
          fileName,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          contentBase64: attachmentBase64,
        },
      );
      if (!sent) return Response.json({ error: "Email delivery is unavailable; check the configured email binding." }, { status: 503 });
      this.audit("research_report.emailed", "trading", { recipient, fileName });
      return Response.json({ success: true });
    }

    if (path.endsWith("/trading/reports/webhook") && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        title?: string;
        query?: string;
        sheets?: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
      } | null;
      if (!body || !Array.isArray(body.sheets) || body.sheets.length === 0 ||
        body.sheets.some((sheet) => !sheet || typeof sheet.name !== "string" || !Array.isArray(sheet.rows))) {
        return Response.json({ error: "A research report with named data sheets is required." }, { status: 400 });
      }
      const reportData = JSON.stringify({ title: body.title || "Research report", query: body.query || "", sheets: body.sheets });
      if (reportData.length > 512_000) return Response.json({ error: "The recommendation report exceeds the 512 KB webhook limit." }, { status: 413 });
      if (!this.env.OUTBOUND_WEBHOOK_URL || !this.env.OUTBOUND_WEBHOOK_SECRET) {
        return Response.json({ error: "Configure OUTBOUND_WEBHOOK_URL and OUTBOUND_WEBHOOK_SECRET to publish recommendations." }, { status: 503 });
      }
      const userLogin = request.headers.get("x-user-login") || sessionId;
      const webhook = new ETradeWebhookService(this.getOrm(), this.env, userLogin);
      const result = await webhook.dispatchOutboundWebhook("research.recommendations", JSON.parse(reportData));
      if (!result.success) return Response.json({ error: result.error || `Webhook returned HTTP ${result.status}.` }, { status: 502 });
      this.audit("research_report.webhook_dispatched", "trading", { status: result.status, sheets: body.sheets.length });
      return Response.json({ success: true, status: result.status });
    }

    // Model Context Protocol (MCP) Server Endpoint (JSON-RPC 2.0 & Discovery)
    if (path.endsWith("/mcp")) {
      const orm = this.getOrm();

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
            env: this.env,
            orm,
            sessionId,
            audit: (type, agent, payload) => this.audit(type, agent, payload),
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
    if (path.endsWith("/nlq") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { query?: string };
        const query = (body.query || "").trim();
        if (!query) {
          return Response.json({ error: "Query parameter is required" }, { status: 400 });
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const userDid = getUserDid(sessionId);
        const orm = this.getOrm();
        const plan = await planNLQ(this.env, query);
        const result = await executeNLQQueryAsync(orm, sessionId, plan, this.env, userLogin, userDid);
        this.audit("nlq.executed", "nlq", {
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

    // Schema Introspection & Database Tables via ORM
    if (path.endsWith("/schema/tables") && request.method === "GET") {
      try {
        const orm = this.getOrm();
        const tables = orm.listTables();
        return Response.json({ count: tables.length, tables });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to inspect database tables" }, { status: 500 });
      }
    }

    // Direct Table Query Execution via ORM
    if (path.endsWith("/schema/query") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          table?: string;
          search?: string;
          limit?: number;
          offset?: number;
        };
        const table = body.table || "mas_categories";
        const orm = this.getOrm();
        const data = orm.getTableData(table, {
          search: body.search,
          limit: body.limit,
          offset: body.offset,
        });
        return Response.json(data);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to query table data" }, { status: 500 });
      }
    }

    // Referral Categories ORM Management API
    if (path.endsWith("/categories")) {
      const orm = this.getOrm();

      if (request.method === "GET") {
        try {
          const categories = orm.categories.findMany({ orderBy: "sort_order ASC" });
          return Response.json({ count: categories.length, categories });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch categories" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as Partial<CategoryRecord> & { id?: string };
          const name = (body.name || "").trim();
          if (!name) {
            return Response.json({ error: "Category name is required" }, { status: 400 });
          }

          const now = new Date().toISOString();
          let category: CategoryRecord;

          if (body.id) {
            const existing = orm.categories.findById(body.id);
            if (!existing) {
              return Response.json({ error: "Category not found" }, { status: 404 });
            }
            const updated = orm.categories.update(body.id, {
              name: body.name || existing.name,
              slug: body.slug || (body.name ? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : existing.slug),
              description: body.description ?? existing.description,
              icon: body.icon || existing.icon,
              isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
              sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : existing.sortOrder,
              updatedAt: now,
            });
            category = updated || existing;
            this.audit("category.updated", "orchestrator", { id: category.id, name: category.name });
          } else {
            const slug = (body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 32);
            const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;
            category = orm.categories.create({
              id,
              name,
              slug,
              description: body.description || `Category for ${name} partner links`,
              icon: body.icon || "🏷️",
              isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
              sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : (orm.categories.count() || 0) + 1,
              createdAt: now,
              updatedAt: now,
            });
            this.audit("category.created", "orchestrator", { id, name });
          }

          return Response.json({ success: true, category });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to save category" }, { status: 500 });
        }
      }

      if (request.method === "DELETE") {
        try {
          const id = url.searchParams.get("id");
          if (!id) {
            return Response.json({ error: "Category id is required" }, { status: 400 });
          }
          orm.categories.delete(id);
          this.audit("category.deleted", "orchestrator", { id });
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to delete category" }, { status: 500 });
        }
      }
    }

    // Revenue Management Summary API
    if (path.endsWith("/revenue") && request.method === "GET") {
      try {
        const orm = this.getOrm();
        const summary = orm.getRevenueSummary();
        return Response.json(summary);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to calculate revenue" }, { status: 500 });
      }
    }

    // External Ad Network Placements & Monetization API
    if (path.endsWith("/external-ads")) {
      const orm = this.getOrm();

      if (request.method === "GET") {
        try {
          const ads = orm.externalAds.findMany({ orderBy: "earnings DESC" });
          return Response.json({ count: ads.length, ads });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch external ads" }, { status: 500 });
        }
      }

      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as Partial<ExternalAdRecord> & { id?: string };
          const title = (body.title || "").trim();
          const targetUrl = (body.targetUrl || "").trim();
          if (!title || !targetUrl) {
            return Response.json({ error: "Title and targetUrl are required" }, { status: 400 });
          }

          const now = new Date().toISOString();
          let ad: ExternalAdRecord;

          if (body.id) {
            const existing = orm.externalAds.findById(body.id);
            if (!existing) {
              return Response.json({ error: "Ad not found" }, { status: 404 });
            }
            const updated = orm.externalAds.update(body.id, {
              title: body.title || existing.title,
              name: body.name || existing.name,
              network: body.network || existing.network,
              placement: body.placement || existing.placement,
              tagline: body.tagline || existing.tagline,
              ctaText: body.ctaText || existing.ctaText,
              targetUrl: body.targetUrl || existing.targetUrl,
              cpmRate: body.cpmRate !== undefined ? Number(body.cpmRate) : existing.cpmRate,
              cpcRate: body.cpcRate !== undefined ? Number(body.cpcRate) : existing.cpcRate,
              isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
            });
            ad = updated || existing;
            this.audit("external_ad.updated", "orchestrator", { id: ad.id, title: ad.title });
          } else {
            const id = `ext_${body.network || "net"}_${crypto.randomUUID().slice(0, 6)}`;
            ad = orm.externalAds.create({
              id,
              name: body.name || title,
              network: body.network || "direct",
              placement: body.placement || "header_leaderboard",
              title,
              tagline: body.tagline || "",
              ctaText: body.ctaText || "Learn More →",
              targetUrl,
              bannerImageUrl: body.bannerImageUrl || "",
              cpmRate: Number(body.cpmRate) || 15.0,
              cpcRate: Number(body.cpcRate) || 1.25,
              impressions: 1,
              clicks: 0,
              earnings: (Number(body.cpmRate) || 15.0) / 1000,
              isActive: true,
              createdAt: now,
            });
            this.audit("external_ad.created", "orchestrator", { id, title });
          }

          return Response.json({ success: true, ad });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to save external ad" }, { status: 500 });
        }
      }
    }

    if (path.endsWith("/external-ads/impression") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        const id = body.id;
        if (id) {
          const orm = this.getOrm();
          const ad = orm.externalAds.findById(id);
          if (ad) {
            const newImpressions = ad.impressions + 1;
            const incremental = (ad.cpmRate || 15.0) / 1000;
            const newEarnings = Math.round((ad.earnings + incremental) * 1000) / 1000;
            orm.externalAds.update(id, {
              impressions: newImpressions,
              earnings: newEarnings,
            });
            return Response.json({ success: true, impressions: newImpressions, earnings: newEarnings });
          }
        }
        return Response.json({ success: false });
      } catch {
        return Response.json({ success: false });
      }
    }

    if (path.endsWith("/external-ads/click") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as { id?: string };
        const id = body.id;
        if (id) {
          const orm = this.getOrm();
          const ad = orm.externalAds.findById(id);
          if (ad) {
            const newClicks = ad.clicks + 1;
            const incremental = ad.cpcRate || 1.25;
            const newEarnings = Math.round((ad.earnings + incremental) * 100) / 100;
            orm.externalAds.update(id, {
              clicks: newClicks,
              earnings: newEarnings,
            });
            this.audit("external_ad.clicked", "orchestrator", { id, clicks: newClicks, earnings: newEarnings });
            return Response.json({ success: true, clicks: newClicks, earnings: newEarnings });
          }
        }
        return Response.json({ success: false });
      } catch {
        return Response.json({ success: false });
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

    // ==========================================
    // Multi-Gateway Payments & DID Management API
    // ==========================================

    // Gateway status & DID registry
    if ((path.endsWith("/payments/gateways") || path.endsWith("/payments/status")) && request.method === "GET") {
      const paymentService = new PaymentGatewayService(this.env);
      const gateways = paymentService.getGatewayStatuses();
      return Response.json({
        gateways,
        agentDids: AGENT_DIDS,
        userDid: getUserDid(sessionId),
      });
    }

    // W3C DID Document resolver for agents
    if (path.endsWith("/payments/dids") && request.method === "GET") {
      const didParam = url.searchParams.get("did");
      if (didParam) {
        return Response.json(resolveAgentDidDocument(didParam));
      }
      const didDocs = Object.values(AGENT_DIDS).map((did) => resolveAgentDidDocument(did));
      return Response.json({
        count: didDocs.length,
        documents: didDocs,
      });
    }

    // Transaction ledger with DID provenance
    if (path.endsWith("/payments/transactions")) {
      if (request.method === "GET") {
        try {
          const raw = Array.from(
            sql.exec(
              "SELECT id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at FROM mas_transactions ORDER BY created_at DESC LIMIT 50"
            )
          ) as any[];

          const transactions = raw.map((t) => ({
            id: String(t.id),
            sessionId: String(t.session_id),
            action: String(t.action),
            amount: Number(t.amount || 0),
            currency: String(t.currency || "USD"),
            customer: String(t.customer),
            gateway: String(t.gateway || "stripe"),
            gatewayRef: String(t.gateway_ref || ""),
            status: String(t.status),
            checkoutUrl: String(t.checkout_url || ""),
            proposerDid: String(t.proposer_did || AGENT_DIDS.PAYMENTS),
            authorizerDid: t.authorizer_did ? String(t.authorizer_did) : undefined,
            proofSignature: String(t.proof_signature || ""),
            note: String(t.note || ""),
            createdAt: String(t.created_at),
            updatedAt: String(t.updated_at),
          }));

          const totalVolume = transactions
            .filter((t) => t.status === "completed" || t.status === "authorized")
            .reduce((sum, t) => sum + (t.action === "charge" ? t.amount : -t.amount), 0);

          const pendingCount = transactions.filter((t) => t.status === "awaiting_confirmation").length;
          const completedCount = transactions.filter((t) => t.status === "completed" || t.status === "authorized").length;

          return Response.json({
            count: transactions.length,
            transactions,
            summary: {
              totalVolume: Math.max(0, totalVolume),
              completedCount,
              pendingCount,
              verifiedDidCount: transactions.length,
            },
          });
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
        }
      }
    }

    // Create payment checkout / draft
    if (path.endsWith("/payments/create") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          amount?: number;
          currency?: string;
          customer?: string;
          action?: "charge" | "refund" | "invoice";
          gateway?: SupportedGateway;
          description?: string;
        };

        const amount = Number(body.amount) || 10;
        const currency = (body.currency || "USD").toUpperCase();
        const customer = (body.customer || "Enterprise Client").trim();
        const action = body.action || "charge";
        const gateway = (body.gateway || "stripe") as SupportedGateway;
        const description = (body.description || `AI Compute Tokens for ${customer}`).trim();

        const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
        const userDid = getUserDid(sessionId);

        const paymentService = new PaymentGatewayService(this.env);
        const checkoutResult = await paymentService.createCheckout({
          draftId,
          amount,
          currency,
          customer,
          description,
          gateway,
          userLogin: sessionId,
        });

        if (!checkoutResult.success) {
          return Response.json({
            success: false,
            error: checkoutResult.message || `Failed to create checkout with ${gateway}`,
            code: "PAYMENT_GATEWAY_ERROR",
          }, { status: 400 });
        }

        const now = new Date().toISOString();
        const initialStatus = checkoutResult.checkoutUrl ? "pending_checkout" : "completed";
        sql.exec(
          "INSERT INTO mas_transactions (id, session_id, action, amount, currency, customer, gateway, gateway_ref, status, checkout_url, proposer_did, authorizer_did, proof_signature, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          draftId,
          sessionId,
          action,
          amount,
          currency,
          customer,
          gateway,
          checkoutResult.gatewayRef || "",
          initialStatus,
          checkoutResult.checkoutUrl,
          AGENT_DIDS.PAYMENTS,
          userDid,
          checkoutResult.didAttestation.signature,
          description,
          now,
          now
        );

        this.audit("payment.created", "payments", {
          draftId,
          amount,
          currency,
          customer,
          gateway,
          proposerDid: AGENT_DIDS.PAYMENTS,
          authorizerDid: userDid,
          proofSignature: checkoutResult.didAttestation.signature,
        });

        return Response.json({
          success: true,
          transaction: {
            id: draftId,
            sessionId,
            action,
            amount,
            currency,
            customer,
            gateway,
            gatewayRef: checkoutResult.gatewayRef,
            status: initialStatus,
            checkoutUrl: checkoutResult.checkoutUrl,
            proposerDid: AGENT_DIDS.PAYMENTS,
            authorizerDid: userDid,
            proofSignature: checkoutResult.didAttestation.signature,
            note: description,
            createdAt: now,
            updatedAt: now,
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create payment" }, { status: 500 });
      }
    }

    // Authorize & Execute a pending payment draft (HITL)
    if (path.endsWith("/payments/confirm") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          draftId?: string;
          decision?: "approved" | "rejected";
          note?: string;
        };

        const draftId = (body.draftId || "").trim();
        const decision = body.decision || "approved";
        const note = (body.note || "").trim();

        if (!draftId) {
          return Response.json({ error: "draftId is required" }, { status: 400 });
        }

        const userDid = getUserDid(sessionId);
        const now = new Date().toISOString();

        if (decision === "approved") {
          // Retrieve draft from mas_transactions
          const rows = Array.from(sql.exec("SELECT * FROM mas_transactions WHERE id = ?", draftId)) as any[];
          const tx = rows[0];
          const paymentService = new PaymentGatewayService(this.env);

          let checkoutUrl = tx?.checkout_url || "";
          let gatewayRef = tx?.gateway_ref || "";

          if (tx && (tx.action === "charge" || tx.action === "invoice") && !checkoutUrl) {
            const res = await paymentService.createCheckout({
              draftId,
              amount: Number(tx.amount),
              currency: String(tx.currency || "USD"),
              customer: String(tx.customer),
              gateway: tx.gateway as SupportedGateway,
              userLogin: sessionId,
              description: tx.note || "Authorized payment intent",
            });
            checkoutUrl = res.checkoutUrl;
            gatewayRef = res.gatewayRef;
          } else if (tx && tx.action === "refund") {
            const res = await paymentService.executeRefund({
              transactionId: draftId,
              amount: Number(tx.amount),
              gateway: tx.gateway as SupportedGateway,
              gatewayRef: tx.gateway_ref,
              userLogin: sessionId,
              reason: note,
            });
            gatewayRef = res.refundId;
          }

          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', gateway_ref = ?, checkout_url = ?, authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
            gatewayRef,
            checkoutUrl,
            userDid,
            note || "Confirmed by human authorizer",
            now,
            draftId
          );

          this.audit("payment.confirmed", "payments", {
            draftId,
            authorizerDid: userDid,
            executorDid: AGENT_DIDS.ORCHESTRATOR,
            gatewayRef,
            checkoutUrl,
          });

          return Response.json({
            success: true,
            status: "completed",
            draftId,
            checkoutUrl,
            gatewayRef,
            authorizerDid: userDid,
          });
        } else {
          sql.exec(
            "UPDATE mas_transactions SET status = 'rejected', authorizer_did = ?, note = ?, updated_at = ? WHERE id = ?",
            userDid,
            note || "Rejected by reviewer",
            now,
            draftId
          );

          this.audit("payment.rejected", "payments", { draftId, authorizerDid: userDid });
          return Response.json({ success: true, status: "rejected", draftId });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to confirm payment draft" }, { status: 500 });
      }
    }

    // Real payment capture endpoint (PayPal & Stripe)
    if (path.endsWith("/payments/capture") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          orderId?: string;
          gateway?: SupportedGateway;
        };
        const orderId = (body.orderId || "").trim();
        const gateway = (body.gateway || "paypal") as SupportedGateway;
        if (!orderId) {
          return Response.json({ error: "orderId is required" }, { status: 400 });
        }
        const paymentService = new PaymentGatewayService(this.env);
        const result = await paymentService.capturePayment({
          gateway,
          orderId,
          userLogin: sessionId,
        });

        if (result.success) {
          const now = new Date().toISOString();
          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ? OR gateway_ref = ?",
            now,
            orderId,
            orderId
          );
          this.audit("payment.captured", "payments", { orderId, gateway, captureId: result.captureId });
        }

        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to capture payment" }, { status: 500 });
      }
    }

    // Unified Payment Webhook listener (Stripe, PayPal, Lemon Squeezy with HMAC Verification)
    if (path.endsWith("/payments/webhook") && request.method === "POST") {
      try {
        const provider = (url.searchParams.get("provider") || "stripe") as SupportedGateway;
        const rawBody = await request.text();
        const paymentService = new PaymentGatewayService(this.env);

        // Verify cryptographic webhook signature
        const verification = await paymentService.verifyWebhookSignature(provider, rawBody, request.headers);
        if (!verification.isValid) {
          return Response.json({ error: verification.reason || "Invalid webhook signature" }, { status: 401 });
        }

        let body: any = {};
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = {};
        }

        const now = new Date().toISOString();

        // Extract reference ID from Stripe / PayPal / Lemon Squeezy payload
        const draftId = body?.data?.object?.client_reference_id ||
          body?.resource?.purchase_units?.[0]?.reference_id ||
          body?.data?.attributes?.checkout_data?.custom?.draftId ||
          body?.draftId;

        if (draftId) {
          sql.exec(
            "UPDATE mas_transactions SET status = 'completed', updated_at = ? WHERE id = ?",
            now,
            draftId
          );
          this.audit("payment.settled_webhook", "payments", { draftId, provider, raw: body?.type || body?.event_type });
        }

        return Response.json({ received: true });
      } catch {
        return Response.json({ received: false }, { status: 400 });
      }
    }

    // ==========================================
    // Cloudflare Agentic Payments (x402 & MPP)
    // ==========================================

    // Agentic Wallet Status & Micropayment Metrics
    if ((path.endsWith("/payments/agentic/wallet") || path.includes("/payments/agentic/wallet")) && request.method === "GET") {
      try {
        const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
        const status = await paymentService.getWalletStatus();
        return Response.json(status);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch wallet status" }, { status: 500 });
      }
    }

    // Agentic Auto-Approve Limit (HITL threshold)
    if (path.endsWith("/payments/agentic/auto-approve-limit") || path.includes("/payments/agentic/auto-approve-limit")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      if (request.method === "GET") {
        return Response.json({
          autoApproveLimitUSD: paymentService.getAutoApproveLimit(),
          network: this.env.X402_NETWORK || "base-sepolia",
        });
      }
      if (request.method === "POST") {
        try {
          const body = (await request.json().catch(() => ({}))) as any;
          const limit = Number(body.limitUSD !== undefined ? body.limitUSD : body.limit);
          if (isNaN(limit) || limit < 0) {
            return Response.json({ error: "Invalid limitUSD. Must be non-negative number." }, { status: 400 });
          }
          paymentService.setAutoApproveLimit(limit);
          this.audit("agentic_payment.limit_updated", "payments", { limitUSD: limit });
          return Response.json({ success: true, autoApproveLimitUSD: limit });
        } catch (err: any) {
          return Response.json({ error: err.message || "Failed to update limit" }, { status: 500 });
        }
      }
    }

    // Paid Trading Service: Institutional Options & Greeks Screener ($0.05 USDC)
    if (path.includes("/premium/options-scan") && (request.method === "GET" || request.method === "POST")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      const tier = TRADING_PAID_SERVICES.OPTIONS_SCREENER;

      return paymentService.handleGatedEndpoint(
        request,
        tier.resource,
        tier.priceUSD,
        tier.description,
        async (receipt) => {
          let filter: any = {};
          if (request.method === "POST") {
            filter = (await request.json().catch(() => ({}))) as any;
          } else {
            filter = {
              underlyingSymbols: url.searchParams.get("symbol") ? [url.searchParams.get("symbol")!.toUpperCase().trim()] : undefined,
              maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
              contractType: url.searchParams.get("contractType") || "BOTH",
              minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
              maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
              minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
              minOpenInterest: url.searchParams.get("minOpenInterest") ? Number(url.searchParams.get("minOpenInterest")) : undefined,
              maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
              maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
              minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
              maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
              limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
            };
          }
          const userLogin = request.headers.get("x-user-login") || sessionId || "premium_subscriber";
          const rawEnvHdr = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
          const reqEnvLocal = (rawEnvHdr === "TEST" || rawEnvHdr === "PROD") ? rawEnvHdr : undefined;
          const etrade = new ETradeService(this.getOrm(), this.env, userLogin, reqEnvLocal);
          const screener = new DynamicOptionsScreener(etrade.client);
          const result = await screener.screenOptions(filter);
          return {
            success: true,
            service: tier.name,
            receipt,
            screenResult: result,
          };
        }
      );
    }

    // Paid Trading Service: Autonomous Equity Research Report ($0.10 USDC)
    if (path.includes("/premium/market-research") && (request.method === "GET" || request.method === "POST")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      const tier = TRADING_PAID_SERVICES.MARKET_RESEARCH;

      return paymentService.handleGatedEndpoint(
        request,
        tier.resource,
        tier.priceUSD,
        tier.description,
        async (receipt) => {
          let symbol = "NVDA";
          if (request.method === "POST") {
            const body = (await request.json().catch(() => ({}))) as any;
            if (body.symbol) symbol = String(body.symbol).toUpperCase().trim();
          } else {
            const sym = url.searchParams.get("symbol");
            if (sym) symbol = sym.toUpperCase().trim();
          }

          const foss = new FossResearchService(this.env);
          const report = await foss.generateResearchReport(symbol);
          return {
            success: true,
            service: tier.name,
            receipt,
            report,
          };
        }
      );
    }

    // Paid Trading Service: Real-Time Quantitative Anomaly Signals ($0.02 USDC)
    if (path.includes("/premium/stock-signals") && (request.method === "GET" || request.method === "POST")) {
      const paymentService = new ETradeAgenticPaymentService(this.getOrm(), this.env, sessionId);
      const tier = TRADING_PAID_SERVICES.STOCK_SIGNALS;

      return paymentService.handleGatedEndpoint(
        request,
        tier.resource,
        tier.priceUSD,
        tier.description,
        async (receipt) => {
          let symbols = ["NVDA", "AAPL", "MSFT", "TSLA"];
          if (request.method === "POST") {
            const body = (await request.json().catch(() => ({}))) as any;
            if (Array.isArray(body.symbols) && body.symbols.length > 0) symbols = body.symbols;
          } else {
            const sym = url.searchParams.get("symbols") || url.searchParams.get("symbol");
            if (sym) symbols = sym.split(",").map(s => s.trim().toUpperCase());
          }

          const screener = new YFinanceMarketScreener();
          const screen = await screener.screenMarkets({ search: symbols.join(",") });
          const signals = screen.stocks.map(stock => ({
            symbol: stock.symbol,
            price: stock.price,
            changePercent: stock.changePercent,
            rsi: stock.rsi,
            volume: stock.volume,
            signalType: (stock.rsi && stock.rsi < 35) ? "OVERSOLD_BOUNCE" : (stock.rsi && stock.rsi > 70) ? "OVERBOUGHT_MOMENTUM" : "TREND_CONTINUATION",
            confidence: 0.88,
            timestamp: new Date().toISOString(),
          }));

          return {
            success: true,
            service: tier.name,
            receipt,
            count: signals.length,
            signals,
          };
        }
      );
    }

    // ==========================================
    // Environment & E*TRADE Trading APIs
    // ==========================================

    const rawEnvHeader = (request.headers.get("x-environment") || url.searchParams.get("env") || "").toUpperCase().trim();
    const requestedEnv: "TEST" | "PROD" | undefined = (rawEnvHeader === "TEST" || rawEnvHeader === "PROD") ? rawEnvHeader : undefined;

    // Environment Switcher API (allows client to toggle between Sandbox TEST and Live PROD)
    if (path.endsWith("/environment/switch") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const requested = String(body.environment || "PROD").toUpperCase().trim();
        if (requested === "TEST" || requested === "PROD") {
          return Response.json({ success: true, environment: requested });
        }
        return Response.json({ error: "Invalid environment. Expected TEST or PROD." }, { status: 400 });
      } catch (err) {
        return Response.json({ error: "Failed to switch environment" }, { status: 500 });
      }
    }

    // Broker status & account metadata
    if (path.endsWith("/etrade/status") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const status = await etrade.getStatusAsync();
        return Response.json(status);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch broker status" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API Diagnostics
    if (path.endsWith("/etrade/diagnostics") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const envConfig = resolveEnvironmentConfig(this.env, requestedEnv);
        const valid = await getValidTokens(this.env, userLogin, requestedEnv);
        const client = new ETradeRestClient(this.env, userLogin, requestedEnv);

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
          userLogin,
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
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to run diagnostics" }, { status: 500 });
      }
    }

    // Broker Accounts List (Real E*TRADE REST / OAuth 1.0a)
    if (path.endsWith("/etrade/accounts") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const accounts = await etrade.fetchAccountsRemote();
        return Response.json({ count: accounts.length, accounts });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch accounts" }, { status: 500 });
      }
    }

    // Market Screener & Scanning
    if (path.endsWith("/etrade/screen") && (request.method === "POST" || request.method === "GET")) {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
        if (request.method === "GET") {
          if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
          if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
          if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
          if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
          if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
        }
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const results = await etrade.screenMarketsAsync(filters);
        this.audit("etrade.screened", "trading", { filterSummary: results.filterSummary, count: results.stocks.length });
        return Response.json({
          ...results,
          results: results.stocks,
          stocks: results.stocks,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to screen equities" }, { status: 500 });
      }
    }

    // Real-time equity quote (Real E*TRADE REST / OAuth 1.0a)
    if (path.endsWith("/etrade/quote") && request.method === "GET") {
      try {
        const rawSym = url.searchParams.get("symbol") || "NVDA";
        const symbol = rawSym.toUpperCase().trim() || "NVDA";
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const quote = await etrade.fetchQuoteRemote(symbol);
        return Response.json(quote, {
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
          },
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch quote" }, { status: 500 });
      }
    }

    // Order Proposal & Preview with DID Attestation (HITL)
    if (path.endsWith("/etrade/order/preview") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = (body.symbol || "").trim().toUpperCase();
        const quantity = Number(body.quantity) || 1;
        const rawAction = String(body.orderAction || body.action || "BUY").toUpperCase().trim();
        const validActions = ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"];
        const orderAction = (validActions.includes(rawAction) ? rawAction : "BUY") as "BUY" | "SELL" | "BUY_TO_COVER" | "SELL_SHORT";
        const orderType = body.orderType || "MARKET";
        const limitPrice = body.limitPrice !== undefined ? Number(body.limitPrice) : undefined;
        const stopPrice = body.stopPrice !== undefined ? Number(body.stopPrice) : undefined;

        if (!symbol) {
          return Response.json({ error: "Stock symbol is required" }, { status: 400 });
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const preview = await etrade.previewOrderRemote({
          sessionId,
          symbol,
          orderAction,
          quantity,
          orderType,
          limitPrice,
          stopPrice,
        });

        this.audit("etrade.order_previewed", "trading", {
          orderId: preview.orderId,
          symbol: preview.symbol,
          orderAction: preview.orderAction,
          quantity: preview.quantity,
          estimatedTotal: preview.estimatedTotal,
          proposerDid: preview.proposerDid,
        });

        // Schedule a 15-minute expiration timer (900 seconds) for this draft
        try {
          if (typeof (this as any).schedule === "function") {
            const expSchedule = await (this as any).schedule(900, "expireStaleOrderDraft", { orderId: preview.orderId, userLogin });
            if (expSchedule?.id) {
              preview.expirationScheduleId = expSchedule.id;
              preview.expiresAt = new Date(Date.now() + 900 * 1000).toISOString();
              this.getOrm().trades?.update(preview.orderId, {
                expirationScheduleId: expSchedule.id,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        } catch (schedErr) {
          console.warn("[OrchestratorAgent] Note: could not schedule expiration timer:", schedErr);
        }

        return Response.json(preview);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to preview trade order" }, { status: 500 });
      }
    }

    // Authorize & Execute Confirmed Order Draft (HITL Execution via OAuth 1.0a)
    if (path.endsWith("/etrade/order/execute") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const orderId = (body.orderId || body.draftId || "").trim();
        const decision = body.decision;

        if (!orderId) {
          return Response.json({ error: "orderId is required" }, { status: 400 });
        }

        if (decision !== "approved" && decision !== "rejected") {
          return Response.json({ error: "decision must be either 'approved' or 'rejected'" }, { status: 400 });
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const userDid = getUserDid(sessionId);

        // Strict HITL Gate: block autonomous agents
        if (userDid.startsWith("did:agent:")) {
          return Response.json({ error: "HITL Enforcement: Autonomous trade execution is strictly prohibited. Orders require verified human authorization." }, { status: 403 });
        }

        const existingRecord = this.getOrm().trades?.findById(orderId);
        if (!existingRecord) {
          return Response.json({ error: `Order draft '${orderId}' not found. All orders must be previewed and drafted prior to execution.` }, { status: 404 });
        }

        if (existingRecord.status !== "previewed") {
          return Response.json({ error: `Order draft '${orderId}' cannot be executed. Current status is '${existingRecord.status}'. Only 'previewed' drafts may be executed.` }, { status: 400 });
        }

        // Handle user rejection / cancellation immediately
        if (decision === "rejected") {
          if (existingRecord.expirationScheduleId && typeof (this as any).cancelSchedule === "function") {
            try {
              await (this as any).cancelSchedule(existingRecord.expirationScheduleId);
            } catch {
              // Ignore cancel error if already triggered
            }
          }
          if (this.getOrm().trades) {
            this.getOrm().trades.update(orderId, {
              status: "rejected",
              authorizerDid: userDid,
              updatedAt: new Date().toISOString(),
            });
          }
          return Response.json({
            success: true,
            orderId,
            status: "rejected",
            message: `Order draft '${orderId}' cancelled by user. No broker order submitted.`,
          });
        }

        // Strict Immutability Verification: Ensure submitted parameters strictly match the previewed draft
        const reqAction = (body.action || body.orderAction || "").toUpperCase().trim();
        if (reqAction && reqAction !== existingRecord.action.toUpperCase()) {
          return Response.json({
            error: `Order Action Mismatch: Previewed action is '${existingRecord.action}', but execution request specifies '${reqAction}'. Submission rejected. A fresh preview is required.`,
          }, { status: 422 });
        }

        const reqSymbol = (body.symbol || "").toUpperCase().trim();
        if (reqSymbol && reqSymbol !== existingRecord.symbol.toUpperCase()) {
          return Response.json({
            error: `Order Symbol Mismatch: Previewed symbol is '${existingRecord.symbol}', but execution request specifies '${reqSymbol}'. Submission rejected.`,
          }, { status: 422 });
        }

        if (body.quantity !== undefined && Number(body.quantity) !== Number(existingRecord.quantity)) {
          return Response.json({
            error: `Order Quantity Mismatch: Previewed quantity is ${existingRecord.quantity}, but execution request specifies ${body.quantity}. Submission rejected.`,
          }, { status: 422 });
        }

        const symbol = existingRecord.symbol.toUpperCase();
        const action = existingRecord.action as any;
        const quantity = Number(existingRecord.quantity);
        const orderType = existingRecord.orderType || "MARKET";
        const limitPrice = existingRecord.orderType === "LIMIT" ? existingRecord.price : undefined;

        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        let result: any;

        if (this.env.ETRADE_CONSUMER_KEY || this.env.ETRADE_MCP_SERVER_URL || this.env.ET_API_KEY) {
          result = await etrade.placeOrderRemote({
            orderId,
            symbol,
            action,
            quantity,
            orderType,
            limitPrice,
            previewId: body.previewId && String(body.previewId).trim() !== ""
              ? String(body.previewId).trim()
              : existingRecord?.orderRef && String(existingRecord.orderRef).trim() !== ""
              ? String(existingRecord.orderRef).trim()
              : undefined,
            userLogin,
          });
          if (result.success && this.getOrm().trades) {
            this.getOrm().trades.update(orderId, {
              status: "executed",
              orderRef: result.executionId,
              authorizerDid: userDid,
              updatedAt: new Date().toISOString(),
            });
          }
        } else {
          result = etrade.executeOrder(orderId, userDid, decision);
        }

        // Cancel the scheduled expiration timer since the order has been executed
        if (existingRecord.expirationScheduleId && typeof (this as any).cancelSchedule === "function") {
          try {
            await (this as any).cancelSchedule(existingRecord.expirationScheduleId);
          } catch {
            // Ignore cancel error if already triggered
          }
        }

        this.audit("etrade.order_executed", "trading", {
          orderId,
          decision,
          authorizerDid: userDid,
          status: result.status,
          executionId: result.executionId,
        });

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to execute trade order" }, { status: 500 });
      }
    }

    // Positions & Account Holdings (Real E*TRADE OAuth 1.0a)
    if (path.endsWith("/etrade/positions") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const holdings = await etrade.fetchPortfolioRemote(undefined, true);
        const lastError = etrade.getLastError();
        return Response.json({
          ...holdings,
          error: lastError && holdings.account.accountId === "unconnected" ? lastError : undefined,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch positions" }, { status: 500 });
      }
    }

    // Order History & Trade Audit Ledger
    if (path.endsWith("/etrade/orders") && request.method === "GET") {
      try {
        const orm = this.getOrm();
        const trades = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
        return Response.json({ count: trades.length, trades });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch order history" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Remote Orders on Exchange
    if (path.endsWith("/etrade/orders/remote") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const status = url.searchParams.get("status") || undefined;
        const marker = url.searchParams.get("marker") || undefined;
        const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
        const symbol = url.searchParams.get("symbol") || undefined;
        const orders = await etrade.fetchOrdersRemote(undefined, { status, marker, count, symbol });
        return Response.json({ count: orders.length, orders });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch exchange orders" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Cancel Order on Exchange
    if (path.endsWith("/etrade/orders/cancel") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const orderId = body.orderId;
        if (!orderId) {
          return Response.json({ error: "orderId is required" }, { status: 400 });
        }
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const result = await etrade.cancelOrderRemote(orderId);
        this.audit("etrade.order_cancelled", "trading", { orderId, success: result.success });
        return Response.json(result, { status: result.success ? 200 : 400 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to cancel order" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Inbound Email Trading Agent
    if (path.endsWith("/trading/email/inbound") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "email_trader";
        const emailService = new ETradeEmailTradingService(this.env, this.getOrm(), userLogin);
        const result = await emailService.processInboundEmail(body);
        this.audit("trading.email_processed", "trading", { actionType: result.actionType, from: result.from, orderId: result.orderId });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process inbound email" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Slack Event Handler
    if (path.endsWith("/trading/slack/event") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "slack_trader";
        const slackService = new ETradeSlackTradingService(this.env, this.getOrm(), userLogin);
        const result = await slackService.processSlackEvent(body);
        this.audit("trading.slack_event", "trading", { actionType: result.actionType, handled: result.handled });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack event" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Slack Interactive Component Actions (Button Approvals)
    if (path.endsWith("/trading/slack/interaction") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "slack_trader";
        const slackService = new ETradeSlackTradingService(this.env, this.getOrm(), userLogin);
        const result = await slackService.processSlackInteraction(body);
        this.audit("trading.slack_interaction", "trading", { actionId: result.actionId, orderId: result.orderId, status: result.status });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process slack interaction" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Voice Trading Turn
    if (path.endsWith("/trading/voice/turn") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const userLogin = request.headers.get("x-user-login") || sessionId || "voice_trader";
        const voiceService = new ETradeVoiceTradingService(this.env, this.getOrm(), userLogin);
        const result = await voiceService.processVoiceTurn({
          ...body,
          sessionId: userLogin,
          userLogin,
        });
        this.audit("trading.voice_turn", "trading", { actionType: result.actionType, orderId: result.orderId, success: result.success });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to process voice turn" }, { status: 500 });
      }
    }

    // Omnichannel Trading Channel: Voice Trading Welcome Greeting
    if (path.endsWith("/trading/voice/greeting") && request.method === "GET") {
      const userLogin = request.headers.get("x-user-login") || sessionId || "voice_trader";
      const voiceService = new ETradeVoiceTradingService(this.env, this.getOrm(), userLogin);
      return Response.json(voiceService.getWelcomeGreeting());
    }

    // Real E*TRADE REST API: Account Transactions
    if (path.endsWith("/etrade/transactions") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const startDate = url.searchParams.get("startDate") || undefined;
        const endDate = url.searchParams.get("endDate") || undefined;
        const sortOrder = (url.searchParams.get("sortOrder") as "ASC" | "DESC") || undefined;
        const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
        const transactions = await etrade.fetchTransactions(undefined, { startDate, endDate, sortOrder, count });
        return Response.json({ count: transactions.length, transactions });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transactions" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Transaction Details
    if (path.includes("/etrade/transactions/") && request.method === "GET") {
      try {
        const transactionId = path.split("/etrade/transactions/")[1].split("/")[0].split("?")[0];
        const storeId = url.searchParams.get("storeId") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const details = await etrade.fetchTransactionDetails(transactionId, undefined, storeId);
        if (!details) {
          return Response.json({ error: "Transaction not found" }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch transaction details" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: User Alerts Inbox
    if (path.endsWith("/etrade/alerts") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const category = url.searchParams.get("category") || undefined;
        const status = (url.searchParams.get("status") as "READ" | "UNREAD" | "DELETED") || undefined;
        const count = url.searchParams.get("count") ? Number(url.searchParams.get("count")) : undefined;
        const alerts = await etrade.fetchAlerts({ category, status, count });
        return Response.json({ count: alerts.length, alerts });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alerts" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Alert Details & Delete
    if (path.includes("/etrade/alerts/") && request.method === "GET") {
      try {
        const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const details = await etrade.fetchAlertDetails(alertId);
        if (!details) {
          return Response.json({ error: "Alert not found" }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch alert details" }, { status: 500 });
      }
    }

    if (path.includes("/etrade/alerts/") && request.method === "DELETE") {
      try {
        const alertId = path.split("/etrade/alerts/")[1].split("/")[0].split("?")[0];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const result = await etrade.deleteAlert(alertId);
        return Response.json(result, { status: result.success ? 200 : 400 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete alert" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Product Lookup
    if (path.endsWith("/etrade/lookup") && request.method === "GET") {
      try {
        const search = url.searchParams.get("search") || url.searchParams.get("q") || "";
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const items = await etrade.lookupProduct(search);
        return Response.json({ count: items.length, items });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to lookup products" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Option Chains
    if (path.endsWith("/etrade/options/chains") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryYear = url.searchParams.get("expiryYear") ? Number(url.searchParams.get("expiryYear")) : undefined;
        const expiryMonth = url.searchParams.get("expiryMonth") ? Number(url.searchParams.get("expiryMonth")) : undefined;
        const expiryDay = url.searchParams.get("expiryDay") ? Number(url.searchParams.get("expiryDay")) : undefined;
        const strikePrice = url.searchParams.get("strikePrice") ? Number(url.searchParams.get("strikePrice")) : undefined;
        const noOfStrikes = url.searchParams.get("noOfStrikes") ? Number(url.searchParams.get("noOfStrikes")) : undefined;
        const chainType = (url.searchParams.get("chainType") as "CALL" | "PUT" | "CALLPUT") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const chain = await etrade.getOptionChains({
          symbol,
          expiryYear,
          expiryMonth,
          expiryDay,
          strikePrice,
          noOfStrikes,
          chainType,
        });
        return Response.json(chain || { symbol, underlyingPrice: 0, pairs: [] });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option chains" }, { status: 500 });
      }
    }

    // Real E*TRADE REST API: Option Expire Dates
    if (path.endsWith("/etrade/options/expire-dates") && request.method === "GET") {
      try {
        const symbol = (url.searchParams.get("symbol") || "NVDA").toUpperCase().trim();
        const expiryType = url.searchParams.get("expiryType") || undefined;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const dates = await etrade.getOptionExpireDates(symbol, expiryType);
        return Response.json({ count: dates.length, dates });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch option expire dates" }, { status: 500 });
      }
    }

    // ==========================================
    // Dynamic Options Screener Engine Endpoint
    // ==========================================
    if ((path.endsWith("/trading/options/compare") || path.endsWith("/trading/options/llm-ideas")) && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError || "Invalid strategy request." }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }

      try {
        const strategyRequest = body as StrategyRequest;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const result = await pipeline.run(strategyRequest, {
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
        });
        const common = {
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
        };

        if (path.endsWith("/trading/options/compare")) {
          const candidates = result.ranked.slice(0, 20);
          try {
            const llm = await rankCandidatesWithLlm(
              this.env,
              strategyRequest,
              body.riskProfile || "balanced",
              result.snapshot.contracts,
              candidates.map((ranked) => ranked.candidate),
            );
            return Response.json({
              mode: "same_candidate_ranking",
              quant: {
                ranked: candidates,
                scoreWeights: result.strategies.scoreWeights,
                candidateCount: candidates.length,
              },
              llm: { status: "complete", ...llm },
              ...common,
            });
          } catch (err) {
            return Response.json({
              mode: "same_candidate_ranking",
              quant: {
                ranked: candidates,
                scoreWeights: result.strategies.scoreWeights,
                candidateCount: candidates.length,
              },
              llm: {
                status: "error",
                model: this.env.AI_MODEL || DEFAULT_AI_MODEL,
                error: err instanceof Error ? err.message : "LLM ranking failed.",
              },
              ...common,
            });
          }
        }

        const bestByStrategy = new Map<string, typeof result.strategies.candidates[number]>();
        for (const candidate of result.strategies.candidates) {
          const current = bestByStrategy.get(candidate.type);
          if (!current || candidate.score > current.score) bestByStrategy.set(candidate.type, candidate);
        }
        const ideaPool = [...bestByStrategy.values()]
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .slice(0, 50);
        try {
          const llm = await generateLlmCandidateIdeas(
            this.env,
            strategyRequest,
            body.riskProfile || "balanced",
            result.snapshot.contracts,
            ideaPool,
          );
          const byId = new Map(ideaPool.map((candidate) => [candidate.id, candidate]));
          return Response.json({
            mode: "validated_candidate_ideas",
            llm: {
              status: "complete",
              model: llm.model,
              ideas: llm.ranked.map((judgment) => ({
                ...judgment,
                candidate: byId.get(judgment.candidateId),
              })),
            },
            quantCandidatePoolCount: result.strategies.candidates.length,
            ideaPoolCount: ideaPool.length,
            ...common,
          });
        } catch (err) {
          return Response.json({
            mode: "validated_candidate_ideas",
            llm: {
              status: "error",
              model: this.env.AI_MODEL || DEFAULT_AI_MODEL,
              error: err instanceof Error ? err.message : "LLM idea generation failed.",
            },
            quantCandidatePoolCount: result.strategies.candidates.length,
            ideaPoolCount: ideaPool.length,
            ...common,
          });
        }
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options candidate generation failed." }, { status: 500 });
      }
    }

    if (path.endsWith("/trading/options/recommend") && request.method === "POST") {
      const body = await request.json().catch(() => null) as Partial<StrategyRequest> | null;
      const validationError = validateStrategyRequest(body);
      if (validationError) {
        return Response.json({ error: validationError }, { status: 400 });
      }

      try {
        const strategyRequest = body as StrategyRequest;
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const screener = new DynamicOptionsScreener(etrade.client);
        const screened = await screener.screenOptions({
          underlyingSymbols: [strategyRequest.symbol.toUpperCase().trim()],
          contractType: "BOTH",
          minDte: strategyRequest.minDte,
          maxDte: strategyRequest.maxDte,
          minVolume: strategyRequest.minVolume,
          minOpenInterest: strategyRequest.minOpenInterest,
          maxSpreadPct: strategyRequest.maxSpreadPct,
          maxQuoteAgeSeconds: strategyRequest.maxQuoteAgeSeconds,
          limit: strategyRequest.contractLimit,
        });
        const recommendations = recommendOptionStrategies(screened.contracts, strategyRequest, strategyRequest.candidateLimit);
        return Response.json({
          ...recommendations,
          contracts: screened.contracts,
          screen: {
            scannedAt: screened.scannedAt,
            underlyingsScanned: screened.totalUnderlyingsScanned,
            contractsEvaluated: screened.totalContractsEvaluated,
            contractsMatched: screened.matchedCount,
            quoteQuality: screened.quoteQuality,
          },
          contractRejections: (screened.rejections || []).slice(0, 50),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options recommendation failed" }, { status: 400 });
      }
    }

    // Strategy screener (capability 2) and best-trade picker (capability 3) over the options data agent (capability 1)
    if ((path.endsWith("/trading/options/strategies") || path.endsWith("/trading/options/best-trade")) && request.method === "POST") {
      const body = await request.json().catch(() => null) as (Partial<StrategyRequest> & {
        strategyFilter?: StrategyScreenFilter;
        riskProfile?: RiskProfile;
        alternatives?: number;
      }) | null;
      const validationError = validateStrategyRequest(body);
      if (validationError || !body) {
        return Response.json({ error: validationError }, { status: 400 });
      }
      if (body.riskProfile !== undefined && !["conservative", "balanced", "aggressive"].includes(body.riskProfile)) {
        return Response.json({ error: "riskProfile must be conservative, balanced, or aggressive." }, { status: 400 });
      }
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const pipeline = new OptionsAgentPipeline(new DynamicOptionsScreener(etrade.client));
        const result = await pipeline.run(body as StrategyRequest, {
          strategyFilter: body.strategyFilter,
          riskProfile: body.riskProfile,
          alternatives: body.alternatives,
        });
        const common = {
          screen: result.snapshot.screen,
          contracts: result.snapshot.contracts,
          contractRejections: result.snapshot.rejections,
        };
        if (path.endsWith("/best-trade")) {
          return Response.json({ bestTrade: result.bestTrade, evaluations: result.strategies.evaluations, nameLedger: result.strategies.nameLedger, ...common });
        }
        return Response.json({
          status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
          ranked: result.ranked,
          riskReports: result.riskReports,
          screenedOut: result.screenedOut.slice(0, 50),
          excluded: result.strategies.excluded,
          ...common,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options strategy pipeline failed" }, { status: 400 });
      }
    }

    if (path.endsWith("/trading/options/screen") && (request.method === "POST" || request.method === "GET")) {
      try {
        let filter: any = {};
        if (request.method === "POST") {
          filter = (await request.json().catch(() => ({}))) as any;
        } else {
          // Parse GET query params
          filter = {
            sector: url.searchParams.get("sector") || undefined,
            contractType: url.searchParams.get("contractType") || undefined,
            minDelta: url.searchParams.get("minDelta") ? Number(url.searchParams.get("minDelta")) : undefined,
            maxDelta: url.searchParams.get("maxDelta") ? Number(url.searchParams.get("maxDelta")) : undefined,
            minGamma: url.searchParams.get("minGamma") ? Number(url.searchParams.get("minGamma")) : undefined,
            maxGamma: url.searchParams.get("maxGamma") ? Number(url.searchParams.get("maxGamma")) : undefined,
            minTheta: url.searchParams.get("minTheta") ? Number(url.searchParams.get("minTheta")) : undefined,
            maxTheta: url.searchParams.get("maxTheta") ? Number(url.searchParams.get("maxTheta")) : undefined,
            minImpliedVolatility: url.searchParams.get("minIv") ? Number(url.searchParams.get("minIv")) : undefined,
            maxImpliedVolatility: url.searchParams.get("maxIv") ? Number(url.searchParams.get("maxIv")) : undefined,
            minVolume: url.searchParams.get("minVolume") ? Number(url.searchParams.get("minVolume")) : undefined,
            minOpenInterest: url.searchParams.get("minOi") ? Number(url.searchParams.get("minOi")) : undefined,
            maxSpreadPct: url.searchParams.get("maxSpreadPct") ? Number(url.searchParams.get("maxSpreadPct")) : undefined,
            maxQuoteAgeSeconds: url.searchParams.get("maxQuoteAgeSeconds") ? Number(url.searchParams.get("maxQuoteAgeSeconds")) : undefined,
            minDte: url.searchParams.get("minDte") ? Number(url.searchParams.get("minDte")) : undefined,
            maxDte: url.searchParams.get("maxDte") ? Number(url.searchParams.get("maxDte")) : undefined,
            moneyness: url.searchParams.get("moneyness") || undefined,
            underlyingSymbols: url.searchParams.get("symbols") ? url.searchParams.get("symbols")!.split(",").map((s) => s.trim()) : undefined,
            maxUnderlyings: url.searchParams.get("maxUnderlyings") ? Number(url.searchParams.get("maxUnderlyings")) : undefined,
            limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
          };
        }

        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const screener = new DynamicOptionsScreener(etrade.client);
        const result = await screener.screenOptions(filter);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Options screening failed" }, { status: 500 });
      }
    }

    // ==========================================
    // E*TRADE Watchlist Endpoints & Persistence
    // ==========================================

    // List Watchlists (E*TRADE REST + Durable SQLite)
    if (path.endsWith("/etrade/watchlists") && request.method === "GET") {
      try {
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const watchlists = await etrade.getWatchlists();
        return Response.json({ count: watchlists.length, watchlists });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to retrieve watchlists" }, { status: 500 });
      }
    }

    // Get Watchlist Details
    if (path.endsWith("/etrade/watchlist/details") && request.method === "GET") {
      try {
        const id = url.searchParams.get("id") || url.searchParams.get("name") || "";
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const details = await etrade.getWatchlistDetails(id);
        if (!details) {
          return Response.json({ error: `Watchlist '${id}' not found` }, { status: 404 });
        }
        return Response.json(details);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to get watchlist details" }, { status: 500 });
      }
    }

    // Create Watchlist
    if (path.endsWith("/etrade/watchlist/create") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const name = (body.name || "Default Watchlist").trim();
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const res = await etrade.createWatchlist({ name, symbols });
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to create watchlist" }, { status: 500 });
      }
    }

    // Save Screen Results directly as Watchlist
    if (path.endsWith("/etrade/watchlist/save-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const name = (body.name || "Screener Results").trim();
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];
        const items = body.items || [];
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const res = await etrade.saveScanAsWatchlist(name, symbols, items);
        return Response.json(res);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to save screen as watchlist" }, { status: 500 });
      }
    }

    // Delete Watchlist
    if (path.endsWith("/etrade/watchlist/delete") && (request.method === "DELETE" || request.method === "POST")) {
      try {
        const id = url.searchParams.get("id") || (await request.json().catch(() => ({})) as any)?.id;
        if (!id) return Response.json({ error: "Missing watchlist id" }, { status: 400 });
        const userLogin = request.headers.get("x-user-login") || sessionId || "default_trader";
        const etrade = new ETradeService(this.getOrm(), this.env, userLogin, requestedEnv);
        const deleted = await etrade.deleteWatchlist(id);
        return Response.json({ success: deleted, deletedId: id });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to delete watchlist" }, { status: 500 });
      }
    }

    // ==========================================
    // Alpaca Trading API v2 Endpoints
    // ==========================================

    // Place Alpaca Live / Paper Order
    if (path.endsWith("/trading/alpaca/order") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = (body.symbol || "").trim();
        const qty = Number(body.qty) || 1;
        const side = (body.side || "buy").toLowerCase() as "buy" | "sell";
        const type = body.type || "market";
        const limit_price = body.limit_price !== undefined ? Number(body.limit_price) : undefined;
        const time_in_force = body.time_in_force || "day";

        if (!symbol) {
          return Response.json({ error: "Stock symbol is required" }, { status: 400 });
        }

        const foss = new FossResearchService(this.env);
        const orderResult = await foss.placeAlpacaOrder({
          symbol,
          qty,
          side,
          type,
          limit_price,
          time_in_force,
        });

        this.audit("alpaca.order_placed", "trading", { symbol, qty, side, status: orderResult.status });
        return Response.json(orderResult);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to place Alpaca order" }, { status: 500 });
      }
    }

    // Get Alpaca Account & Buying Power
    if (path.endsWith("/trading/alpaca/account") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const account = await foss.getAlpacaAccount();
        return Response.json(account);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch Alpaca account" }, { status: 500 });
      }
    }

    // Get Alpaca Open Positions
    if (path.endsWith("/trading/alpaca/positions") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const positions = await foss.getAlpacaPositions();
        return Response.json(positions);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch Alpaca positions" }, { status: 500 });
      }
    }

    // Get Alpaca Orders List
    if (path.endsWith("/trading/alpaca/orders") && request.method === "GET") {
      try {
        const status = (url.searchParams.get("status") || "open") as any;
        const foss = new FossResearchService(this.env);
        const orders = await foss.getAlpacaOrders(status);
        return Response.json(orders);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to fetch Alpaca orders" }, { status: 500 });
      }
    }

    // ==========================================
    // FOSS Market Research & Quoting APIs (yfinance & Alpaca)
    // ==========================================

    // Real-time quote (Yahoo Finance, Alpaca, or Hybrid)
    if (path.endsWith("/foss/quote") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const provider = (url.searchParams.get("provider") || "hybrid") as any;
        const foss = new FossResearchService(this.env);
        const quote = await foss.getQuote(symbol, provider);
        return Response.json(quote);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch FOSS quote" }, { status: 500 });
      }
    }

    // Company fundamentals & valuation metrics (yfinance)
    if (path.endsWith("/foss/fundamentals") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const foss = new FossResearchService(this.env);
        const fundamentals = await foss.getFundamentals(symbol);
        return Response.json(fundamentals);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch fundamentals" }, { status: 500 });
      }
    }

    // Historical OHLCV bars (yfinance / Alpaca)
    if (path.endsWith("/foss/bars") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const timeframe = url.searchParams.get("timeframe") || "1D";
        const limit = Number(url.searchParams.get("limit") || "30");
        const provider = (url.searchParams.get("provider") || "yfinance") as "yfinance" | "alpaca" | "hybrid";
        const foss = new FossResearchService(this.env);
        const bars = await foss.getHistoricalBars(symbol, timeframe, limit, provider);
        return Response.json({
          symbol: symbol.toUpperCase(),
          provider,
          timeframe,
          count: bars.length,
          bars,
          source: provider === "alpaca" ? "Alpaca Market Data v2" : "Yahoo Finance FOSS Chart API",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch historical bars" }, { status: 500 });
      }
    }

    // Comprehensive equity research report with Agent DID stamp
    if (path.endsWith("/foss/research") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const foss = new FossResearchService(this.env);
        const report = await foss.generateResearchReport(symbol);
        this.audit("foss.research_generated", "research", { symbol, rating: report.analystRating, did: report.agentAttestation.did });
        return Response.json(report);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to generate research report" }, { status: 500 });
      }
    }

    // Alpaca real-time market snapshot & NBBO spread
    if (path.endsWith("/foss/snapshot") && request.method === "GET") {
      try {
        const symbol = url.searchParams.get("symbol") || "NVDA";
        const foss = new FossResearchService(this.env);
        const snapshot = await foss.getAlpacaSnapshot(symbol);
        this.audit("alpaca.snapshot_queried", "trading", {
          symbol,
          price: snapshot.latestTrade?.price,
          bid: snapshot.latestQuote?.bidPrice,
          ask: snapshot.latestQuote?.askPrice,
          assetClass: snapshot.assetClass,
        });
        return Response.json(snapshot);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca market snapshot" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Account Status & Balance with Agentic Tracing
    if (path.endsWith("/foss/alpaca/account") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const result = await foss.getAlpacaAccount();
        this.audit("alpaca.account_queried", "trading", {
          success: result.success,
          accountId: result.account?.id,
          buyingPower: result.account?.buying_power,
          portfolioValue: result.account?.portfolio_value,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca account" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Portfolio Positions with Agentic Tracing
    if (path.endsWith("/foss/alpaca/positions") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const result = await foss.getAlpacaPositions();
        this.audit("alpaca.positions_queried", "trading", {
          success: result.success,
          count: result.positions?.length || 0,
          symbols: result.positions?.map((p: any) => p.symbol) || [],
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca positions" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Order History Ledger with Agentic Tracing
    if (path.endsWith("/foss/alpaca/orders") && request.method === "GET") {
      try {
        const status = (url.searchParams.get("status") || "open") as "open" | "closed" | "all";
        const foss = new FossResearchService(this.env);
        const result = await foss.getAlpacaOrders(status);
        this.audit("alpaca.orders_queried", "trading", {
          status,
          count: result.orders?.length || 0,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch Alpaca orders" }, { status: 500 });
      }
    }

    // Alpaca Trading v2: Place Order with Agent DID Attestation & Agentic Tracing
    if (path.endsWith("/foss/alpaca/order") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const symbol = (body.symbol || "").toUpperCase().trim();
        const qty = Number(body.qty || body.quantity || 1);
        const side = (body.side || body.orderAction || "buy").toLowerCase() as "buy" | "sell";
        const type = (body.type || body.orderType || "market").toLowerCase() as any;
        const limit_price = body.limit_price || body.limitPrice ? Number(body.limit_price || body.limitPrice) : undefined;
        const time_in_force = body.time_in_force || "day";

        if (!symbol) {
          return Response.json({ error: "Symbol is required" }, { status: 400 });
        }

        const foss = new FossResearchService(this.env);
        const result = await foss.placeAlpacaOrder({
          symbol,
          qty,
          side,
          type,
          limit_price,
          time_in_force,
        });

        this.audit("alpaca.order_placed", "trading", {
          symbol,
          qty,
          side,
          type,
          limitPrice: limit_price,
          orderId: result.orderId,
          status: result.status,
          success: result.success,
        });

        return Response.json(result);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to place Alpaca order" }, { status: 500 });
      }
    }

    // Multi-ticker valuation comparison
    if (path.endsWith("/foss/compare") && (request.method === "POST" || request.method === "GET")) {
      try {
        let symbols = ["NVDA", "AAPL", "MSFT"];
        if (request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as any;
          if (Array.isArray(body.symbols) && body.symbols.length > 0) {
            symbols = body.symbols;
          }
        } else {
          const symParam = url.searchParams.get("symbols");
          if (symParam) symbols = symParam.split(",").map(s => s.trim());
        }
        const foss = new FossResearchService(this.env);
        const comparison = await foss.compareStocks(symbols);
        return Response.json({ count: comparison.length, comparison });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to compare stocks" }, { status: 500 });
      }
    }

    // FOSS provider statuses (Yahoo Finance + Alpaca)
    if (path.endsWith("/foss/providers") && request.method === "GET") {
      try {
        const foss = new FossResearchService(this.env);
        const statuses = foss.getProviderStatuses();
        return Response.json({ providers: statuses });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to fetch FOSS providers" }, { status: 500 });
      }
    }

    // Dedicated Yahoo Finance (FOSS) Market Screener
    if ((path.endsWith("/foss/screen") || path.endsWith("/yfinance/screen")) && (request.method === "POST" || request.method === "GET")) {
      try {
        const filters = request.method === "POST" ? ((await request.json().catch(() => ({}))) as any) : {};
        if (request.method === "GET") {
          if (url.searchParams.get("sector")) filters.sector = url.searchParams.get("sector");
          if (url.searchParams.get("search")) filters.search = url.searchParams.get("search");
          if (url.searchParams.get("maxRsi")) filters.maxRsi = Number(url.searchParams.get("maxRsi"));
          if (url.searchParams.get("minRsi")) filters.minRsi = Number(url.searchParams.get("minRsi"));
          if (url.searchParams.get("maxPeRatio")) filters.maxPeRatio = Number(url.searchParams.get("maxPeRatio"));
          if (url.searchParams.get("gainersOnly")) filters.gainersOnly = url.searchParams.get("gainersOnly") === "true";
          if (url.searchParams.get("losersOnly")) filters.losersOnly = url.searchParams.get("losersOnly") === "true";
        }
        const screener = new YFinanceMarketScreener();
        const results = await screener.screenMarkets(filters);
        this.audit("foss.screener.executed", "research", { filterSummary: results.filterSummary, count: results.stocks.length });
        return Response.json({
          ...results,
          results: results.stocks,
          stocks: results.stocks,
        });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Failed to run Yahoo Finance screener" }, { status: 500 });
      }
    }

    // ==========================================
    // Cloudflare Agents Task Scheduling Management APIs
    // ==========================================

    // List all schedules (supports ?type=cron|interval|delayed|scheduled)
    if ((path.endsWith("/schedules") || path.endsWith("/api/schedules")) && request.method === "GET") {
      try {
        const type = url.searchParams.get("type") as any;
        const schedules = typeof (this as any).listSchedules === "function"
          ? await (this as any).listSchedules(type ? { type } : undefined)
          : [];
        return Response.json({
          count: schedules.length,
          schedules,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to list schedules" }, { status: 500 });
      }
    }

    // Cancel a schedule by ID (POST /api/schedules/cancel or DELETE /api/schedules/:id)
    if (
      ((path.endsWith("/schedules/cancel") || path.includes("/schedules/cancel/")) && request.method === "POST") ||
      (path.includes("/schedules/") && request.method === "DELETE")
    ) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const scheduleId =
          body.scheduleId ||
          body.id ||
          url.searchParams.get("id") ||
          path.split("/schedules/cancel/")[1] ||
          path.split("/schedules/")[1] ||
          "";

        if (!scheduleId) {
          return Response.json({ error: "Schedule ID is required" }, { status: 400 });
        }
        const cancelled = typeof (this as any).cancelSchedule === "function"
          ? await (this as any).cancelSchedule(scheduleId)
          : false;
        this.audit("schedule.cancelled", "orchestrator", { scheduleId, success: cancelled });
        return Response.json({ scheduleId, cancelled });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to cancel schedule" }, { status: 500 });
      }
    }

    // Get specific schedule by ID (GET /api/schedules/:id)
    if (path.includes("/schedules/") && request.method === "GET") {
      try {
        const scheduleId = path.split("/schedules/").pop() || "";
        const schedule = typeof (this as any).getScheduleById === "function"
          ? await (this as any).getScheduleById(scheduleId)
          : undefined;
        if (!schedule) {
          return Response.json({ error: `Schedule '${scheduleId}' not found` }, { status: 404 });
        }
        return Response.json(schedule);
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to get schedule" }, { status: 500 });
      }
    }

    // Create a schedule (delayed, scheduled, cron, or interval)
    if ((path.endsWith("/schedules/create") || (path.endsWith("/schedules") && request.method === "POST"))) {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const { scheduleType, callback, payload, delayInSeconds, intervalSeconds, cron, date } = body;

        if (!callback) {
          return Response.json({ error: "Callback method name is required" }, { status: 400 });
        }

        let schedule: any;
        if (scheduleType === "interval" && intervalSeconds) {
          schedule = typeof (this as any).scheduleEvery === "function"
            ? await (this as any).scheduleEvery(Number(intervalSeconds), callback, payload)
            : { id: `sched_mock_${Date.now()}`, type: "interval", intervalSeconds, callback, payload };
        } else if (scheduleType === "cron" && cron) {
          schedule = typeof (this as any).schedule === "function"
            ? await (this as any).schedule(cron, callback, payload, { idempotent: body.idempotent !== false })
            : { id: `sched_mock_${Date.now()}`, type: "cron", cron, callback, payload };
        } else if (scheduleType === "scheduled" && date) {
          schedule = typeof (this as any).schedule === "function"
            ? await (this as any).schedule(new Date(date), callback, payload)
            : { id: `sched_mock_${Date.now()}`, type: "scheduled", date, callback, payload };
        } else if (delayInSeconds !== undefined) {
          schedule = typeof (this as any).schedule === "function"
            ? await (this as any).schedule(Number(delayInSeconds), callback, payload)
            : { id: `sched_mock_${Date.now()}`, type: "delayed", delayInSeconds, callback, payload };
        } else {
          return Response.json(
            { error: "Invalid schedule parameters: provide intervalSeconds, cron, date, or delayInSeconds" },
            { status: 400 }
          );
        }

        this.audit("schedule.created", "orchestrator", { scheduleId: schedule?.id, callback, scheduleType });
        return Response.json({ success: true, schedule });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to create schedule" }, { status: 500 });
      }
    }

    // Trigger autonomous market screen immediately on demand
    if (path.endsWith("/schedules/trigger-screen") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        await this.autonomousMarketScreen(body);
        return Response.json({ success: true, message: "Autonomous market screen triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger market screen" }, { status: 500 });
      }
    }

    // Trigger E*TRADE token renewal immediately on demand
    if (path.endsWith("/schedules/trigger-renew") && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        await this.autoRenewETradeTokens(body);
        return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
      } catch (err: any) {
        return Response.json({ error: err.message || "Failed to trigger token renewal" }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}
