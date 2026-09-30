import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AgentName, Env, RouteDecision, QualityDecision } from "../types";

export { type RouteDecision, type QualityDecision };

const ROUTE_SCHEMA = `Return JSON only with this structure:
{
  "agent": "search" | "payments" | "tasks" | "memory" | "general",
  "confidence": 0.0 - 1.0,
  "reason": "concise rationale",
  "needsConfirmation": boolean
}`;

export class LLMJudge {
  private model;

  constructor(private env: Env) {
    this.model = createWorkersAI({ binding: env.AI })("@cf/meta/llama-3.1-8b-instruct");
  }

  async route(text: string): Promise<RouteDecision> {
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        agent: "general",
        confidence: 1.0,
        reason: "Empty prompt",
        needsConfirmation: false,
      };
    }

    // Fast-path heuristic for basic greetings to eliminate unnecessary LLM routing latency
    if (/^(hi|hello|hey|greetings|help|who are you|what can you do)\b/i.test(trimmed) && trimmed.length < 50) {
      return {
        agent: "general",
        confidence: 0.95,
        reason: "Standard greeting / capability query",
        needsConfirmation: false,
      };
    }

    try {
      const { text: output } = await generateText({
        model: this.model,
        temperature: 0,
        system: `You are a strict, conservative intent classifier for an autonomous multi-agent assistant.
Available agents:
- 'search': knowledge-base queries, documented facts, company policies, architectural information.
- 'payments': charges, refunds, invoices, billing, and subscription operations. Always requires confirmation.
- 'tasks': reminders, todo items, deadlines, task drafting.
- 'memory': remembering user facts, storing preferences, context recall.
- 'general': greetings, general conversation, clarification, or ambiguous intent.

${ROUTE_SCHEMA}`,
        prompt: text.slice(0, 4000),
      });

      const parsed = this.parseJson(output);
      const validAgents: AgentName[] = ["search", "payments", "tasks", "memory", "general"];
      const agent: AgentName = validAgents.includes(parsed.agent as AgentName)
        ? (parsed.agent as AgentName)
        : "general";

      const confidence = Math.max(0, Math.min(1, typeof parsed.confidence === "number" ? parsed.confidence : 0.7));

      return {
        agent,
        confidence,
        reason: String(parsed.reason || "Classified by LLM router"),
        needsConfirmation: agent === "payments" || Boolean(parsed.needsConfirmation),
      };
    } catch (err) {
      return {
        agent: "general",
        confidence: 0.5,
        reason: `Router fallback: ${err instanceof Error ? err.message : "Routing error"}`,
        needsConfirmation: false,
      };
    }
  }

  async evaluate(input: { question: string; answer: string; agent: AgentName }): Promise<QualityDecision> {
    try {
      const { text: output } = await generateText({
        model: this.model,
        temperature: 0,
        system: `You are a critical quality judge evaluating an AI agent's answer.
Rules:
- Never assume external facts without evidence.
- Penalize hallucinated citations, unconfirmed financial executions, or refusing valid questions.
- Score from 0 to 100.
Return JSON only:
{"score": 0-100, "grounded": boolean, "safe": boolean, "issues": ["issue 1", "issue 2"]}`,
        prompt: JSON.stringify(input).slice(0, 8000),
      });

      const parsed = this.parseJson(output);
      return {
        score: Math.max(0, Math.min(100, typeof parsed.score === "number" ? parsed.score : 80)),
        grounded: parsed.grounded !== false,
        safe: parsed.safe !== false,
        issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).slice(0, 5) : [],
      };
    } catch {
      return {
        score: 75,
        grounded: true,
        safe: true,
        issues: ["Automated evaluation skipped due to judge timeout or rate limit"],
      };
    }
  }

  private parseJson(value: string): Record<string, unknown> {
    try {
      // Remove any markdown code block fencing ```json ... ```
      const cleaned = value.replace(/```(?:json)?([\s\S]*?)```/g, "$1").trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      return match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
