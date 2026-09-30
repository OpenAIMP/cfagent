/**
 * Model Context Protocol (MCP) Server for Multi-Agent Studio
 * Implements the open JSON-RPC 2.0 Model Context Protocol standard (protocolVersion: 2024-11-05).
 * Exposes all platform capabilities as MCP Tools, Resources, and Prompts.
 */

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import { PaymentGatewayService, type SupportedGateway } from "../services/payments";
import { AGENT_DIDS, getUserDid, resolveAgentDidDocument } from "../agents/did";
import { planNLQ, executeNLQQuery } from "../agents/nlq";

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export const MCP_SERVER_INFO = {
  name: "multi-agent-studio-mcp",
  title: "Multi-Agent Studio Enterprise MCP Server",
  version: "1.0.0",
  description: "Exposes autonomous agent orchestration, SQLite ORM, HITL payments with DIDs, NLQ database querying, referral categories taxonomy, and revenue monetization engines via Model Context Protocol.",
  protocolVersion: "2024-11-05",
};

/**
 * All Tools exposed via MCP
 */
export const MCP_TOOLS: MCPToolDefinition[] = [
  {
    name: "knowledge_search",
    description: "Search the organization's enterprise knowledge base using Cloudflare AI Search RAG with Vectorize index retrieval.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or natural language inquiry" },
      },
      required: ["query"],
    },
  },
  {
    name: "draft_payment",
    description: "Prepare an explicit human-authorized payment intent draft (charge, refund, invoice) with Agent Decentralized Identifier (DID) attestation across Stripe, PayPal, or Lemon Squeezy.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Payment amount in dollars (e.g. 25.00)" },
        currency: { type: "string", description: "Currency code (default: USD)" },
        customer: { type: "string", description: "Customer name or organization" },
        gateway: { type: "string", enum: ["stripe", "paypal", "lemonsqueezy"], description: "Payment gateway processor" },
        action: { type: "string", enum: ["charge", "refund", "invoice"], description: "Payment action type" },
        description: { type: "string", description: "Order description or note" },
      },
      required: ["amount", "customer"],
    },
  },
  {
    name: "confirm_payment_draft",
    description: "Authorize or reject a pending payment draft using Human-in-the-Loop (HITL) approval with cryptographic verification.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "The unique payment draft identifier (e.g. pay_12345)" },
        decision: { type: "string", enum: ["approved", "rejected"], description: "Human authorization decision" },
        note: { type: "string", description: "Optional review note or justification" },
      },
      required: ["draftId", "decision"],
    },
  },
  {
    name: "get_payment_gateways",
    description: "Query multi-gateway processor statuses (Stripe, PayPal, Lemon Squeezy) and registered agent W3C DID identifiers.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_transactions",
    description: "Query settled payment transactions, drafts, and cryptographic proof signatures from the mas_transactions ledger.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of transactions to return (default: 50)" },
        status: { type: "string", description: "Filter by status: completed, awaiting_confirmation, rejected" },
      },
    },
  },
  {
    name: "execute_nlq",
    description: "Execute a natural language query over SQLite database tables, schema metadata, categories taxonomy, or conversation transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query (e.g. 'List all tables and schema', 'Show referral categories', or 'Add category Web3')" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_database_tables",
    description: "Introspect relational SQLite database schema, table definitions, row counts, and column metadata via DatabaseORM.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "query_table_data",
    description: "Query rows from any SQLite table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_messages, mas_memory, mas_events) with optional filtering and pagination via ORM.",
    inputSchema: {
      type: "object",
      properties: {
        tableName: { type: "string", description: "Table name to query (e.g. mas_categories)" },
        search: { type: "string", description: "Optional search keyword to filter text fields" },
        limit: { type: "number", description: "Maximum records to return (default: 50)" },
        offset: { type: "number", description: "Offset for pagination (default: 0)" },
      },
      required: ["tableName"],
    },
  },
  {
    name: "manage_categories",
    description: "Full CRUD management for referral categories taxonomy in mas_categories via DatabaseORM.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "update", "delete"], description: "Category operation" },
        id: { type: "string", description: "Category ID (required for update/delete)" },
        name: { type: "string", description: "Category name (required for create)" },
        icon: { type: "string", description: "Emoji or icon for category (e.g. 🤖, ☁️, 🏷️)" },
        description: { type: "string", description: "Category description" },
        sortOrder: { type: "number", description: "Sort priority order" },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_referrals",
    description: "Manage developer referral links and track click attribution in mas_referrals via DatabaseORM.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "track_click", "delete"], description: "Referrals operation" },
        id: { type: "string", description: "Referral ID (for track_click/delete)" },
        title: { type: "string", description: "Service or tool title" },
        url: { type: "string", description: "Destination referral URL" },
        category: { type: "string", description: "Associated category name" },
        rewardText: { type: "string", description: "Reward bonus offer text" },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_external_ads",
    description: "Manage external ad placements (EthicalAds, Carbon Ads, AdSense, Direct) and record CPM/CPC revenue monetization.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "impression", "click"], description: "Ad operation" },
        id: { type: "string", description: "Ad placement ID (required for impression/click)" },
        title: { type: "string", description: "Campaign title" },
        network: { type: "string", enum: ["ethicalads", "carbon", "adsense", "direct"], description: "Ad network partner" },
        placement: { type: "string", enum: ["header_leaderboard", "in_stream", "footer_deck", "sidebar"], description: "Placement slot" },
        tagline: { type: "string", description: "Promotional copy" },
        targetUrl: { type: "string", description: "Destination URL" },
        ctaText: { type: "string", description: "Button text" },
        cpmRate: { type: "number", description: "CPM rate ($/1,000 impressions)" },
        cpcRate: { type: "number", description: "CPC rate ($/click)" },
      },
      required: ["action"],
    },
  },
  {
    name: "get_revenue_summary",
    description: "Compute platform financial analytics across ad networks (CPM/CPC), marketplace direct ads, payment transaction fees, referral payouts, and net profit.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "manage_session_memory",
    description: "Read, persist, or clear persistent grounding session facts stored in mas_memory SQLite key-value store.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "remember", "delete", "clear"], description: "Memory action" },
        key: { type: "string", description: "Memory key (e.g. preferred_gateway)" },
        value: { type: "string", description: "Memory value fact to store" },
      },
      required: ["action"],
    },
  },
  {
    name: "get_audit_events",
    description: "Query real-time observability events stream (routing decisions, judge evaluations, payment lifecycle, errors) from mas_events.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum events to return (default: 50)" },
      },
    },
  },
];

/**
 * Resources exposed via MCP
 */
export const MCP_RESOURCES: MCPResourceDefinition[] = [
  {
    uri: "sqlite://schema/tables",
    name: "Database Tables & Schema",
    description: "Comprehensive schema definitions and row counts for all SQLite tables in Multi-Agent Studio.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://revenue/summary",
    name: "Platform Revenue Summary",
    description: "Real-time financial summary of gross revenue, ad earnings, transaction fees, and net profit.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://categories/list",
    name: "Referral Categories Taxonomy",
    description: "Active referral and partner link taxonomy categories.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://external-ads/inventory",
    name: "External Ad Network Inventory",
    description: "Active advertising placements, impression counters, and earnings.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://memory/facts",
    name: "Persistent Session Facts",
    description: "Grounding facts and long-term user preferences saved in SQLite.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://audit/recent",
    name: "Observability Audit Stream",
    description: "Recent router decisions, HITL authorizations, and agent execution events.",
    mimeType: "application/json",
  },
];

/**
 * Prompts exposed via MCP
 */
export const MCP_PROMPTS: MCPPromptDefinition[] = [
  {
    name: "audit_security_review",
    description: "Security and compliance review of pending financial drafts and cryptographic DID proof signatures.",
    arguments: [
      { name: "draftId", description: "Draft payment ID to inspect", required: true },
    ],
  },
  {
    name: "revenue_performance_analysis",
    description: "Analyze monetization efficiency across external ad networks (CPM/CPC) and recommend inventory optimizations.",
    arguments: [],
  },
  {
    name: "nlq_schema_exploration",
    description: "Formulate optimal natural language queries to explore data and relationships across SQLite tables.",
    arguments: [],
  },
];

/**
 * Executes an MCP Tool Call against the platform services and ORM.
 */
export async function executeMCPTool(
  toolName: string,
  args: Record<string, any>,
  context: {
    env: Env;
    orm: DatabaseORM;
    sessionId: string;
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  }
): Promise<any> {
  const { env, orm, sessionId, audit } = context;

  switch (toolName) {
    case "knowledge_search": {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("query is required");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${env.AI_SEARCH_ENDPOINT}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          return { error: `AI Search upstream returned ${response.status}`, query, count: 0, chunks: [] };
        }
        const data = (await response.json()) as any;
        const rawChunks = data?.result?.chunks ?? (Array.isArray(data) ? data : []);
        const chunks = Array.isArray(rawChunks) ? rawChunks : [];
        audit("mcp.tool_called", "orchestrator", { tool: toolName, query, count: chunks.length });
        return { query, count: chunks.length, chunks };
      } catch (err: any) {
        clearTimeout(timeout);
        return { error: err.message || "Search request failed", query, count: 0, chunks: [] };
      }
    }

    case "draft_payment": {
      const amount = Number(args.amount) || 10;
      const currency = (args.currency || "USD").toUpperCase();
      const customer = (args.customer || "Enterprise Client").trim();
      const action = (args.action || "charge") as "charge" | "refund" | "invoice";
      const gateway = (args.gateway || "stripe") as SupportedGateway;
      const description = (args.description || `AI Compute Tokens for ${customer}`).trim();

      const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
      const userDid = getUserDid(sessionId);

      const paymentService = new PaymentGatewayService(env);
      const checkoutResult = await paymentService.createCheckout({
        draftId,
        amount,
        currency,
        customer,
        description,
        gateway,
        userLogin: sessionId,
      });

      const now = new Date().toISOString();
      const tx = orm.transactions.create({
        id: draftId,
        sessionId,
        action,
        amount,
        currency,
        customer,
        gateway,
        gatewayRef: checkoutResult.gatewayRef || "",
        status: "completed",
        checkoutUrl: checkoutResult.checkoutUrl,
        proposerDid: AGENT_DIDS.PAYMENTS,
        authorizerDid: userDid,
        proofSignature: checkoutResult.didAttestation.signature,
        note: description,
        createdAt: now,
        updatedAt: now,
      });

      audit("mcp.payment_drafted", "orchestrator", { draftId, amount, customer, gateway });
      return { success: true, transaction: tx };
    }

    case "confirm_payment_draft": {
      const draftId = String(args.draftId || "").trim();
      const decision = args.decision === "rejected" ? "rejected" : "approved";
      const note = String(args.note || "").trim();

      const tx = orm.transactions.findById(draftId);
      if (!tx) throw new Error(`Draft ${draftId} not found`);

      const now = new Date().toISOString();
      const userDid = getUserDid(sessionId);

      if (decision === "approved") {
        const paymentService = new PaymentGatewayService(env);
        let checkoutUrl = tx.checkoutUrl || "";
        let gatewayRef = tx.gatewayRef || "";

        if ((tx.action === "charge" || tx.action === "invoice") && !checkoutUrl) {
          const res = await paymentService.createCheckout({
            draftId,
            amount: tx.amount,
            currency: tx.currency,
            customer: tx.customer,
            gateway: tx.gateway as SupportedGateway,
            userLogin: sessionId,
            description: tx.note || "Authorized payment intent",
          });
          checkoutUrl = res.checkoutUrl;
          gatewayRef = res.gatewayRef;
        }

        const updated = orm.transactions.update(draftId, {
          status: "completed",
          gatewayRef,
          checkoutUrl,
          authorizerDid: userDid,
          note: note || "Authorized via MCP Tool",
          updatedAt: now,
        });

        audit("mcp.payment_confirmed", "orchestrator", { draftId, decision });
        return { success: true, status: "completed", transaction: updated };
      } else {
        const updated = orm.transactions.update(draftId, {
          status: "rejected",
          authorizerDid: userDid,
          note: note || "Rejected via MCP Tool",
          updatedAt: now,
        });
        audit("mcp.payment_rejected", "orchestrator", { draftId, decision });
        return { success: true, status: "rejected", transaction: updated };
      }
    }

    case "get_payment_gateways": {
      const paymentService = new PaymentGatewayService(env);
      return {
        gateways: paymentService.getGatewayStatuses(),
        agentDids: AGENT_DIDS,
        userDid: getUserDid(sessionId),
      };
    }

    case "get_transactions": {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
      const where: Record<string, unknown> = {};
      if (args.status) where.status = args.status;

      const transactions = orm.transactions.findMany({
        where,
        orderBy: "created_at DESC",
        limit,
      });
      return { count: transactions.length, transactions };
    }

    case "execute_nlq": {
      const query = String(args.query || "").trim();
      if (!query) throw new Error("query parameter is required");

      const plan = await planNLQ(env, query);
      const result = executeNLQQuery(orm, sessionId, plan);
      audit("mcp.nlq_executed", "orchestrator", { query, domain: result.domain, count: result.count });
      return result;
    }

    case "list_database_tables": {
      const tables = orm.listTables();
      return { count: tables.length, tables };
    }

    case "query_table_data": {
      const tableName = String(args.tableName || "mas_categories").trim();
      const search = args.search ? String(args.search) : undefined;
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const offset = Math.max(Number(args.offset) || 0, 0);

      const result = orm.getTableData(tableName, { search, limit, offset });
      return result;
    }

    case "manage_categories": {
      const action = String(args.action || "list").toLowerCase();

      if (action === "list") {
        const categories = orm.categories.findMany({ orderBy: "sort_order ASC" });
        return { count: categories.length, categories };
      }

      if (action === "create") {
        const name = String(args.name || "").trim();
        if (!name) throw new Error("name is required for create");
        const slug = (args.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).slice(0, 32);
        const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;
        const now = new Date().toISOString();

        const created = orm.categories.create({
          id,
          name,
          slug,
          description: args.description || `Category for ${name} referrals`,
          icon: args.icon || "🏷️",
          isActive: true,
          sortOrder: Number(args.sortOrder) || (orm.categories.count() || 0) + 1,
          createdAt: now,
          updatedAt: now,
        });
        audit("mcp.category_created", "orchestrator", { id, name });
        return { success: true, category: created };
      }

      if (action === "update") {
        const id = String(args.id || "").trim();
        if (!id) throw new Error("id is required for update");
        const updates: Record<string, unknown> = {};
        if (args.name) updates.name = args.name;
        if (args.icon) updates.icon = args.icon;
        if (args.description) updates.description = args.description;
        if (args.sortOrder !== undefined) updates.sortOrder = Number(args.sortOrder);
        updates.updatedAt = new Date().toISOString();

        const updated = orm.categories.update(id, updates);
        return { success: true, category: updated };
      }

      if (action === "delete") {
        const id = String(args.id || "").trim();
        if (!id) throw new Error("id is required for delete");
        orm.categories.delete(id);
        audit("mcp.category_deleted", "orchestrator", { id });
        return { success: true };
      }

      throw new Error(`Unknown action: ${action}`);
    }

    case "manage_referrals": {
      const action = String(args.action || "list").toLowerCase();

      if (action === "list") {
        const referrals = orm.referrals.findMany({ orderBy: "created_at DESC", limit: 100 });
        return { count: referrals.length, referrals };
      }

      if (action === "create") {
        const title = String(args.title || "").trim();
        const url = String(args.url || "").trim();
        if (!title || !url) throw new Error("title and url are required");

        const id = `ref_${crypto.randomUUID().slice(0, 8)}`;
        const now = new Date().toISOString();
        const created = orm.referrals.create({
          id,
          userLogin: sessionId,
          title,
          url,
          category: args.category || "AI & Dev Tools",
          rewardText: args.rewardText || "Community referral reward",
          clicks: 0,
          signups: 0,
          createdAt: now,
        });
        audit("mcp.referral_created", "orchestrator", { id, title });
        return { success: true, referral: created };
      }

      if (action === "track_click") {
        const id = String(args.id || "").trim();
        const existing = orm.referrals.findById(id);
        if (existing) {
          orm.referrals.update(id, { clicks: existing.clicks + 1 });
          return { success: true, clicks: existing.clicks + 1 };
        }
        return { success: false, error: "Referral not found" };
      }

      if (action === "delete") {
        const id = String(args.id || "").trim();
        orm.referrals.delete(id);
        return { success: true };
      }

      throw new Error(`Unknown action: ${action}`);
    }

    case "manage_external_ads": {
      const action = String(args.action || "list").toLowerCase();

      if (action === "list") {
        const ads = orm.externalAds.findMany({ orderBy: "earnings DESC" });
        return { count: ads.length, ads };
      }

      if (action === "create") {
        const title = String(args.title || "").trim();
        const targetUrl = String(args.targetUrl || "").trim();
        if (!title || !targetUrl) throw new Error("title and targetUrl are required");

        const now = new Date().toISOString();
        const network = args.network || "direct";
        const id = `ext_${network}_${crypto.randomUUID().slice(0, 6)}`;
        const cpmRate = Number(args.cpmRate) || 18.5;
        const cpcRate = Number(args.cpcRate) || 1.5;

        const created = orm.externalAds.create({
          id,
          name: title,
          network,
          placement: args.placement || "header_leaderboard",
          title,
          tagline: args.tagline || "",
          ctaText: args.ctaText || "Learn More →",
          targetUrl,
          bannerImageUrl: "",
          cpmRate,
          cpcRate,
          impressions: 1,
          clicks: 0,
          earnings: cpmRate / 1000,
          isActive: true,
          createdAt: now,
        });
        audit("mcp.external_ad_created", "orchestrator", { id, title });
        return { success: true, ad: created };
      }

      if (action === "impression") {
        const id = String(args.id || "").trim();
        const ad = orm.externalAds.findById(id);
        if (ad) {
          const newImpressions = ad.impressions + 1;
          const incremental = (ad.cpmRate || 15.0) / 1000;
          const newEarnings = Math.round((ad.earnings + incremental) * 1000) / 1000;
          orm.externalAds.update(id, { impressions: newImpressions, earnings: newEarnings });
          return { success: true, impressions: newImpressions, earnings: newEarnings };
        }
        return { success: false, error: "Ad not found" };
      }

      if (action === "click") {
        const id = String(args.id || "").trim();
        const ad = orm.externalAds.findById(id);
        if (ad) {
          const newClicks = ad.clicks + 1;
          const incremental = ad.cpcRate || 1.25;
          const newEarnings = Math.round((ad.earnings + incremental) * 100) / 100;
          orm.externalAds.update(id, { clicks: newClicks, earnings: newEarnings });
          audit("mcp.ad_clicked", "orchestrator", { id, clicks: newClicks, earnings: newEarnings });
          return { success: true, clicks: newClicks, earnings: newEarnings };
        }
        return { success: false, error: "Ad not found" };
      }

      throw new Error(`Unknown action: ${action}`);
    }

    case "get_revenue_summary": {
      const summary = orm.getRevenueSummary();
      return summary;
    }

    case "manage_session_memory": {
      const action = String(args.action || "list").toLowerCase();

      if (action === "list") {
        const memories = orm.memory.findMany({ orderBy: "updated_at DESC", limit: 100 });
        return { count: memories.length, memories };
      }

      if (action === "remember") {
        const key = String(args.key || "").trim();
        const value = String(args.value || "").trim();
        if (!key || !value) throw new Error("key and value are required");
        const now = new Date().toISOString();

        orm.memory.create({ key, value, updatedAt: now });
        audit("mcp.memory_saved", "orchestrator", { key });
        return { success: true, key, value };
      }

      if (action === "delete") {
        const key = String(args.key || "").trim();
        orm.memory.delete(key);
        audit("mcp.memory_deleted", "orchestrator", { key });
        return { success: true };
      }

      if (action === "clear") {
        const sql = (orm as any).sql;
        sql.exec("DELETE FROM mas_memory");
        audit("mcp.memory_cleared", "orchestrator", {});
        return { success: true };
      }

      throw new Error(`Unknown action: ${action}`);
    }

    case "get_audit_events": {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
      const rawEvents = orm.events.findMany({
        where: { sessionId },
        orderBy: "created_at DESC",
        limit,
      });

      const parsed = rawEvents.map((e) => {
        let payload: Record<string, unknown> = {};
        if (typeof e.payload === "string") {
          try {
            payload = JSON.parse(e.payload);
          } catch {
            payload = { raw: e.payload };
          }
        } else {
          payload = (e.payload as any) || {};
        }
        return { ...e, payload };
      });

      return { count: parsed.length, events: parsed };
    }

    default:
      throw new Error(`Unknown MCP Tool: ${toolName}`);
  }
}

/**
 * Reads an MCP Resource by URI.
 */
export async function readMCPResource(
  uri: string,
  context: { orm: DatabaseORM; sessionId: string }
): Promise<{ uri: string; mimeType: string; text: string }> {
  const { orm, sessionId } = context;

  switch (uri) {
    case "sqlite://schema/tables": {
      const tables = orm.listTables();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(tables, null, 2),
      };
    }
    case "sqlite://revenue/summary": {
      const summary = orm.getRevenueSummary();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(summary, null, 2),
      };
    }
    case "sqlite://categories/list": {
      const categories = orm.categories.findMany({ orderBy: "sort_order ASC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(categories, null, 2),
      };
    }
    case "sqlite://external-ads/inventory": {
      const ads = orm.externalAds.findMany({ orderBy: "earnings DESC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(ads, null, 2),
      };
    }
    case "sqlite://memory/facts": {
      const memories = orm.memory.findMany({ orderBy: "updated_at DESC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(memories, null, 2),
      };
    }
    case "sqlite://audit/recent": {
      const events = orm.events.findMany({ where: { sessionId }, orderBy: "created_at DESC", limit: 30 });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(events, null, 2),
      };
    }
    default:
      throw new Error(`MCP Resource not found: ${uri}`);
  }
}

/**
 * Handles incoming Model Context Protocol JSON-RPC 2.0 requests.
 */
export async function handleMCPRequest(
  request: MCPRequest,
  context: {
    env: Env;
    orm: DatabaseORM;
    sessionId: string;
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  }
): Promise<MCPResponse> {
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_SERVER_INFO.protocolVersion,
            serverInfo: {
              name: MCP_SERVER_INFO.name,
              version: MCP_SERVER_INFO.version,
            },
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
          },
        };

      case "ping":
        return {
          jsonrpc: "2.0",
          id,
          result: {},
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_TOOLS,
          },
        };

      case "tools/call": {
        const { name, arguments: toolArgs } = request.params || {};
        if (!name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: 'name' is required" },
          };
        }

        const data = await executeMCPTool(name, toolArgs || {}, context);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
              },
            ],
            isError: false,
          },
        };
      }

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: MCP_RESOURCES,
          },
        };

      case "resources/read": {
        const { uri } = request.params || {};
        if (!uri) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: 'uri' is required" },
          };
        }
        const resource = await readMCPResource(uri, context);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [resource],
          },
        };
      }

      case "prompts/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            prompts: MCP_PROMPTS,
          },
        };

      case "prompts/get": {
        const { name } = request.params || {};
        const prompt = MCP_PROMPTS.find((p) => p.name === name);
        if (!prompt) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Prompt not found: ${name}` },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: prompt.description,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Execute workflow for prompt template: ${prompt.name}.`,
                },
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err.message || "Internal error during MCP execution",
      },
    };
  }
}
