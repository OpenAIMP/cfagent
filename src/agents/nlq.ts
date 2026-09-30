import { generateText } from "ai";
import { getWorkersAIModel } from "./model";
import { z } from "zod";
import type { Env } from "../types";
import type { DatabaseORM } from "../orm";

export const nlqPlanSchema = z.object({
  domain: z.enum(["tables", "table_data", "category_mutation", "conversation", "custom_query"]).default("conversation"),
  operation: z.enum(["list", "count", "search", "create", "update"]).default("list"),
  targetTable: z.string().optional(),
  categoryData: z
    .object({
      action: z.enum(["create", "update"]).optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      icon: z.string().optional(),
    })
    .optional(),
  terms: z.string().max(200).default(""),
  role: z.enum(["user", "assistant", "any"]).default("any"),
  since: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
});

export type NLQPlan = z.infer<typeof nlqPlanSchema>;

export interface NLQQueryResult {
  plan: NLQPlan;
  count: number;
  domain: string;
  targetTable?: string;
  summary?: string;
  rows: Array<Record<string, unknown>>;
  executedAt: string;
}

const STOP_WORDS_REGEX = /\b(questions?|messages?|chats?|history|transcript|conversations?|asked|queries|all|results?|references?|containing|contains|with|for|about|find|show|list|get|any|where|me)\b/gi;

export async function planNLQ(env: Env, question: string): Promise<NLQPlan> {
  const model = getWorkersAIModel(env);
  const qLower = question.toLowerCase();

  // Fast-path intent detection for database tables & categories
  if (/\b(tables?|schema|databases?|columns?|catalog)\b/i.test(question) && !/\b(messages?|chats?)\b/i.test(question)) {
    return {
      domain: "tables",
      operation: "list",
      terms: "",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // Fast-path for Category addition or update
  const addCatMatch = question.match(/\b(?:add|create|insert|new)\s+category\s+["']?([^"']+)["']?/i);
  if (addCatMatch) {
    const rawName = addCatMatch[1].trim();
    return {
      domain: "category_mutation",
      operation: "create",
      categoryData: {
        action: "create",
        name: rawName,
        description: `Category for ${rawName} referral and partner links`,
        icon: "🏷️",
      },
      terms: rawName,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // Fast-path for Table data queries
  if (/\b(categories|referrals|ads|external ads|transactions|ledger|events|memory)\b/i.test(question)) {
    let target = "mas_categories";
    if (/\b(referrals?|links?)\b/i.test(question)) target = "mas_referrals";
    else if (/\b(external\s*ads?)\b/i.test(question)) target = "mas_external_ads";
    else if (/\b(ads?|marketplace)\b/i.test(question)) target = "mas_ads";
    else if (/\b(transactions?|payments?|charges?|refunds?)\b/i.test(question)) target = "mas_transactions";
    else if (/\b(events?|audit)\b/i.test(question)) target = "mas_events";
    else if (/\b(memory|facts?)\b/i.test(question)) target = "mas_memory";

    return {
      domain: "table_data",
      operation: "list",
      targetTable: target,
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 50,
    };
  }

  try {
    const { text } = await generateText({
      model,
      temperature: 0,
      system: `You are an NLQ planner for an enterprise multi-agent database over SQLite.
Classify the user's natural language request into a query plan:
Domains:
1. 'tables': if asking to list tables, inspect database schema, or show structure.
2. 'table_data': if asking to view/search records in a specific table (mas_categories, mas_referrals, mas_ads, mas_external_ads, mas_transactions, mas_messages, mas_memory, mas_events).
3. 'category_mutation': if asking to add or update referral categories.
4. 'conversation': if asking questions about past chat messages or user prompts.

Return JSON only:
{
  "domain": "tables"|"table_data"|"category_mutation"|"conversation",
  "operation": "list"|"count"|"search"|"create"|"update",
  "targetTable": "mas_categories"|"mas_referrals"|"mas_ads"|"mas_transactions"|"mas_messages"|"mas_events",
  "terms": "search keyword",
  "role": "any"|"user"|"assistant",
  "limit": 25
}`,
      prompt: question.slice(0, 2000),
    });

    const cleaned = text.replace(/```(?:json)?([\s\S]*?)```/g, "$1").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.terms === "string") {
        parsed.terms = parsed.terms.replace(STOP_WORDS_REGEX, " ").trim();
      }
      return nlqPlanSchema.parse(parsed);
    }
  } catch {
    // Fall back to conversation search
  }

  const isCount = /\b(how many|count|total)\b/i.test(question);
  const isAssistant = /\b(assistant|bot|responses?|answers?)\b/i.test(question);
  const isUser = /\b(user|questions?|prompts?|i asked|i said)\b/i.test(question);
  const cleanTerms = question.replace(STOP_WORDS_REGEX, " ").trim();

  return {
    domain: "conversation",
    operation: isCount ? "count" : "list",
    terms: cleanTerms.slice(0, 100),
    role: isAssistant ? "assistant" : isUser ? "user" : "any",
    since: null,
    limit: 25,
  };
}

export function executeNLQQuery(orm: DatabaseORM, sessionId: string, plan: NLQPlan): NLQQueryResult {
  const executedAt = new Date().toISOString();

  // 1. List Tables & Schema
  if (plan.domain === "tables") {
    const tables = orm.listTables();
    return {
      plan,
      domain: "tables",
      count: tables.length,
      summary: `Found ${tables.length} tables in SQLite database schema.`,
      rows: tables.map((t) => ({
        tableName: t.name,
        rowCount: t.rowCount,
        description: t.description,
        columnCount: t.columns.length,
        columns: t.columns.map((c) => `${c.name} (${c.type}${c.isPrimary ? ", PK" : ""})`).join(", "),
      })),
      executedAt,
    };
  }

  // 2. Add or Update Referral Categories via ORM
  if (plan.domain === "category_mutation") {
    const catName = plan.categoryData?.name || plan.terms || "New Category";
    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const now = new Date().toISOString();
    const id = `cat_${slug.slice(0, 16)}_${crypto.randomUUID().slice(0, 4)}`;

    const created = orm.categories.create({
      id,
      name: catName,
      slug,
      description: plan.categoryData?.description || `Category for ${catName} referrals`,
      icon: plan.categoryData?.icon || "🏷️",
      isActive: true,
      sortOrder: (orm.categories.count() || 0) + 1,
      createdAt: now,
      updatedAt: now,
    });

    const allCategories = orm.categories.findMany({ orderBy: "sort_order ASC" });

    return {
      plan,
      domain: "category_mutation",
      targetTable: "mas_categories",
      count: allCategories.length,
      summary: `Category "${created.name}" created successfully via ORM. Total active categories: ${allCategories.length}.`,
      rows: allCategories.map((c) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        slug: c.slug,
        description: c.description,
        status: c.isActive ? "ACTIVE" : "INACTIVE",
        sortOrder: c.sortOrder,
      })),
      executedAt,
    };
  }

  // 3. Query Specific Table Data via ORM
  if (plan.domain === "table_data") {
    const table = plan.targetTable || "mas_categories";
    const data = orm.getTableData(table, { search: plan.terms, limit: plan.limit });
    return {
      plan,
      domain: "table_data",
      targetTable: table,
      count: data.rows.length,
      summary: `Retrieved ${data.rows.length} rows from ${table} (Total: ${data.total}).`,
      rows: data.rows,
      executedAt,
    };
  }

  // 4. Default: Query Conversation History
  const messages = orm.messages.findMany({
    where: { sessionId },
    orderBy: "created_at DESC",
    limit: 100,
  });

  const cleanTerms = (plan.terms || "").replace(STOP_WORDS_REGEX, " ").trim().toLowerCase();
  const keywords = cleanTerms
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);

  let filtered = messages;
  if (plan.role && plan.role !== "any") {
    filtered = filtered.filter((m) => m.role === plan.role);
  }

  if (keywords.length > 0) {
    filtered = filtered.filter((m) => {
      const content = (m.content || "").toLowerCase();
      const agent = (m.agent || "").toLowerCase();
      return keywords.some((kw) => content.includes(kw) || agent.includes(kw));
    });
  }

  filtered = filtered.slice(0, plan.limit);

  return {
    plan,
    domain: "conversation",
    targetTable: "mas_messages",
    count: filtered.length,
    summary: `Found ${filtered.length} conversation records matching query.`,
    rows: filtered.map((m) => ({
      role: m.role,
      agent: m.agent,
      content: m.content,
      created_at: m.createdAt,
    })),
    executedAt,
  };
}
