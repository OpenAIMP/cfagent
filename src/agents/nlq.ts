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

const STOP_WORDS_REGEX = /\b(questions?|messages?|chats?|history|transcript|conversations?|asked|queries|all|results?|references?|containing|contains|with|for|about|find|show|list|get|any|where|me)\b/gi;

export async function planNLQ(env: Env, question: string): Promise<NLQPlan> {
  const model = getWorkersAIModel(env);
  try {
    const { text } = await generateText({
      model,
      temperature: 0,
      system: `Convert a user's natural language question about their conversation history into a structured read-only JSON query plan.
Valid operations:
- 'count': if asking how many / total messages or questions.
- 'list': if asking to see messages, user questions, assistant answers, or chat history.
- 'search': if looking for specific topics, words, or domain subjects (e.g. 'pricing', 'payment', 'SOC2').

Crucial Rules for 'terms':
- 'terms' must ONLY contain specific topical search keywords (e.g. 'pricing', 'refund', 'workers', 'dark mode', 'search', 'acme').
- If the user asks for 'all questions', 'user questions', 'messages', 'chat history', 'prompts', or 'search results', strip meta words like 'results', 'messages', 'questions', 'containing'.
- If asking about user questions or prompts, set role: 'user' and terms: "".
- If asking about assistant responses or answers, set role: 'assistant' and terms: "".
- If asking about all messages or transcript, set role: 'any' and terms: "".
- Default limit is 25 (max 100).

Return JSON only:
{"operation": "list"|"count"|"search", "terms": "", "role": "any"|"user"|"assistant", "since": null|"YYYY-MM-DD", "limit": 25}`,
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
    // Fall back to a default search plan on parse failure
  }

  const isCount = /\b(how many|count|total)\b/i.test(question);
  const isAssistant = /\b(assistant|bot|responses?|answers?)\b/i.test(question);
  const isUser = /\b(user|questions?|prompts?|i asked|i said)\b/i.test(question);
  const cleanTerms = question.replace(STOP_WORDS_REGEX, " ").trim();

  return {
    operation: isCount ? "count" : "list",
    terms: cleanTerms.slice(0, 100),
    role: isAssistant ? "assistant" : isUser ? "user" : "any",
    since: null,
    limit: 25,
  };
}

export function queryConversation(sql: { exec: (query: string, ...args: unknown[]) => Iterable<unknown> }, sessionId: string, plan: NLQPlan): NLQQueryResult {
  const clauses: string[] = ["session_id = ?"];
  const args: unknown[] = [sessionId];

  if (plan.role && plan.role !== "any") {
    clauses.push("role = ?");
    args.push(plan.role);
  }

  // Defensively strip conversational stop words so meta-terms don't block SQL matching
  const cleanTerms = (plan.terms || "").replace(STOP_WORDS_REGEX, " ").trim();

  // Split into keyword tokens to allow matching across words and agent column
  const keywords = cleanTerms
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length > 1);

  if (keywords.length > 0) {
    for (const kw of keywords) {
      clauses.push("(lower(content) LIKE ? OR lower(agent) LIKE ?)");
      args.push(`%${kw}%`, `%${kw}%`);
    }
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
