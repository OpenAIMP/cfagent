/**
 * Deterministic fast-path of the judge's request routing.
 *
 * Issue #258: the fast-path heuristics used to live inline at the top of
 * `LLMJudge.route()` (src/agents/judge.ts). They are extracted here as a pure,
 * SDK-free module so the eval harness (tests/judge-eval.test.ts) can score the
 * deterministic routing layer hermetically — no LLM, no network — while
 * production keeps calling the same code (single source of truth).
 *
 * Returns the RouteDecision when a fast-path rule matches, or `null` when no
 * rule matches and the caller must fall through to the LLM router (or its
 * offline "general conversation fallback").
 *
 * Rules are evaluated FIRST-MATCH in the order below; the golden set in
 * tests/fixtures/judge-golden.json encodes this exact order.
 */
import type { RouteDecision } from "./types";

export function deterministicRoute(
  text: string,
  recentMessages: Array<{ role?: string; content?: string }> = []
): RouteDecision | null {
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
  if (/\b(yfinance|yahoo\s*finance|alpaca|market\s*data|fundamentals|valuation|valuations|compare|peer|peers|p\/e\b|peg\s*ratio|price\s*to\s*book|beta|analyst\s*ratings?|price\s*targets?|historical\s*bars|ohlcv|research\s+[a-z]{1,5}|snapshot\s+[a-z]{1,5})\b/i.test(lower)) {
    return { agent: "research", confidence: 0.98, reason: "market-data research, quoting, and peer valuation intent (Yahoo Finance / Alpaca)", needsConfirmation: false };
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

  return null;
}
