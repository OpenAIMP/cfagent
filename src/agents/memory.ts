import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../types";

export class MemoryAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.1-8b-instruct");

    const result = streamText({
      model,
      system: `You are a memory and context agent. Save important facts in a safe, concise way and retrieve them when relevant.`,
      messages: await convertToModelMessages(this.messages),
      stopWhen: stepCountIs(2),
      tools: {
        remember: tool({
          description: "Remember a fact keyed by a short name.",
          inputSchema: z.object({
            key: z.string().min(1).max(100),
            value: z.string().min(1).max(1000),
          }),
          execute: async ({ key, value }) => {
            const sessionId = this.ctx?.id?.toString?.() || "default";
            const storage = this.ctx?.storage;
            if (storage?.sql) {
              storage.sql.exec(
                "CREATE TABLE IF NOT EXISTS mas_memory (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)"
              );
              storage.sql.exec(
                "INSERT INTO mas_memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                key,
                value,
                new Date().toISOString()
              );
            } else if (this.env.SESSIONS) {
              await this.env.SESSIONS.put(`memory:${sessionId}:${key}`, value);
            }
            return { stored: true, key, value };
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
