import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool } from "ai";
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
      maxSteps: 2,
      tools: {
        remember: tool({
          description: "Remember a fact keyed by a short name.",
          parameters: z.object({
            key: z.string().min(1).max(100),
            value: z.string().min(1).max(1000),
          }),
          execute: async ({ key, value }) => {
            const sessionId = this.ctx?.id?.toString?.() || "default";
            await this.env.KV.put(`memory:${sessionId}:${key}`, value);
            return { stored: true, key, value };
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
