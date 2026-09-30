import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages, streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { getWorkersAIModel } from "./model";
import type { Env } from "../types";

export class PaymentsAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const model = getWorkersAIModel(this.env);

    const result = streamText({
      model,
      system: `You are a payment drafting agent. Never move money. Draft a payment intent only. Ask for confirmation before any real action.`,
      messages: await convertToModelMessages(this.messages),
      stopWhen: stepCountIs(2),
      tools: {
        draftPayment: tool({
          description: "Draft a payment operation that requires explicit confirmation before execution.",
          inputSchema: z.object({
            action: z.enum(["charge", "refund", "invoice"]),
            amount: z.number().positive().max(100000),
            currency: z.string().min(3).max(3).default("USD"),
            customer: z.string().min(1).max(200),
          }),
          execute: async (input) => ({
            status: "awaiting_confirmation",
            ...input,
            message: "No money moved. User confirmation is required before a real payment action is performed.",
          }),
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
