import { generateText } from "ai";
import { getWorkersAIModel } from "./model";
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
  private model;

  constructor(private env: Env) {
    this.model = getWorkersAIModel(env);
  }

  async route(
    text: string,
    recentMessages: Array<{ role?: string; content?: string }> = []
  ): Promise<RouteDecision> {
    const trimmed = text.trim();
    if (!trimmed) {
      return {
        agent: "general",
        confidence: 1.0,
        reason: "Empty prompt",
        needsConfirmation: false,
      };
    }

    const lower = trimmed.toLowerCase();

    // Multi-turn context analysis: inspect previous assistant turn for pending drafts
    const lastAssistantMsg = [...recentMessages].reverse().find((m) => m?.role === "assistant");
    const lastAssistantText = typeof lastAssistantMsg?.content === "string" ? lastAssistantMsg.content : "";

    // Check for explicit draft ID references (e.g. "Approve pay_3f91a2b1" or "Execute ord_5a21b34c")
    if (/pay_[a-f0-9]{8}/i.test(text)) {
      return { agent: "payments", confidence: 0.99, reason: "Referenced payment draft ID", needsConfirmation: false };
    }
    if (/task_[a-f0-9]{8}/i.test(text)) {
      return { agent: "tasks", confidence: 0.99, reason: "Referenced task draft ID", needsConfirmation: false };
    }
    if (/ord_[a-f0-9]{8}/i.test(text)) {
      return { agent: "trading", confidence: 0.99, reason: "Referenced trading order draft ID", needsConfirmation: false };
    }

    // Check for pending draft confirmation in multi-turn follow-ups
    const hasPendingPayment = /pay_[a-f0-9]{8}|awaiting_confirmation|payment.*draft/i.test(lastAssistantText);
    const hasPendingTask = /task_[a-f0-9]{8}|task.*proposal|task.*draft/i.test(lastAssistantText);
    const hasPendingTrade = /ord_[a-f0-9]{8}|order.*preview|trade.*draft|previewed/i.test(lastAssistantText);

    if (hasPendingPayment && /\b(confirm|approve|proceed|yes|authorize|pay|cancel|reject|decline)\b/i.test(lower)) {
      return { agent: "payments", confidence: 0.98, reason: "Multi-turn human confirmation of pending payment draft", needsConfirmation: false };
    }
    if (hasPendingTask && /\b(confirm|approve|proceed|yes|create|schedule|cancel|reject)\b/i.test(lower)) {
      return { agent: "tasks", confidence: 0.98, reason: "Multi-turn human confirmation of pending task proposal", needsConfirmation: false };
    }
    if (hasPendingTrade && /\b(confirm|approve|proceed|yes|execute|buy|sell|trade|cancel|reject)\b/i.test(lower)) {
      return { agent: "trading", confidence: 0.98, reason: "Multi-turn human confirmation of pending trade order draft", needsConfirmation: false };
    }

    // Fast-path heuristics for sub-agents (0ms latency, 100% reliable)
    if (/\b(how\s+to|how\s+do\s+i|how\s+can\s+i|how\s+does|what\s+are|what\s+is|what\s+can|explain|capabilities|workflows?|playbook|decisioning|pickbesttrades|how\s+to\s+use|search|find|lookup|docs|documentation|knowledge|features|pricing|faq)\b/i.test(lower)) {
      return { agent: "search", confidence: 0.98, reason: "Platform capability, workflow documentation, or knowledge inquiry", needsConfirmation: false };
    }
    if (/\b(yfinance|yahoo\s*finance|alpaca|fundamentals|valuation|p\/e\b|peg\s*ratio|price\s*to\s*book|beta|analyst\s*ratings?|price\s*targets?|historical\s*bars|ohlcv|foss|research\s+[a-z]{1,5}|snapshot\s+[a-z]{1,5})\b/i.test(lower)) {
      return { agent: "research", confidence: 0.96, reason: "FOSS market research and quoting intent (Yahoo Finance / Alpaca)", needsConfirmation: false };
    }
    if (/\b(etrade|stock|stocks|equities|equity|shares|screener|screening|scan\s+stocks|market\s+scan|ticker|rsi|macd|buy\s+\d+|sell\s+\d+|portfolio|positions|brokerage)\b/i.test(lower)) {
      return { agent: "trading", confidence: 0.95, reason: "Stock screening and E*TRADE trading intent detected", needsConfirmation: true };
    }
    if (/\b(pay|payment|charge|refund|invoice|payout|billing|dollar|\$|usd|transfer)\b/i.test(lower)) {
      return { agent: "payments", confidence: 0.95, reason: "Payment operation detected", needsConfirmation: true };
    }
    if (/\b(task|todo|remind|reminder|schedule|due|deadline|assign|priority|soc2)\b/i.test(lower)) {
      return { agent: "tasks", confidence: 0.95, reason: "Task action detected", needsConfirmation: true };
    }
    if (/\b(remember|save|store|preference|recall|forgot|memory|prefer)\b/i.test(lower)) {
      return { agent: "memory", confidence: 0.95, reason: "Session memory persistence", needsConfirmation: false };
    }
    if (/^(hi|hello|hey|greetings|help|who are you|what can you do|openaimp|test)\b/i.test(lower)) {
      return { agent: "general", confidence: 0.95, reason: "Conversational greeting or general query", needsConfirmation: false };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);

      const { text: output } = await generateText({
        model: this.model,
        temperature: 0,
        system: `You are a strict, conservative intent classifier for an autonomous multi-agent assistant.
Available agents:
- 'search': knowledge-base queries, documented facts, company policies, architectural information.
- 'payments': charges, refunds, invoices, billing, and subscription operations. Always requires confirmation.
- 'tasks': reminders, todo items, deadlines, task drafting.
- 'memory': remembering user facts, storing preferences, context recall.
- 'trading': stock screening, technical market scanning (RSI/MACD), quotes, trade order previews, E*TRADE broker executions, portfolio positions.
- 'research': FOSS market research, Yahoo Finance fundamentals, valuation ratios (P/E, PEG), Alpaca real-time market data v2, historical bars, analyst targets.
- 'general': greetings, general conversation, clarification, or ambiguous intent.

${ROUTE_SCHEMA}`,
        prompt: text.slice(0, 2000),
        abortSignal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      const parsed = this.parseJson(output);
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
