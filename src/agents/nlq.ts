import { generateText } from "ai";
import { getWorkersAIModel } from "./model";
import { z } from "zod";
import type { Env } from "../types";

export const nlqPlanSchema = z.object({
  operation: z.enum(["list", "count", "search"]),
  terms: z.string().max(200).default(""),
  role: z.enum(["user", "assistant", "any"]).default("any"),
  since: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(25),
});

export type NLQPlan = z.infer<typeof nlqPlanSchema>;

export interface NLQQueryResult {
  plan: NLQPlan;
  count: number;
  rows: Array<{
    id?: string;
    role?: string;
    content?: string;
    agent?: string;
    created_at?: string;
    count?: number;
  }>;
  executedAt: string;
}

export async function planNLQ(env: Env, question: string): Promise<NLQPlan> {
  const model = getWorkersAIModel(env);
  try {
    const { text } = await generateText({
      model,
      temperature: 0,
      system: `Convert a user's natural language question about their conversation history into a structured read-only JSON query plan.
Valid operations:
- 'count': if asking how many / total messages.
- 'search': if looking for specific topics, words, or questions.
- 'list': if asking to see recent messages or transcript.

Rules:
- Never generate SQL syntax directly.
- Terms should extract the core keyword or phrase to search.
- Role should be 'user', 'assistant', or 'any'.
- Use ISO-8601 for 'since' if an explicit date is mentioned, otherwise null.
- Default limit is 25 (max 100).

Return JSON only:
{"operation": "list"|"count"|"search", "terms": "...", "role": "any"|"user"|"assistant", "since": null|"YYYY-MM-DD", "limit": 25}`,
      prompt: question.slice(0, 2000),
    });

    const cleaned = text.replace(/```(?:json)?([\s\S]*?)```/g, "$1").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return nlqPlanSchema.parse(parsed);
    }
  } catch {
    // Fall back to a default search plan on parse failure
  }

  return {
    operation: question.toLowerCase().includes("how many") || question.toLowerCase().includes("count") ? "count" : "search",
    terms: question.slice(0, 100),
    role: "any",
    since: null,
    limit: 25,
  };
}

export function queryConversation(sql: { exec: (query: string, ...args: unknown[]) => Iterable<unknown> }, sessionId: string, plan: NLQPlan): NLQQueryResult {
  const clauses: string[] = ["session_id = ?"];
  const args: unknown[] = [sessionId];

  if (plan.role !== "any") {
    clauses.push("role = ?");
    args.push(plan.role);
  }

  if (plan.terms && plan.terms.trim()) {
    clauses.push("lower(content) LIKE ?");
    args.push(`%${plan.terms.trim().toLowerCase()}%`);
  }

  if (plan.since) {
    clauses.push("created_at >= ?");
    args.push(plan.since);
  }

  const where = clauses.join(" AND ");

  let rows: NLQQueryResult["rows"] = [];

  if (plan.operation === "count") {
    const raw = Array.from(sql.exec(`SELECT COUNT(*) AS count FROM mas_messages WHERE ${where}`, ...args)) as Array<{ count: number }>;
    const total = raw[0]?.count ?? 0;
    rows = [{ count: total }];
    return {
      plan,
      count: total,
      rows,
      executedAt: new Date().toISOString(),
    };
  }

  args.push(plan.limit);
  rows = Array.from(
    sql.exec(
      `SELECT id, role, content, agent, created_at FROM mas_messages WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      ...args
    )
  ) as NLQQueryResult["rows"];

  return {
    plan,
    count: rows.length,
    rows,
    executedAt: new Date().toISOString(),
  };
}
