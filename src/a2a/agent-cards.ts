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
    capabilities: ["planning", "supervision", "parallel-execution"],
    operations: ["search.query", "payments.draft", "tasks.create", "memory.remember", "nlq.execute"],
  },
  {
    name: "search",
    description: "Web and data search agent",
    version: "1.0.0",
    endpoint: "/a2a/search",
    capabilities: ["web-search", "opportunity-hunt"],
    operations: ["search.query"],
  },
  {
    name: "payments",
    description: "x402 payment processing with budget guards",
    version: "1.0.0",
    endpoint: "/a2a/payments",
    capabilities: ["payment-draft", "payment-process", "budget-check"],
    operations: ["payments.draft"],
  },
  {
    name: "tasks",
    description: "Task tracking and management",
    version: "1.0.0",
    endpoint: "/a2a/tasks",
    capabilities: ["task-create", "task-list", "task-update"],
    operations: ["tasks.create"],
  },
  {
    name: "memory",
    description: "Long-term vector memory for agent outcomes",
    version: "1.0.0",
    endpoint: "/a2a/memory",
    capabilities: ["remember", "recall"],
    operations: ["memory.remember"],
  },
];

/** Find a card by agent name. */
export function getAgentCard(name: string): AgentCard | undefined {
  return AGENT_CARDS.find((c) => c.name === name);
}
