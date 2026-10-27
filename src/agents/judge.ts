import { requireGatewayPorts } from "../gateway/createGatewayPorts";
import { chainModels } from "../models/router";
import { deterministicRoute } from "../judge-routing";
import type { AgentName, Env, RouteDecision, QualityDecision } from "../types";

export { type RouteDecision, type QualityDecision };

const ROUTE_SCHEMA = `Return JSON only with this structure:
{
  "agent": "search" | "payments" | "tasks" | "memory" | "trading" | "general",
  "confidence": 0.0 - 1.0,
  "reason": "concise rationale",
  "needsConfirmation": boolean
}`;

export class LLMJudge {
  constructor(private env: Env) {}

  /**
   * Issue #163: model calls route through the model router — cheap →
   * primary → fallback on retryable errors (429/quota/overload).
   */
  async route(
    text: string,
    recentMessages: Array<{ role?: string; content?: string }> = []
  ): Promise<RouteDecision> {
    // Issue #258: the deterministic fast-path rules live in ../judge-routing
    // (single source of truth, scored hermetically by tests/judge-eval.test.ts).
    const fast = deterministicRoute(text, recentMessages);
    if (fast) return fast;

    try {
      // Issue #163: intent classification retries on cheaper/fallback models
      // when the primary is quota- or overload-limited.
      // #1741: ordered chain failover now lives in the gateway port;
      // the per-attempt 2500ms timeout is preserved as timeoutMs.
      const gateway = requireGatewayPorts(this.env);
      const routedText = (
        await gateway.generate({
          models: chainModels("plan"),
          temperature: 0,
          timeoutMs: 2500,
          caller: "judge-route",
          system: `You are a strict, conservative intent classifier for an autonomous multi-agent assistant.
Available agents:
- 'search': knowledge-base queries, documented facts, company policies, architectural information.
- 'payments': charges, refunds, invoices, billing, and subscription operations. Always requires confirmation.
- 'tasks': reminders, todo items, deadlines, task drafting.
- 'memory': remembering user facts, storing preferences, context recall.
- 'trading': stock screening, technical market scanning (RSI/MACD), quotes, trade order previews, E*TRADE broker executions, portfolio positions.
- 'research': market-data research, Yahoo Finance fundamentals, valuation ratios (P/E, PEG), Alpaca real-time market data v2, historical bars, analyst targets.
- 'general': greetings, general conversation, clarification, or ambiguous intent.

${ROUTE_SCHEMA}`,
          prompt: text.slice(0, 2000),
        })
      ).text;

      const parsed = this.parseJson(routedText);
      const validAgents: AgentName[] = ["search", "payments", "tasks", "memory", "general", "trading", "research"];
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
    } catch {
      return {
        agent: "general",
        confidence: 0.8,
        reason: "General conversation fallback",
        needsConfirmation: false,
      };
    }
  }

  async evaluate(input: { question: string; answer: string; agent: AgentName }): Promise<QualityDecision> {
    try {
      // Issue #163: quality evaluation falls back across the judge model chain.
      // #1741: ordered chain failover now lives in the gateway port.
      const gateway = requireGatewayPorts(this.env);
      const output = (
        await gateway.generate({
          models: chainModels("judge"),
          temperature: 0,
          caller: "judge-evaluate",
          system: `You are a critical quality judge evaluating an AI agent's answer.
Rules:
- Never assume external facts without evidence.
- Penalize hallucinated citations, unconfirmed financial executions, or refusing valid questions.
- Score from 0 to 100.
Return JSON only:
{"score": 0-100, "grounded": boolean, "safe": boolean, "issues": ["issue 1", "issue 2"]}`,
          prompt: JSON.stringify(input).slice(0, 8000),
        })
      ).text;

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
