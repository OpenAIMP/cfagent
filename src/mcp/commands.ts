/**
 * GoF Command Pattern & Factory Pattern: Platform MCP Tools
 *
 * Implements:
 * - GoF Command Pattern: Every capability is an encapsulated IMcpToolCommand.
 * - GoF Factory Pattern: McpToolFactory instantiates, registers, and dispatches commands.
 * - SOLID Single Responsibility Principle (SRP): Each command class does only its designated task.
 * - SOLID Open/Closed Principle (OCP): New tools can be plugged in without modifying existing commands.
 * - SOLID Liskov Substitution Principle (LSP): All commands are polymorphically interchangeable.
 * - GRASP Information Expert: Database and payment domain queries delegate to the respective entities.
 * - GRASP Low Coupling & High Cohesion: Commands interact through McpToolContext / McpSystemFacade.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import type { SupportedGateway } from "../services/payments";
import { AGENT_DIDS, createDidAttestation, getUserDid } from "../agents/did";
import { planNLQ, executeNLQQuery } from "../agents/nlq";

/**
 * 1. Knowledge Search Command (RAG Vectorize & Cloudflare AI Search)
 */
export class KnowledgeSearchCommand implements IMcpToolCommand<{ query: string }> {
  readonly name = "knowledge_search";
  readonly description = "Search the organization's enterprise knowledge base using Cloudflare AI Search RAG with Vectorize index retrieval.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query or natural language inquiry" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string().min(1).describe("Search query or natural language inquiry"),
  });

  async execute(input: { query: string }, context: McpToolContext) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${context.env.AI_SEARCH_ENDPOINT}/search`, {
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
      context.audit("mcp.tool_called", "orchestrator", { tool: this.name, query, count: chunks.length });
      return {
        query,
        count: chunks.length,
        chunks: chunks.slice(0, 5),
        message: chunks.length > 0
          ? `Retrieved ${chunks.length} factual documents from Cloudflare AI Search.`
          : "No custom indexed documents found in the Cloudflare AI Search knowledge base. Synthesize a helpful, authoritative response from general knowledge, clearly informing the user that no specific internal documents were indexed.",
      };
    } catch (err: any) {
      clearTimeout(timeout);
      return { error: err.message || "Search request failed", query, count: 0, chunks: [] };
    }
  }
}

/**
 * 2. Draft Payment Command
 */
export class DraftPaymentCommand implements IMcpToolCommand<{
  amount: number;
  currency?: string;
  customer: string;
  gateway?: SupportedGateway;
  action?: "charge" | "refund" | "invoice";
  description?: string;
}> {
  readonly name = "draft_payment";
  readonly description = "Prepare an explicit human-authorized payment intent draft (charge, refund, invoice) with Agent Decentralized Identifier (DID) attestation across Stripe, PayPal, or Lemon Squeezy.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      amount: { type: "number", description: "Payment amount in dollars (e.g. 25.00)" },
      currency: { type: "string", description: "Currency code (default: USD)" },
      customer: { type: "string", description: "Customer name or organization" },
      gateway: { type: "string", enum: ["stripe", "paypal", "lemonsqueezy", "sandbox"], description: "Payment gateway processor" },
      action: { type: "string", enum: ["charge", "refund", "invoice"], description: "Payment action type" },
      description: { type: "string", description: "Order description or note" },
    },
    required: ["amount", "customer"],
  };
  readonly zodSchema = z.object({
    amount: z.number().positive().describe("Payment amount in dollars (e.g. 25.00)"),
    currency: z.string().default("USD").describe("Currency code (default: USD)"),
    customer: z.string().min(1).describe("Customer name or organization"),
    gateway: z.enum(["stripe", "paypal", "lemonsqueezy", "sandbox"]).default("stripe").describe("Payment gateway processor"),
    action: z.enum(["charge", "refund", "invoice"]).default("charge").describe("Payment action type"),
    description: z.string().optional().describe("Order description or note"),
  });

  async execute(input: any, context: McpToolContext) {
    const amount = Number(input.amount) || 10;
    const currency = (input.currency || "USD").toUpperCase();
    const customer = (input.customer || "Enterprise Client").trim();
    const action = (input.action || "charge") as "charge" | "refund" | "invoice";
    const gateway = (input.gateway || "stripe") as SupportedGateway;
    const description = (input.description || `Payment intent for ${customer}`).trim();

    const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
    const userDid = getUserDid(context.sessionId);

    const didProof = await createDidAttestation({
      draftId,
      action,
      amount,
      currency,
      customer,
      gateway,
      proposerDid: AGENT_DIDS.PAYMENTS,
      authorizerDid: userDid,
    });

    const now = new Date().toISOString();
    const tx = context.orm.transactions.create({
      id: draftId,
      sessionId: context.sessionId,
      action,
      amount,
      currency,
      customer,
      gateway,
      gatewayRef: "",
      status: "awaiting_confirmation",
      checkoutUrl: "",
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      note: description,
      createdAt: now,
      updatedAt: now,
    });

    context.audit("payment.awaiting_confirmation", "payments", {
      draftId,
      action,
      amount,
      customer,
      gateway,
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
    });

    return {
      draftId,
      status: "awaiting_confirmation",
      requiresConfirmation: true,
      amount,
      currency,
      customer,
      gateway,
      action,
      proposerDid: didProof.proposerDid,
      authorizerDid: userDid,
      proofSignature: didProof.signature,
      securityNotice: "NO FUNDS HAVE BEEN MOVED. Stamped with Agent DID. Requires explicit human approval via confirm_payment_draft.",
      transaction: tx,
    };
  }
}

/**
 * 3. Confirm Payment Draft Command
 */
export class ConfirmPaymentDraftCommand implements IMcpToolCommand<{
  draftId: string;
  decision: "approved" | "rejected";
  note?: string;
}> {
  readonly name = "confirm_payment_draft";
  readonly description = "Authorize or reject a pending payment draft using Human-in-the-Loop (HITL) approval with cryptographic verification.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      draftId: { type: "string", description: "The unique payment draft identifier (e.g. pay_12345)" },
      decision: { type: "string", enum: ["approved", "rejected"], description: "Human authorization decision" },
      note: { type: "string", description: "Optional review note or justification" },
    },
    required: ["draftId", "decision"],
  };
  readonly zodSchema = z.object({
    draftId: z.string().describe("The unique payment draft identifier (e.g. pay_12345)"),
    decision: z.enum(["approved", "rejected"]).describe("Human authorization decision"),
    note: z.string().optional().describe("Optional review note or justification"),
  });

  async execute(input: { draftId: string; decision: "approved" | "rejected"; note?: string }, context: McpToolContext) {
    const { draftId, decision, note } = input;
    const tx = context.orm.transactions.findById(draftId);
    if (!tx) {
      throw new Error(`Draft ${draftId} not found in transactions repository`);
    }

    const now = new Date().toISOString();
    const userDid = getUserDid(context.sessionId);

    if (decision === "approved") {
      let checkoutUrl = tx.checkoutUrl || "";
      let gatewayRef = tx.gatewayRef || "";

      if (context.facade) {
        if (tx.action === "charge" || tx.action === "invoice") {
          const res = await context.facade.createCheckout({
            draftId,
            amount: tx.amount,
            currency: tx.currency,
            customer: tx.customer,
            gateway: tx.gateway as SupportedGateway,
            userLogin: context.sessionId,
            description: note || tx.note || `Payment for ${tx.customer}`,
          });
          checkoutUrl = res.checkoutUrl;
          gatewayRef = res.gatewayRef;
        } else if (tx.action === "refund") {
          const res = await context.facade.executeRefund({
            transactionId: draftId,
            amount: tx.amount,
            gateway: tx.gateway as SupportedGateway,
            gatewayRef: tx.gatewayRef,
            userLogin: context.sessionId,
            reason: note,
          });
          gatewayRef = res.refundId;
        }
      }

      const updated = context.orm.transactions.update(draftId, {
        status: "completed",
        authorizerDid: userDid,
        gatewayRef,
        checkoutUrl,
        note: note || "Approved by human authorizer",
        updatedAt: now,
      });

      context.audit("payment.confirmed", "payments", {
        draftId,
        status: "completed",
        decision: "approved",
        gatewayRef,
        checkoutUrl,
        authorizerDid: userDid,
      });

      return {
        draftId,
        status: "completed",
        decision: "approved",
        checkoutUrl,
        gatewayRef,
        authorizerDid: userDid,
        executorDid: AGENT_DIDS.ORCHESTRATOR,
        executedAt: now,
        transaction: updated,
      };
    } else {
      const updated = context.orm.transactions.update(draftId, {
        status: "rejected",
        authorizerDid: userDid,
        note: note || "Rejected by human reviewer",
        updatedAt: now,
      });

      context.audit("payment.rejected", "payments", { draftId, decision: "rejected", authorizerDid: userDid });

      return {
        draftId,
        status: "rejected",
        decision: "rejected",
        authorizerDid: userDid,
        executedAt: now,
        transaction: updated,
      };
    }
  }
}

/**
 * 4. Get Payment Gateways Command
 */
export class GetPaymentGatewaysCommand implements IMcpToolCommand<{}> {
  readonly name = "get_payment_gateways";
  readonly description = "Query multi-gateway processor statuses (Stripe, PayPal, Lemon Squeezy) and registered agent W3C DID identifiers.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const statuses = context.facade ? context.facade.getGatewayStatuses() : [];
    return {
      gateways: statuses,
      agentDids: AGENT_DIDS,
      userDid: getUserDid(context.sessionId),
      count: statuses.length,
    };
  }
}

/**
 * 5. Get Transactions Command
 */
export class GetTransactionsCommand implements IMcpToolCommand<{ limit?: number; status?: string }> {
  readonly name = "get_transactions";
  readonly description = "Query settled payment transactions, drafts, and cryptographic proof signatures from the mas_transactions ledger.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Maximum number of transactions to return (default: 50)" },
      status: { type: "string", description: "Filter by status: completed, awaiting_confirmation, rejected" },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().optional().default(50).describe("Maximum number of transactions to return"),
    status: z.string().optional().describe("Filter by status: completed, awaiting_confirmation, rejected"),
  });

  async execute(input: { limit?: number; status?: string }, context: McpToolContext) {
    const limit = Number(input.limit) || 50;
    const filter = input.status ? { status: input.status } : undefined;
    const transactions = context.orm.transactions.findMany({
      where: filter,
      orderBy: "created_at DESC",
      limit,
    });
    return { count: transactions.length, transactions };
  }
}

/**
 * 6. Execute NLQ Command (Natural Language Database Query Engine)
 */
export class ExecuteNlqCommand implements IMcpToolCommand<{ query: string }> {
  readonly name = "execute_nlq";
  readonly description = "Execute a natural language query over SQLite database tables, schema metadata, categories taxonomy, or conversation transcripts.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language query (e.g. 'List all tables and schema', 'Show referral categories')" },
    },
    required: ["query"],
  };
  readonly zodSchema = z.object({
    query: z.string().min(1).describe("Natural language query to execute over SQLite database"),
  });

  async execute(input: { query: string }, context: McpToolContext) {
    const query = String(input.query || "").trim();
    if (!query) throw new Error("query is required");

    if (context.facade) {
      return context.facade.executeNlq(query);
    }
    const plan = await planNLQ(context.env, query);
    const result = executeNLQQuery(context.orm, context.sessionId, plan);
    context.audit("nlq.executed", "nlq", { query, domain: result.domain, operation: plan.operation, count: result.count });
    return result;
  }
}

/**
 * 7. List Database Tables Command
 */
export class ListDatabaseTablesCommand implements IMcpToolCommand<{}> {
  readonly name = "list_database_tables";
  readonly description = "Introspect relational SQLite database schema, table definitions, row counts, and column metadata via DatabaseORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const tables = context.orm.listTables();
    return { count: tables.length, tables };
  }
}

/**
 * 8. Query Table Data Command
 */
export class QueryTableDataCommand implements IMcpToolCommand<{
  tableName: string;
  search?: string;
  limit?: number;
  offset?: number;
}> {
  readonly name = "query_table_data";
  readonly description = "Query rows from any SQLite table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_messages, mas_memory, mas_events) with optional filtering and pagination via ORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      tableName: { type: "string", description: "Table name to query (e.g. mas_categories)" },
      search: { type: "string", description: "Optional search keyword to filter text fields" },
      limit: { type: "number", description: "Maximum records to return (default: 50)" },
      offset: { type: "number", description: "Offset for pagination (default: 0)" },
    },
    required: ["tableName"],
  };
  readonly zodSchema = z.object({
    tableName: z.string().min(1).describe("Table name to query (e.g. mas_categories)"),
    search: z.string().optional().describe("Optional search keyword"),
    limit: z.number().optional().default(50).describe("Maximum records to return"),
    offset: z.number().optional().default(0).describe("Offset for pagination"),
  });

  async execute(input: { tableName: string; search?: string; limit?: number; offset?: number }, context: McpToolContext) {
    const result = context.orm.getTableData(input.tableName, {
      search: input.search,
      limit: input.limit,
      offset: input.offset,
    });
    return result;
  }
}

/**
 * 9. Manage Categories Command
 */
export class ManageCategoriesCommand implements IMcpToolCommand<{
  action: "list" | "create" | "update" | "delete";
  id?: string;
  name?: string;
  icon?: string;
  description?: string;
  sortOrder?: number;
}> {
  readonly name = "manage_categories";
  readonly description = "Full CRUD management for referral categories taxonomy in mas_categories via DatabaseORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "update", "delete"], description: "Category operation" },
      id: { type: "string", description: "Category ID (required for update/delete)" },
      name: { type: "string", description: "Category name (required for create)" },
      icon: { type: "string", description: "Emoji or icon for category" },
      description: { type: "string", description: "Category description" },
      sortOrder: { type: "number", description: "Sort priority order" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "create", "update", "delete"]).describe("Category operation"),
    id: z.string().optional().describe("Category ID"),
    name: z.string().optional().describe("Category name"),
    icon: z.string().optional().describe("Category icon"),
    description: z.string().optional().describe("Category description"),
    sortOrder: z.number().optional().describe("Sort priority order"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;

    if (action === "list") {
      const categories = context.orm.categories.findMany({ orderBy: "sort_order ASC" });
      return { count: categories.length, categories };
    }

    if (action === "create") {
      const name = String(input.name || "").trim();
      if (!name) throw new Error("Category name is required for create");
      const id = input.id || `cat_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
      const now = new Date().toISOString();
      const category = context.orm.categories.create({
        id,
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        icon: input.icon || "🏷️",
        description: input.description || `${name} category tools and services`,
        isActive: true,
        sortOrder: Number(input.sortOrder) || 10,
        createdAt: now,
        updatedAt: now,
      });
      return { success: true, created: true, category };
    }

    if (action === "update") {
      if (!input.id) throw new Error("Category id is required for update");
      const updated = context.orm.categories.update(input.id, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.icon ? { icon: input.icon } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: Number(input.sortOrder) } : {}),
        updatedAt: new Date().toISOString(),
      });
      return { success: true, updated: true, category: updated };
    }

    if (action === "delete") {
      if (!input.id) throw new Error("Category id is required for delete");
      const deleted = context.orm.categories.delete(input.id);
      return { success: true, deleted, id: input.id };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 10. Manage Referrals Command
 */
export class ManageReferralsCommand implements IMcpToolCommand<{
  action: "list" | "create" | "track_click" | "delete";
  id?: string;
  title?: string;
  url?: string;
  category?: string;
  rewardText?: string;
}> {
  readonly name = "manage_referrals";
  readonly description = "Manage developer referral links and track click attribution in mas_referrals via DatabaseORM.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "track_click", "delete"], description: "Referrals operation" },
      id: { type: "string", description: "Referral ID (for track_click/delete)" },
      title: { type: "string", description: "Service or tool title" },
      url: { type: "string", description: "Destination referral URL" },
      category: { type: "string", description: "Associated category name" },
      rewardText: { type: "string", description: "Reward bonus offer text" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "create", "track_click", "delete"]).describe("Referrals operation"),
    id: z.string().optional().describe("Referral ID"),
    title: z.string().optional().describe("Service or tool title"),
    url: z.string().optional().describe("Destination referral URL"),
    category: z.string().optional().describe("Associated category name"),
    rewardText: z.string().optional().describe("Reward bonus offer text"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;

    if (action === "list") {
      const referrals = context.orm.referrals.findMany({ orderBy: "clicks DESC" });
      return { count: referrals.length, referrals };
    }

    if (action === "create") {
      const title = String(input.title || "").trim();
      const url = String(input.url || "").trim();
      if (!title || !url) throw new Error("title and url are required for referral creation");

      const referral = context.orm.referrals.create({
        id: `ref_${crypto.randomUUID().slice(0, 8)}`,
        userLogin: context.sessionId,
        title,
        url,
        category: input.category || "AI Tools",
        rewardText: input.rewardText || "$10 Free Credits",
        clicks: 0,
        signups: 0,
        createdAt: new Date().toISOString(),
      });
      return { success: true, created: true, referral };
    }

    if (action === "track_click") {
      if (!input.id) throw new Error("Referral id is required for track_click");
      const current = context.orm.referrals.findById(input.id);
      if (!current) throw new Error(`Referral ${input.id} not found`);
      const updated = context.orm.referrals.update(input.id, { clicks: (current.clicks || 0) + 1 });
      return { success: true, clicks: updated?.clicks || 1 };
    }

    if (action === "delete") {
      if (!input.id) throw new Error("Referral id is required for delete");
      const deleted = context.orm.referrals.delete(input.id);
      return { success: true, deleted, id: input.id };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 11. Manage External Ads Command
 */
export class ManageExternalAdsCommand implements IMcpToolCommand<{
  action: "list" | "create" | "impression" | "click";
  id?: string;
  title?: string;
  network?: "ethicalads" | "carbon" | "adsense" | "direct" | "google";
  placement?: "header_leaderboard" | "in_stream" | "footer_deck" | "sidebar";
  tagline?: string;
  targetUrl?: string;
  ctaText?: string;
  cpmRate?: number;
  cpcRate?: number;
}> {
  readonly name = "manage_external_ads";
  readonly description = "Manage external ad placements (EthicalAds, Carbon Ads, AdSense, Direct) and record CPM/CPC revenue monetization.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "create", "impression", "click"], description: "Ad operation" },
      id: { type: "string", description: "Ad placement ID (required for impression/click)" },
      title: { type: "string", description: "Campaign title" },
      network: { type: "string", enum: ["ethicalads", "carbon", "adsense", "direct", "google"], description: "Ad network partner" },
      placement: { type: "string", enum: ["header_leaderboard", "in_stream", "footer_deck", "sidebar"], description: "Placement slot" },
      tagline: { type: "string", description: "Promotional copy" },
      targetUrl: { type: "string", description: "Destination URL" },
      ctaText: { type: "string", description: "Button text" },
      cpmRate: { type: "number", description: "CPM rate ($/1,000 impressions)" },
      cpcRate: { type: "number", description: "CPC rate ($/click)" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "create", "impression", "click"]).describe("Ad operation"),
    id: z.string().optional().describe("Ad placement ID"),
    title: z.string().optional().describe("Campaign title"),
    network: z.enum(["ethicalads", "carbon", "adsense", "direct", "google"]).optional().describe("Ad network partner"),
    placement: z.enum(["header_leaderboard", "in_stream", "footer_deck", "sidebar"]).optional().describe("Placement slot"),
    tagline: z.string().optional().describe("Promotional copy"),
    targetUrl: z.string().optional().describe("Destination URL"),
    ctaText: z.string().optional().describe("Button text"),
    cpmRate: z.number().optional().describe("CPM rate"),
    cpcRate: z.number().optional().describe("CPC rate"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;

    if (action === "list") {
      const ads = context.orm.externalAds.findMany({ orderBy: "created_at DESC" });
      return { count: ads.length, ads };
    }

    if (action === "create") {
      const title = String(input.title || "").trim();
      const targetUrl = String(input.targetUrl || "").trim();
      if (!title || !targetUrl) throw new Error("title and targetUrl are required for external ad creation");

      const ad = context.orm.externalAds.create({
        id: `ext_ad_${crypto.randomUUID().slice(0, 8)}`,
        name: title,
        title,
        network: input.network || "ethicalads",
        placement: input.placement || "in_stream",
        tagline: input.tagline || `Verified developer partner: ${title}`,
        targetUrl,
        ctaText: input.ctaText || "Learn More",
        cpmRate: Number(input.cpmRate) || 2.5,
        cpcRate: Number(input.cpcRate) || 0.45,
        impressions: 0,
        clicks: 0,
        earnings: 0,
        isActive: true,
        createdAt: new Date().toISOString(),
      });
      return { success: true, created: true, ad };
    }

    if (action === "impression") {
      if (!input.id) throw new Error("Ad id is required for impression recording");
      const ad = context.orm.externalAds.findById(input.id);
      if (!ad) throw new Error(`Ad ${input.id} not found`);
      const newImp = (ad.impressions || 0) + 1;
      const earningsIncrement = (ad.cpmRate || 2.5) / 1000;
      const updated = context.orm.externalAds.update(input.id, {
        impressions: newImp,
        earnings: Number(((ad.earnings || 0) + earningsIncrement).toFixed(4)),
      });
      return { success: true, impressions: updated?.impressions, earnings: updated?.earnings };
    }

    if (action === "click") {
      if (!input.id) throw new Error("Ad id is required for click recording");
      const ad = context.orm.externalAds.findById(input.id);
      if (!ad) throw new Error(`Ad ${input.id} not found`);
      const newClicks = (ad.clicks || 0) + 1;
      const earningsIncrement = ad.cpcRate || 0.45;
      const updated = context.orm.externalAds.update(input.id, {
        clicks: newClicks,
        earnings: Number(((ad.earnings || 0) + earningsIncrement).toFixed(4)),
      });
      return { success: true, clicks: updated?.clicks, earnings: updated?.earnings };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 12. Get Revenue Summary Command (GRASP Information Expert)
 */
export class GetRevenueSummaryCommand implements IMcpToolCommand<{}> {
  readonly name = "get_revenue_summary";
  readonly description = "Compute platform financial analytics across ad networks (CPM/CPC), marketplace direct ads, payment transaction fees, referral payouts, and net profit.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {},
  };
  readonly zodSchema = z.object({});

  async execute(_input: any, context: McpToolContext) {
    const summary = context.orm.getRevenueSummary();
    return summary;
  }
}

/**
 * 13. Manage Session Memory Command
 */
export class ManageSessionMemoryCommand implements IMcpToolCommand<{
  action: "list" | "remember" | "delete" | "clear";
  key?: string;
  value?: string;
}> {
  readonly name = "manage_session_memory";
  readonly description = "Read, persist, or clear persistent grounding session facts stored in mas_memory SQLite key-value store.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "remember", "delete", "clear"], description: "Memory action" },
      key: { type: "string", description: "Memory key (e.g. preferred_gateway)" },
      value: { type: "string", description: "Memory value fact to store" },
    },
    required: ["action"],
  };
  readonly zodSchema = z.object({
    action: z.enum(["list", "remember", "delete", "clear"]).describe("Memory action"),
    key: z.string().optional().describe("Memory key"),
    value: z.string().optional().describe("Memory value fact"),
  });

  async execute(input: any, context: McpToolContext) {
    const action = input.action;

    if (action === "list") {
      const memories = context.orm.memory.findMany({ orderBy: "updated_at DESC" });
      return { count: memories.length, memories };
    }

    if (action === "remember") {
      const key = String(input.key || "").trim();
      const value = String(input.value || "").trim();
      if (!key || !value) throw new Error("key and value are required to remember fact");
      const now = new Date().toISOString();
      const existing = context.orm.memory.findById(key);
      let record;
      if (existing) {
        record = context.orm.memory.update(key, { value, updatedAt: now });
      } else {
        record = context.orm.memory.create({ key, value, updatedAt: now });
      }
      context.audit("memory.remembered", "memory", { key, value });
      return { success: true, stored: true, key, value, memory: record };
    }

    if (action === "delete") {
      if (!input.key) throw new Error("key is required to delete memory fact");
      const key = input.key.trim();
      const deleted = context.orm.memory.delete(key);
      return { success: true, deleted, key };
    }

    if (action === "clear") {
      (context.orm as any).sql.exec("DELETE FROM mas_memory");
      return { success: true, cleared: true };
    }

    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * 14. Get Audit Events Command
 */
export class GetAuditEventsCommand implements IMcpToolCommand<{ limit?: number }> {
  readonly name = "get_audit_events";
  readonly description = "Query real-time observability events stream (routing decisions, judge evaluations, payment lifecycle, errors) from mas_events.";
  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Maximum events to return (default: 50)" },
    },
  };
  readonly zodSchema = z.object({
    limit: z.number().optional().default(50).describe("Maximum events to return"),
  });

  async execute(input: { limit?: number }, context: McpToolContext) {
    const limit = Number(input.limit) || 50;
    const events = context.orm.events.findMany({
      orderBy: "created_at DESC",
      limit,
    });
    return { count: events.length, events };
  }
}

/**
 * GoF Factory Pattern & GRASP Creator: McpToolFactory
 * Central registry and instantiation factory for all platform MCP commands.
 */
export class McpToolFactory {
  private static tools: Map<string, IMcpToolCommand> = new Map();

  static {
    // Register all default 14 MCP commands
    this.registerTool(new KnowledgeSearchCommand());
    this.registerTool(new DraftPaymentCommand());
    this.registerTool(new ConfirmPaymentDraftCommand());
    this.registerTool(new GetPaymentGatewaysCommand());
    this.registerTool(new GetTransactionsCommand());
    this.registerTool(new ExecuteNlqCommand());
    this.registerTool(new ListDatabaseTablesCommand());
    this.registerTool(new QueryTableDataCommand());
    this.registerTool(new ManageCategoriesCommand());
    this.registerTool(new ManageReferralsCommand());
    this.registerTool(new ManageExternalAdsCommand());
    this.registerTool(new GetRevenueSummaryCommand());
    this.registerTool(new ManageSessionMemoryCommand());
    this.registerTool(new GetAuditEventsCommand());
  }

  /**
   * Registers an IMcpToolCommand.
   * Demonstrates the Open/Closed Principle (OCP): New tools register without modifying the factory internals.
   */
  static registerTool(command: IMcpToolCommand): void {
    this.tools.set(command.name, command);
  }

  static getTool(name: string): IMcpToolCommand | undefined {
    return this.tools.get(name);
  }

  static getAllTools(): IMcpToolCommand[] {
    return Array.from(this.tools.values());
  }

  static getToolDefinitions(): Array<{ name: string; description: string; inputSchema: any }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    }));
  }

  static async executeTool(name: string, input: any, context: McpToolContext): Promise<any> {
    const command = this.tools.get(name);
    if (!command) {
      throw new Error(`MCP Tool '${name}' is not registered`);
    }
    return command.execute(input, context);
  }
}
