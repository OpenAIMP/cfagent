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
        if (context.submitJob && command.name !== "get_async_job" && command.name !== "list_async_jobs") {
          return context.submitJob({
            capability: "mcp.tool",
            payload: {
              toolName: command.name,
              arguments: input,
            },
          });
        }
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

  // 1. Dogfood every registered MCP command into the AI agent toolset.
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

  // 3. Task management tool for agent task proposals
  tools["createTaskDraft"] = tool({
    description: "Draft a task or reminder for the user or organization. Returns a structured task proposal for user confirmation.",
    inputSchema: z.object({
      title: z.string().min(1).max(300).describe("Task title or summary"),
      dueDate: z.string().optional().describe("Optional target deadline or ISO date"),
      priority: z.enum(["low", "medium", "high", "urgent"]).default("medium").describe("Urgency level"),
      assignee: z.string().optional().describe("Assignee name or role"),
    }),
    execute: async (input) => {
      if (context.submitJob) return context.submitJob({ capability: "task.draft", payload: input });
      const taskId = `task_${crypto.randomUUID().slice(0, 8)}`;
      const payload = {
        taskId,
        status: "draft",
        requiresConfirmation: true,
        ...input,
        message: "Task draft created. Awaiting human confirmation via 'confirm_payment_draft' or 'confirmDraft'.",
      };
      context.audit("task.drafted", "tasks", payload);
      return payload;
    },
  });

  // 4. Memory helper aliases mapping to manage_session_memory
  tools["rememberFact"] = tool({
    description: "Persist a key fact, user preference, or project context into durable SQLite memory for this session.",
    inputSchema: z.object({
      key: z.string().min(1).describe("Descriptive memory key"),
      value: z.string().min(1).describe("The information to store"),
    }),
    execute: async ({ key, value }) => {
      if (context.submitJob) {
        return context.submitJob({
          capability: "mcp.tool",
          payload: { toolName: "manage_session_memory", arguments: { action: "remember", key, value } },
        });
      }
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
      if (context.submitJob) {
        return context.submitJob({
          capability: "mcp.tool",
          payload: { toolName: "manage_session_memory", arguments: { action: "list" } },
        });
      }
      const command = McpToolFactory.getTool("manage_session_memory");
      if (!command) throw new Error("Memory command missing");
      return command.execute({ action: "list" }, context);
    },
  });

  return tools;
}
