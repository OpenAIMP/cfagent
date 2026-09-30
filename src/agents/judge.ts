import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AgentName, Env } from "../types";

export interface RouteDecision {
  agent: AgentName;
  confidence: number;
  reason: string;
  needsConfirmation: boolean;
}

export interface QualityDecision {
  score: number;
  grounded: boolean;
  safe: boolean;
  issues: string[];
}

const routeSchema = `Return JSON only: {"agent":"search|payments|tasks|general","confidence":0-1,"reason":"short reason","needsConfirmation":true|false}`;

export class LLMJudge {
  private model;

  constructor(private env: Env) {
    this.model = createWorkersAI({ binding: env.AI })("@cf/meta/llama-3.1-8b-instruct");
  }

  async route(text: string): Promise<RouteDecision> {
    const { text: output } = await generateText({
      model: this.model,
      temperature: 0,
      system: `You are a conservative intent router for a multi-agent system. Payments includes charges, refunds, invoices and subscriptions. Search is knowledge-base lookup. Tasks includes reminders and task management. Route ambiguous requests to general. ${routeSchema}`,
      prompt: text.slice(0, 4000),
    });
    const parsed = this.parse(output);
    const agent: AgentName = ["search", "payments", "tasks", "general"].includes(parsed.agent) ? parsed.agent : "general";
    return {
      agent,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason || "fallback"),
      needsConfirmation: agent === "payments" || Boolean(parsed.needsConfirmation),
    };
  }

  async evaluate(input: { question: string; answer: string; agent: AgentName }): Promise<QualityDecision> {
    const { text: output } = await generateText({
      model: this.model,
      temperature: 0,
      system: `Evaluate an assistant answer. Do not decide whether a factual answer is true without evidence. Return JSON only: {"score":0-100,"grounded":true|false,"safe":true|false,"issues":["..."]}. Penalize invented sources, unauthorized actions, and failure to answer the question.`,
      prompt: JSON.stringify(input).slice(0, 9000),
    });
    const parsed = this.parse(output);
    return {
      score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
      grounded: parsed.grounded !== false,
      safe: parsed.safe !== false,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).slice(0, 5) : [],
    };
  }

  private parse(value: string): Record<string, any> {
    try {
      const match = value.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : {};
    } catch {
      return {};
    }
  }
}
