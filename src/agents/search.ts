import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../types";

export class SearchAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.1-8b-instruct");

    const result = streamText({
      model,
      system: `You are a search specialist for a knowledge base. Use the search tool when the user asks for factual information that may be present in the knowledge base. Do not search for greetings or small chat. When there are no results, say so clearly and suggest adding documents.`,
      messages: await convertToModelMessages(this.messages),
      stopWhen: stepCountIs(3),
      tools: {
        search: tool({
          description: "Search the knowledge base for relevant content.",
          inputSchema: z.object({
            query: z.string().min(1).max(500),
          }),
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

              if (!response.ok) {
                return { error: `Search failed: ${response.status}` };
              }

              const data = await response.json();
              return { query, results: data };
            } catch (error) {
              return { error: error instanceof Error ? error.message : "Search request failed" };
            } finally {
              clearTimeout(timeout);
            }
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
