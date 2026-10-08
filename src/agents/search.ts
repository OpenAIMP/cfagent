import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { getWorkersAIModel } from "./model";
import type { Env } from "../types";

export class SearchAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    try {
      const model = getWorkersAIModel(this.env, "searchAgent");

      const result = streamText({
        model,
        system: `You are a search specialist and financial knowledge assistant. Answer questions clearly. When searching the knowledge base, use the search tool if search endpoints are available. If search is not configured or fails, provide helpful guidance based on known platform capabilities and market data endpoints.`,
        messages: await convertToModelMessages(this.messages),
        stopWhen: stepCountIs(3),
        tools: {
          search: tool({
            description: "Search the knowledge base for relevant content.",
            inputSchema: z.object({
              query: z.string().min(1).max(500),
            }),
            execute: async ({ query }) => {
              if (!this.env.AI_SEARCH_ENDPOINT) {
                return { query, results: [], notice: "AI_SEARCH_ENDPOINT is not configured; using platform knowledge base." };
              }
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
    } catch (err) {
      console.error("[SearchAgent] onChatMessage error:", err);
      // Fallback: stream a graceful error message without crashing the WebSocket
      const fallbackResult = streamText({
        model: getWorkersAIModel(this.env, "searchAgent"),
        prompt: `The user sent a query, but search service encountered a temporary error: ${err instanceof Error ? err.message : String(err)}. Provide a helpful greeting and summarize how to use the stock screener, options research, or trading desk tabs.`,
      });
      return fallbackResult.toUIMessageStreamResponse();
    }
  }
}
