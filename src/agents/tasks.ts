import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool } from "ai";
import { z } from "zod";
import { createWorkersAI } from "workers-ai-provider";
import type { Env } from "../types";

export class TasksAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-3.1-8b-instruct");

    const result = streamText({
      model,
      system: `You are a task drafting agent. Create actionable tasks but do not persist them until the user confirms them.`,
      messages: await convertToModelMessages(this.messages),
      maxSteps: 2,
      tools: {
        createTaskDraft: tool({
          description: "Draft a task with a title, deadline, and priority.",
          parameters: z.object({
            title: z.string().min(1).max(300),
            dueDate: z.string().optional(),
            priority: z.enum(["low", "medium", "high"]).default("medium"),
          }),
          execute: async (input) => ({
            status: "draft",
            ...input,
            message: "Task drafted and waiting for confirmation before it is saved.",
          }),
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
