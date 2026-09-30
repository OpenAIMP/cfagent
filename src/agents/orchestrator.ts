import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import { LLMJudge } from "./judge";
import type { Env, AgentName } from "../types";

export class OrchestratorAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const judge = new LLMJudge(this.env);
    const lastUser = this.messages.filter((m: any) => m.role === "user").at(-1);
    const text = lastUser?.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("") || "";
    const decision = !text ? { agent: "general" as const, confidence: 0.5, reason: "No user message found.", needsConfirmation: false } : await judge.route(text);

    const model = createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.1-8b-instruct");

    const tools: Record<string, any> = {
      searchKnowledge: tool({
        description: "Search the knowledge base for a user question.",
        parameters: z.object({ query: z.string().min(1).max(500) }),
        execute: async ({ query }) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          try {
            const response = await fetch(`${this.env.AI_SEARCH_ENDPOINT}/search`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ messages: [{ role: "user", content: query }] }),
              signal: controller.signal,
            });
            if (!response.ok) return { error: `Search failed (${response.status})` };
            return { query, results: await response.json() };
          } catch (error) {
            return { error: error instanceof Error ? error.message : "Search request failed" };
          } finally {
            clearTimeout(timeout);
          }
        },
      }),
      draftPayment: tool({
        description: "Draft a payment action without moving money.",
        parameters: z.object({ action: z.enum(["charge", "refund", "invoice"]), amount: z.number().positive().max(100000), currency: z.string().min(3).max(3).default("USD"), customer: z.string().min(1).max(200) }),
        execute: async (input) => ({ status: "awaiting_confirmation", ...input, message: "No money moved. User confirmation required before any real payment action." }),
      }),
      createTaskDraft: tool({
        description: "Draft a task for the user to confirm.",
        parameters: z.object({ title: z.string().min(1).max(300), dueDate: z.string().optional(), priority: z.enum(["low", "medium", "high"]).default("medium") }),
        execute: async (input) => ({ status: "draft", ...input, message: "Task drafted and waiting for confirmation." }),
      }),
      rememberFact: tool({
        description: "Remember a fact for later use in this session.",
        parameters: z.object({ key: z.string().min(1).max(100), value: z.string().min(1).max(1000) }),
        execute: async ({ key, value }) => {
          await this.env.KV.put(`memory:${this.ctx.id.toString()}:${key}`, value);
          return { stored: true, key, value };
        },
      }),
    };

    const result = streamText({
      model,
      system: `You are the orchestrator of a multi-agent system. Route to the specialized tool that matches the user message. Use search for facts, drafts for payments, drafts for tasks, and memory for important context. Be concise, safe, and do not fake actions. Decision: ${decision.agent}; confidence: ${decision.confidence}; reason: ${decision.reason}.`,
      messages: await convertToModelMessages(this.messages),
      maxSteps: Number(this.env.MAS_MAX_STEPS || 4),
      tools,
    });

    return result.toUIMessageStreamResponse();
  }
}
