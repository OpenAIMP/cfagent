import type { AgentName, Env } from "../types";
import { DatabaseORM } from "../orm";
import { createAgentMcpTools } from "./mcpAdapter";

export interface MASOptions {
  env: Env;
  sessionId: string;
  requestId: string;
  sql: { exec: (query: string, ...args: unknown[]) => Iterable<unknown> };
  audit: (type: string, agent: AgentName | "judge" | "nlq" | "orchestrator", payload: Record<string, unknown>) => void;
}

/**
 * Legacy MAS tool factory preserved for backward compatibility.
 * Delegates tool creation directly to McpAgentToolAdapter & McpToolFactory commands.
 */
export function createMAS({ env, sessionId, requestId, sql, audit }: MASOptions) {
  const orm = new DatabaseORM(sql);
  orm.initializeSchema(sessionId);

  const tools = createAgentMcpTools({
    env,
    orm,
    sessionId,
    requestId,
    audit,
  });

  return {
    searchKnowledge: tools["knowledge_search"] || tools["searchKnowledge"],
    draftPayment: tools["draft_payment"] || tools["draftPayment"],
    createTaskDraft: tools["create_task_draft"] || tools["createTaskDraft"],
    confirmDraft: tools["confirm_payment_draft"] || tools["confirmDraft"],
    rememberFact: tools["rememberFact"],
    recallFacts: tools["recallFacts"],
  };
}
