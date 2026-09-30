import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { getWorkersAIModel } from "./model";
import type { Env } from "../types";

export class TasksAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = getWorkersAIModel(this.env);

    const result = streamText({
      model,
      system: `You are a task drafting agent. Create actionable tasks but do not persist them until the user confirms them.`,
      messages: await convertToModelMessages(this.messages),
      stopWhen: stepCountIs(2),
      tools: {
        createTaskDraft: tool({
          description: "Draft a task with a title, deadline, and priority.",
          inputSchema: z.object({
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
