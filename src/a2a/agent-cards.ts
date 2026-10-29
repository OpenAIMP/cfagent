/**
 * PR #2 — A2A agent cards.
 *
 * Served at /.well-known/agent-card.json. Each card describes an
 * agent's capabilities so external A2A callers can discover and
 * invoke them via /a2a/<agent> endpoints.
 */

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  /** A2A endpoint path, e.g. "/a2a/orchestrator" */
  endpoint: string;
  /** Discovery path for this agent's card */
  cardPath: string;
  capabilities: string[];
  /** Operations this agent exposes (subset of orchestrate.ts catalog) */
  operations: string[];
}

export const AGENT_CARDS: AgentCard[] = [
  {
    name: "orchestrator",
    description: "Plans and supervises multi-step agent workflows",
    version: "1.0.0",
    endpoint: "/a2a/orchestrator",
    cardPath: "/a2a/orchestrator/agent-card.json",
    capabilities: ["planning", "supervision", "parallel-execution"],
    operations: ["search.query", "payments.draft", "payments.confirm", "tasks.create", "memory.remember", "memory.recall", "nlq.execute"],
  },
  {
    name: "search",
    description: "Web and data search agent",
    version: "1.0.0",
    endpoint: "/a2a/search",
    cardPath: "/a2a/search/agent-card.json",
    capabilities: ["web-search", "opportunity-hunt"],
    operations: ["search.query"],
  },
  {
    name: "payments",
    description: "x402 payment processing with budget guards",
    version: "1.0.0",
    endpoint: "/a2a/payments",
    cardPath: "/a2a/payments/agent-card.json",
    capabilities: ["budget-check", "payment-process", "payment-list"],
    operations: ["payments.budget_check", "payments.today_spent", "payments.list", "payments.process"],
  },
  {
    name: "tasks",
    description: "Task tracking and management",
    version: "1.0.0",
    endpoint: "/a2a/tasks",
    cardPath: "/a2a/tasks/agent-card.json",
    capabilities: ["task-create", "task-list", "task-update"],
    operations: ["tasks.create"],
  },
  {
    name: "memory",
    description: "Long-term vector memory for agent outcomes",
    version: "1.0.0",
    endpoint: "/a2a/memory",
    cardPath: "/a2a/memory/agent-card.json",
    capabilities: ["remember", "recall"],
    operations: ["memory.remember", "memory.recall"],
  },
  {
    name: "trading",
    description:
      "Provider-neutral trading competency: screening and (approval-gated) trading across registered broker providers",
    version: "1.0.0",
    endpoint: "/a2a/trading",
    cardPath: "/a2a/trading/agent-card.json",
    capabilities: ["stock-screening", "options-screening", "stock-trading", "options-trading"],
    operations: ["trading.screen_stocks", "trading.screen_options", "trading.trade_stock", "trading.trade_options"],
  },
];

/** Find a card by agent name. */
export function getAgentCard(name: string): AgentCard | undefined {
  return AGENT_CARDS.find((c) => c.name === name);
}

/** Alias for backwards compat with index.ts */
export const A2A_CARDS = AGENT_CARDS;

/** Standard A2A discovery paths */
export const A2A_CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"];
