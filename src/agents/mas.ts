import { tool } from "ai";
import { z } from "zod";
import type { AgentName, Env } from "../types";

export function createMAS(env: Env, sessionId: string, requestId: string, audit: (type: string, agent: AgentName, payload: Record<string, unknown>) => void) {
  const search = tool({
    description: "Search the organization's knowledge base. Use for documented facts.",
    parameters: z.object({ query: z.string().min(1).max(500) }),
    execute: async ({ query }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${env.AI_SEARCH_ENDPOINT}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: query }] }), signal: controller.signal });
        if (!response.ok) return { error: `Knowledge search failed (${response.status})` };
        const result = await response.json();
        audit("tool.completed", "search", { query, result });
        return { query, result };
      } catch (error) { return { error: error instanceof Error ? error.message : "Search failed" }; }
      finally { clearTimeout(timeout); }
    },
  });
  const payments = tool({
    description: "Prepare a payment operation. This tool never charges or refunds; an explicit confirmation and a separately authenticated payment service are required.",
    parameters: z.object({ action: z.enum(["charge", "refund", "invoice"]), amount: z.number().positive().max(100000), currency: z.string().length(3).default("USD"), customer: z.string().min(1) }),
    execute: async (input) => { audit("payment.awaiting_confirmation", "payments", input); return { status: "awaiting_confirmation", requestId, ...input, message: "No money movement occurred. Confirm this operation explicitly to continue." }; },
  });
  const tasks = tool({
    description: "Draft a task. A task is not persisted until the user confirms it.",
    parameters: z.object({ title: z.string().min(1).max(300), due: z.string().optional(), priority: z.enum(["low", "medium", "high"]).default("medium") }),
    execute: async (input) => { audit("task.drafted", "tasks", input); return { status: "draft", ...input, message: "Task drafted; ask the user for confirmation before persisting it." }; },
  });
  return { search, payments, tasks };
}
