import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
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

export async function planNLQ(env: Env, question: string): Promise<NLQPlan> {
  const model = createWorkersAI({ binding: env.AI })("@cf/meta/llama-3.1-8b-instruct");
  const { text } = await generateText({
    model,
    temperature: 0,
    system: `Convert a user's read-only question about this conversation into JSON. Never create SQL. Use ISO-8601 for since when a date is explicit; otherwise null. ${JSON.stringify(nlqPlanSchema.shape)}`,
    prompt: question.slice(0, 2000),
  });
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return nlqPlanSchema.parse(match ? JSON.parse(match[0]) : {});
  } catch {
    return { operation: "search", terms: question.slice(0, 200), role: "any", since: null, limit: 25 };
  }
}

export function queryConversation(sql: any, plan: NLQPlan): Record<string, unknown> {
  const clauses = ["session_id = ?"];
  const args: unknown[] = [sql.__sessionId];
  if (plan.role !== "any") { clauses.push("role = ?"); args.push(plan.role); }
  if (plan.terms) { clauses.push("lower(content) LIKE ?"); args.push(`%${plan.terms.toLowerCase()}%`); }
  if (plan.since) { clauses.push("created_at >= ?"); args.push(plan.since); }
  const where = clauses.join(" AND ");
  const rows = plan.operation === "count"
    ? Array.from(sql.exec(`SELECT COUNT(*) AS count FROM mas_messages WHERE ${where}`, ...args))
    : Array.from(sql.exec(`SELECT id, role, content, agent, created_at FROM mas_messages WHERE ${where} ORDER BY created_at DESC LIMIT ?`, ...args, plan.limit));
  return { plan, count: rows.length, rows };
}
