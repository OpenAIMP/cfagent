import { tool } from "ai";
import { z } from "zod";
import type { AgentName, Env } from "../types";

export interface MASOptions {
  env: Env;
  sessionId: string;
  requestId: string;
  sql: { exec: (query: string, ...args: unknown[]) => Iterable<unknown> };
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
}

export function createMAS({ env, sessionId, requestId, sql, audit }: MASOptions) {
  const searchKnowledge = tool({
    description: "Search the organization's knowledge base using Cloudflare AI Search RAG. Use for factual inquiries, documented product features, release notes, or policies.",
    inputSchema: z.object({
      query: z.string().min(1).max(500).describe("The concise search query or topic to retrieve documents for"),
    }),
    execute: async ({ query }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${env.AI_SEARCH_ENDPOINT}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errMsg = `Knowledge search upstream returned ${response.status}`;
          audit("search.failed", "search", { query, status: response.status });
          return { error: errMsg, query };
        }

        const data: unknown = await response.json();
        audit("search.completed", "search", { query, resultsFound: Boolean(data) });
        return {
          query,
          results: data,
          source: "Cloudflare AI Search",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Search request failed";
        audit("search.error", "search", { query, error: message });
        return { error: message, query };
      } finally {
        clearTimeout(timeout);
      }
    },
  });

  const draftPayment = tool({
    description: "Draft a payment operation (charge, refund, invoice, or payout). Safety guarantee: This tool NEVER executes actual monetary transactions; it only creates an authorization draft pending human approval.",
    inputSchema: z.object({
      action: z.enum(["charge", "refund", "invoice", "payout"]).describe("The financial operation to draft"),
      amount: z.number().positive().max(100000).describe("Monetary amount"),
      currency: z.string().length(3).default("USD").describe("Three-letter ISO currency code, e.g. USD, EUR, GBP"),
      customer: z.string().min(1).max(200).describe("Customer name or account identifier"),
      note: z.string().optional().describe("Optional note or reference for the payment"),
    }),
    execute: async (input) => {
      const draftId = `pay_${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        draftId,
        requestId,
        status: "awaiting_confirmation",
        requiresConfirmation: true,
        ...input,
        securityNotice: "NO FUNDS HAVE BEEN MOVED. An authorized human must cryptographically approve this operation before any real charge occurs.",
      };
      audit("payment.awaiting_confirmation", "payments", payload);
      return payload;
    },
  });

  const createTaskDraft = tool({
    description: "Draft a task or reminder for the user or organization. Returns a structured task proposal for user confirmation.",
    inputSchema: z.object({
      title: z.string().min(1).max(300).describe("Task title or summary"),
      dueDate: z.string().optional().describe("Optional target deadline or ISO date"),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium").describe("Urgency level"),
      assignee: z.string().optional().describe("Assignee name or role"),
    }),
    execute: async (input) => {
      const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        taskId,
        status: "draft",
        requiresConfirmation: true,
        ...input,
        message: "Task draft created. Prompt the user for approval or modifications.",
      };
      audit("task.drafted", "tasks", payload);
      return payload;
    },
  });

  const rememberFact = tool({
    description: "Persist a key fact, user preference, or project context into durable SQLite memory for this user session.",
    inputSchema: z.object({
      key: z.string().min(1).max(100).describe("Descriptive memory key (e.g. 'preferred_tone', 'client_project')"),
      value: z.string().min(1).max(2000).describe("The information to store"),
    }),
    execute: async ({ key, value }) => {
      const normalizedKey = key.trim().toLowerCase();
      const now = new Date().toISOString();
      sql.exec(
        "INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        normalizedKey,
        value,
        now
      );
      audit("memory.remembered", "memory", { key: normalizedKey, value });
      return { stored: true, key: normalizedKey, value, updatedAt: now };
    },
  });

  const recallFacts = tool({
    description: "Recall all stored memory facts and user preferences recorded during this session.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Optional keyword to filter stored memories"),
    }),
    execute: async ({ filter }) => {
      let facts: Array<{ key: string; value: string; updated_at: string }> = [];
      if (filter && filter.trim()) {
        facts = Array.from(
          sql.exec(
            "SELECT key, value, updated_at FROM mas_memory WHERE lower(key) LIKE ? OR lower(value) LIKE ? ORDER BY updated_at DESC LIMIT 50",
            `%${filter.toLowerCase()}%`,
            `%${filter.toLowerCase()}%`
          )
        ) as Array<{ key: string; value: string; updated_at: string }>;
      } else {
        facts = Array.from(
          sql.exec("SELECT key, value, updated_at FROM mas_memory ORDER BY updated_at DESC LIMIT 50")
        ) as Array<{ key: string; value: string; updated_at: string }>;
      }
      audit("memory.recalled", "memory", { count: facts.length, filter });
      return { count: facts.length, facts };
    },
  });

  return {
    searchKnowledge,
    draftPayment,
    createTaskDraft,
    rememberFact,
    recallFacts,
  };
}
