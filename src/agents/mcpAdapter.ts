/**
 * GoF Adapter Pattern & GRASP Pure Fabrication: McpAgentToolAdapter
 *
 * Implements:
 * - GoF Adapter Pattern: Converts IMcpToolCommand protocol objects into Vercel AI SDK `tool()` instances.
 * - GRASP Pure Fabrication: Introduced to bridge two heterogeneous interfaces (AI SDK & Model Context Protocol)
 *   without polluting domain entities with AI SDK dependencies.
 * - GRASP Indirection: Mediates interaction between the AI Orchestrator and the MCP command subsystem.
 * - Protected Variations: Protects AI agents from underlying database or MCP JSON-RPC protocol changes.
 *
 * This guarantees that internal AI agents DOGFOOD the exact same MCP commands and APIs
 * that external MCP clients (Claude Desktop, Cursor, Antigravity) consume.
 */

import { tool } from "ai";
import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../patterns/interfaces";
import { McpToolFactory } from "../mcp/commands";

export class McpAgentToolAdapter {
  /**
   * Adapts an IMcpToolCommand into a Vercel AI SDK Tool
   */
  static adapt(command: IMcpToolCommand, context: McpToolContext) {
    return tool({
      description: command.description,
      inputSchema: command.zodSchema,
      execute: async (input: any) => {
        return command.execute(input, context);
      },
    });
  }
}

/**
 * Creates the complete dictionary of AI tools for the Multi-Agent Orchestrator.
 * Combines all 14 MCP commands adapted for the LLM agent + agent-specific task drafting.
 */
export function createAgentMcpTools(context: McpToolContext) {
  const tools: Record<string, any> = {};

  // 1. Dogfood all 14 MCP commands directly into the AI agent toolset
  for (const command of McpToolFactory.getAllTools()) {
    // Register by canonical MCP name (e.g. 'execute_nlq', 'list_database_tables', 'get_revenue_summary')
    tools[command.name] = McpAgentToolAdapter.adapt(command, context);
  }

  // 2. Add convenient camelCase aliases to preserve backward compatibility with legacy prompt heuristics
  if (tools["knowledge_search"]) {
    tools["searchKnowledge"] = tools["knowledge_search"];
  }
  if (tools["draft_payment"]) {
    tools["draftPayment"] = tools["draft_payment"];
  }
  if (tools["confirm_payment_draft"]) {
    tools["confirmDraft"] = tools["confirm_payment_draft"];
  }

  // 3. Task management tool alias for agent task proposals
  if (tools["create_task_draft"]) {
    tools["createTaskDraft"] = tools["create_task_draft"];
  }

  // 4. Memory helper aliases mapping to manage_session_memory
  tools["rememberFact"] = tool({
    description: "Persist a key fact, user preference, or project context into durable SQLite memory for this session.",
    inputSchema: z.object({
      key: z.string().min(1).describe("Descriptive memory key"),
      value: z.string().min(1).describe("The information to store"),
    }),
    execute: async ({ key, value }) => {
      const command = McpToolFactory.getTool("manage_session_memory");
      if (!command) throw new Error("Memory command missing");
      return command.execute({ action: "remember", key, value }, context);
    },
  });

  tools["recallFacts"] = tool({
    description: "Recall all stored memory facts and user preferences recorded during this session.",
    inputSchema: z.object({
      filter: z.string().optional().describe("Optional keyword to filter stored memories"),
    }),
    execute: async () => {
      const command = McpToolFactory.getTool("manage_session_memory");
      if (!command) throw new Error("Memory command missing");
      return command.execute({ action: "list" }, context);
    },
  });

  return tools;
}
