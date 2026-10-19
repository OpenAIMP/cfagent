import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { getWorkersAIModel } from "./model";
import type { Env } from "../types";
// Issue #278: single-owner TTL cache for AI Search queries + durable
// scheduled-run reports searchable through this same path.
import { getAiSearchCache, aiSearchCacheKey } from "../services/aiSearchCache";
import { searchScheduledReports } from "../services/scheduledReports";

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
              // Issue #278: bounded in-isolate TTL cache, keyed by query +
              // session scope. Only successful results are cached; errors
              // never are.
              const cache = getAiSearchCache(this.env);
              const scope =
                typeof (this as any).sessionKey === "function"
                  ? (this as any).sessionKey()
                  : "default";
              const cacheKey = aiSearchCacheKey(query, scope);
              const cached = cache.get(cacheKey);
              if (cached !== undefined) {
                return cached;
              }
              // Issue #278: durable scheduled-run reports from this
              // instance's mas_reports table, surfaced alongside upstream
              // results. `reports` is additive — the upstream `results`
              // shape is unchanged.
              const reports = searchScheduledReports(this.ctx.storage.sql, query, 5);
              const reportItems = reports.map((r) => ({
                title: r.title,
                snippet: r.summary,
                source: "scheduled_report",
                reportId: r.id,
                createdAt: r.createdAt,
              }));
              if (!this.env.AI_SEARCH_ENDPOINT) {
                const result = {
                  query,
                  results: reportItems,
                  reportCount: reportItems.length,
                  notice:
                    reportItems.length > 0
                      ? "AI_SEARCH_ENDPOINT is not configured; showing stored scheduled-run reports."
                      : "AI_SEARCH_ENDPOINT is not configured; using platform knowledge base.",
                };
                cache.set(cacheKey, result);
                return result;
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
                  // Upstream failed: still surface local reports honestly.
                  if (reportItems.length > 0) {
                    const result = {
                      query,
                      results: reportItems,
                      reportCount: reportItems.length,
                      notice: `Search failed: ${response.status}; showing stored scheduled-run reports.`,
                    };
                    cache.set(cacheKey, result);
                    return result;
                  }
                  return { error: `Search failed: ${response.status}` };
                }

                const data = await response.json();
                const result = {
                  query,
                  results: data,
                  reports: reportItems,
                  reportCount: reportItems.length,
                };
                cache.set(cacheKey, result);
                return result;
              } catch (error) {
                if (reportItems.length > 0) {
                  const result = {
                    query,
                    results: reportItems,
                    reportCount: reportItems.length,
                    notice: `Search request failed (${error instanceof Error ? error.message : "unknown"}); showing stored scheduled-run reports.`,
                  };
                  cache.set(cacheKey, result);
                  return result;
                }
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
