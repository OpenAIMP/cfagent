/**
 * Model Context Protocol (MCP) Server for Multi-Agent Studio
 * Implements the open JSON-RPC 2.0 Model Context Protocol standard (protocolVersion: 2024-11-05).
 * Exposes all platform capabilities as MCP Tools, Resources, and Prompts.
 *
 * Implements SOLID Principles & GoF Design Patterns:
 * - Single Responsibility Principle (SRP): JSON-RPC routing is separated from command execution.
 * - Open/Closed Principle (OCP): New tools register in McpToolFactory without changing this server.
 * - GoF Command Pattern: Tools execute via IMcpToolCommand instances.
 * - GoF Facade Pattern: Subsystems accessed through McpSystemFacade.
 */

import type { AsyncJobSubmission, Env } from "../types";
import type { DatabaseORM } from "../orm";
import { McpToolFactory } from "./commands";
import { BusinessError } from "../errors/errorAspects";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type { ObservabilitySink } from "../observability/observabilityPorts";
import {
  MCP_PERMISSION_DENIED_CODE,
  authorizeMcpToolCall,
  createProductionMcpPermissionPort,
  type McpPrincipal,
  type ToolPermissionPort,
} from "../permissions/mcpPermissionPorts";
import { McpSystemFacade } from "../patterns/facade";
import {
  MEMORY_READ_MODE_SWITCH,
  applyMemoryReadCap,
  memoryConfigErrorEvent,
  resolveMemoryReadMode,
} from "../config/knowledgeMemoryModes";
import {
  HTTP_DELIVERY_MODE_SWITCH,
  jobsConfigErrorEvent,
  levelsForHttpDelivery,
  resolveHttpDeliveryMode,
} from "../config/asyncJobModes";

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export const MCP_SERVER_INFO = {
  name: "multi-agent-studio-mcp",
  title: "Multi-Agent Studio Enterprise MCP Server",
  version: "1.0.0",
  description: "Exposes asynchronous agent capabilities, SQLite ORM, HITL payments with DIDs, NLQ, trading, and platform operations via MCP. Tool calls return job IDs; use get_async_job or list_async_jobs to retrieve results.",
  protocolVersion: "2024-11-05",
};

/**
 * All Tools exposed via MCP dynamically collected from McpToolFactory (GoF Factory Pattern)
 */
export const MCP_TOOLS: MCPToolDefinition[] = McpToolFactory.getToolDefinitions() as MCPToolDefinition[];

/**
 * Resources exposed via MCP
 */
export const MCP_RESOURCES: MCPResourceDefinition[] = [
  {
    uri: "sqlite://schema/tables",
    name: "Database Tables & Schema",
    description: "Comprehensive schema definitions and row counts for all SQLite tables in Multi-Agent Studio.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://revenue/summary",
    name: "Platform Revenue Summary",
    description: "Real-time financial summary of gross revenue, ad earnings, transaction fees, and net profit.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://categories/list",
    name: "Referral Categories Taxonomy",
    description: "Active referral and partner link taxonomy categories.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://external-ads/inventory",
    name: "External Ad Network Inventory",
    description: "Active advertising placements, impression counters, and earnings.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://memory/facts",
    name: "Persistent Session Facts",
    description: "Grounding facts and long-term user preferences saved in SQLite.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://audit/recent",
    name: "Observability Audit Stream",
    description: "Recent router decisions, HITL authorizations, and agent execution events.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://trading/orders",
    name: "E*TRADE Order Ledger",
    description: "Historical equity orders, execution statuses, and cryptographic Agent DID stamps.",
    mimeType: "application/json",
  },
  {
    uri: "etrade://portfolio/positions",
    name: "E*TRADE Account Positions & Holdings",
    description: "Active equity portfolio holdings, cost basis, and unrealized market gains/losses.",
    mimeType: "application/json",
  },
  {
    uri: "foss://market/quote/NVDA",
    name: "FOSS Market Quote (Yahoo Finance & Alpaca)",
    description: "Real-time Level 1 quote and NBBO bid/ask spread for active ticker.",
    mimeType: "application/json",
  },
  {
    uri: "foss://research/fundamentals/NVDA",
    name: "FOSS Company Fundamentals & Valuations",
    description: "Institutional P/E, PEG, price targets, and balance sheet metrics from Yahoo Finance.",
    mimeType: "application/json",
  },
  {
    uri: "foss://providers/status",
    name: "FOSS Market Data Providers Health",
    description: "Connection status, rate limits, and capabilities of Yahoo Finance and Alpaca integrations.",
    mimeType: "application/json",
  },
];

/**
 * Prompts exposed via MCP
 */
export const MCP_PROMPTS: MCPPromptDefinition[] = [
  {
    name: "audit_security_review",
    description: "Security and compliance review of pending financial drafts and cryptographic DID proof signatures.",
    arguments: [
      { name: "draftId", description: "Draft payment ID to inspect", required: true },
    ],
  },
  {
    name: "revenue_performance_analysis",
    description: "Analyze monetization efficiency across external ad networks (CPM/CPC) and recommend inventory optimizations.",
    arguments: [],
  },
  {
    name: "nlq_schema_exploration",
    description: "Formulate optimal natural language queries to explore data and relationships across SQLite tables.",
    arguments: [],
  },
  {
    name: "foss_equity_research_report",
    description: "Generate comprehensive equity research report synthesizing fundamentals, technical indicators, and analyst price targets via Yahoo Finance and Alpaca.",
    arguments: [
      { name: "symbol", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)", required: true },
    ],
  },
];

/**
 * Executes an MCP Tool Call using the GoF Command Pattern and Facade Pattern.
 */
export async function executeMCPTool(
  toolName: string,
  args: Record<string, any>,
  context: {
    env: Env;
    orm: DatabaseORM;
    sessionId: string;
    /** #1744: calling principal + gate port; unset → factory defaults (system, production port). */
    principal?: McpPrincipal;
    permissionPort?: ToolPermissionPort;
    permissionDecisionSink?: ObservabilitySink;
    /** #1722: NLQ_MODE session/user carriers, spread through to the tool context. */
    scopedNlqModes?: import("../config/nlqModes").NlqScopedModes;
    /** #1723: KNOWLEDGE_MODE / MEMORY_READ_MODE carriers, spread likewise. */
    scopedKnowledgeModes?: import("../config/knowledgeMemoryModes").KnowledgeScopedModes;
    scopedMemoryModes?: import("../config/knowledgeMemoryModes").MemoryScopedModes;
    /** #1724: JOB_LIST_ENVELOPE carrier, spread through to the tool context. */
    scopedJobListModes?: import("../config/asyncJobModes").JobListScopedModes;
    /** #1728: agentic-payments / premium-gating carriers, spread likewise. */
    scopedPaymentsModes?: import("../config/agenticPaymentsModes").PaymentsScopedModes;
    /** #1729: GOAL_COMPILE_MODE carrier, spread likewise. */
    scopedGoalChainModes?: import("../config/goalChainModes").GoalChainScopedModes;
    /** #1686: optional DO blob handle, spread through to the tool context like the scoped carriers (the factory spread forwards it to the tool command). */
    storage?: import("../trading").NasdaqUniverseRouteBundleInput["storage"];
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
    submitJob?: (job: AsyncJobSubmission) => Promise<{
      jobId: string;
      status: "queued";
      statusUrl: string;
    }>;
    getJob?: (jobId: string) => unknown;
    listJobs?: () => unknown[];
  }
): Promise<any> {
  const facade = new McpSystemFacade(context.env, context.orm, context.sessionId);
  return McpToolFactory.executeTool(toolName, args, {
    ...context,
    facade,
    // #1744: denial events stream via #1743's sink (built from env
    // when the caller supplied none); sink failure never fails the call.
    permissionDecisionSink:
      context.permissionDecisionSink ?? createObservabilitySink(context.env),
  });
}

/**
 * Reads an MCP Resource by URI.
 */
export async function readMCPResource(
  uri: string,
  context: {
    orm: DatabaseORM;
    sessionId: string;
    /** #1723: env for the MEMORY_READ_MODE env level (resource protocol has no run carrier). */
    env?: Env;
    /** #1723: optional audit channel for memory.config_error on an invalid env value. */
    audit?: (type: string, agent: any, payload: Record<string, unknown>) => void;
  }
): Promise<{ uri: string; mimeType: string; text: string }> {
  const { orm, sessionId } = context;

  switch (uri) {
    case "sqlite://schema/tables": {
      const tables = orm.listTables();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(tables, null, 2),
      };
    }
    case "sqlite://revenue/summary": {
      const summary = orm.getRevenueSummary();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(summary, null, 2),
      };
    }
    case "sqlite://categories/list": {
      const categories = orm.categories.findMany({ orderBy: "sort_order ASC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(categories, null, 2),
      };
    }
    case "sqlite://external-ads/inventory": {
      const ads = orm.externalAds.findMany({ orderBy: "earnings DESC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(ads, null, 2),
      };
    }
    case "sqlite://memory/facts": {
      // #1723: MEMORY_READ_MODE over the read cap only. The resource
      // protocol carries no per-call mode, so only the env level
      // applies here (builtin legacy = "uncapped"); an invalid env
      // value fails closed to uncapped, is logged, and is audited
      // when the caller supplied an audit channel.
      const resolved = resolveMemoryReadMode(
        { env: (context.env as unknown as Record<string, unknown> | undefined)?.[MEMORY_READ_MODE_SWITCH] },
        "uncapped"
      );
      if (resolved.invalid) {
        console.error(
          `[memory] invalid ${MEMORY_READ_MODE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "uncapped"`
        );
        context.audit?.(memoryConfigErrorEvent(), "orchestrator", {
          setting: MEMORY_READ_MODE_SWITCH,
          value: resolved.raw ?? "",
          resolved: "uncapped",
        });
      }
      const memories = applyMemoryReadCap(
        orm.memory.findMany({ orderBy: "updated_at DESC" }),
        resolved.mode
      );
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(memories, null, 2),
      };
    }
    case "sqlite://audit/recent": {
      const events = orm.events.findMany({ where: { sessionId }, orderBy: "created_at DESC", limit: 30 });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(events, null, 2),
      };
    }
    case "sqlite://trading/orders": {
      const orders = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(orders, null, 2),
      };
    }
    case "etrade://portfolio/positions": {
      const { ETradeService } = await import("../services/etrade");
      const etrade = new ETradeService(orm, undefined, sessionId);
      const holdings = etrade.getPositions();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(holdings, null, 2),
      };
    }
    case "foss://providers/status": {
      const { FossResearchService } = await import("../services/fossResearch");
      const foss = new FossResearchService();
      const statuses = foss.getProviderStatuses();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(statuses, null, 2),
      };
    }
    default: {
      if (uri.startsWith("foss://market/quote/")) {
        const sym = uri.replace("foss://market/quote/", "");
        const { FossResearchService } = await import("../services/fossResearch");
        const foss = new FossResearchService();
        const quote = await foss.getQuote(sym);
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(quote, null, 2),
        };
      }
      if (uri.startsWith("foss://research/fundamentals/")) {
        const sym = uri.replace("foss://research/fundamentals/", "");
        const { FossResearchService } = await import("../services/fossResearch");
        const foss = new FossResearchService();
        const fundamentals = await foss.getFundamentals(sym);
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(fundamentals, null, 2),
        };
      }
      throw new Error(`MCP Resource not found: ${uri}`);
    }
  }
}

/**
 * Handles incoming Model Context Protocol JSON-RPC 2.0 requests.
 */
export async function handleMCPRequest(
  request: MCPRequest,
  context: {
    env: Env;
    orm: DatabaseORM;
    sessionId: string;
    /** #1744: calling principal + gate port for tools/call (see executeMCPTool). */
    principal?: McpPrincipal;
    permissionPort?: ToolPermissionPort;
    permissionDecisionSink?: ObservabilitySink;
    /** #1722: NLQ_MODE session/user carriers, forwarded to tool execution. */
    scopedNlqModes?: import("../config/nlqModes").NlqScopedModes;
    /** #1723: KNOWLEDGE_MODE / MEMORY_READ_MODE carriers, forwarded likewise. */
    scopedKnowledgeModes?: import("../config/knowledgeMemoryModes").KnowledgeScopedModes;
    scopedMemoryModes?: import("../config/knowledgeMemoryModes").MemoryScopedModes;
    /** #1724: HTTP_DELIVERY_MODE / JOB_LIST_ENVELOPE carriers, forwarded likewise. */
    scopedHttpDeliveryModes?: import("../config/asyncJobModes").HttpDeliveryScopedModes;
    scopedJobListModes?: import("../config/asyncJobModes").JobListScopedModes;
    /** #1729: GOAL_COMPILE_MODE carrier, forwarded likewise. */
    scopedGoalChainModes?: import("../config/goalChainModes").GoalChainScopedModes;
    /** #1724: HTTP_DELIVERY_MODE run level — the `x-delivery-mode` header on the /mcp POST. */
    deliveryModeRun?: unknown;
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
    submitJob?: (job: AsyncJobSubmission) => Promise<{
      jobId: string;
      status: "queued";
      statusUrl: string;
    }>;
    getJob?: (jobId: string) => unknown;
    listJobs?: () => unknown[];
  }
): Promise<MCPResponse> {
  const id = request.id ?? null;

  try {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_SERVER_INFO.protocolVersion,
            serverInfo: {
              name: MCP_SERVER_INFO.name,
              version: MCP_SERVER_INFO.version,
            },
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
          },
        };

      case "ping":
        return {
          jsonrpc: "2.0",
          id,
          result: {},
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_TOOLS,
          },
        };

      case "tools/call": {
        const { name, arguments: toolArgs } = request.params || {};
        if (!name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: 'name' is required" },
          };
        }

        // #1724: HTTP_DELIVERY_MODE over tools/call wrapping. Legacy =
        // queued when a submitJob submitter is present, direct
        // execution otherwise; an explicitly set level (run > session
        // > user > env) overrides the submitter rule. The async-job
        // tools are NEVER wrapped, in any mode. An invalid winning
        // value fails closed to legacy, logged + audited as
        // jobs.config_error. Queued without a submitter still executes
        // directly — there is nothing to queue with.
        const deliveryLegacy = context.submitJob ? "queued" : "sync";
        const resolvedDelivery = resolveHttpDeliveryMode(
          levelsForHttpDelivery(
            context.scopedHttpDeliveryModes,
            context.deliveryModeRun,
            (context.env as unknown as Record<string, unknown> | undefined)?.[HTTP_DELIVERY_MODE_SWITCH]
          ),
          deliveryLegacy as "sync" | "queued"
        );
        if (resolvedDelivery.invalid) {
          console.error(
            `[jobs] invalid ${HTTP_DELIVERY_MODE_SWITCH} value ${JSON.stringify(resolvedDelivery.raw)} — failing closed to "${deliveryLegacy}"`
          );
          context.audit(jobsConfigErrorEvent(), "orchestrator", {
            setting: HTTP_DELIVERY_MODE_SWITCH,
            value: resolvedDelivery.raw ?? "",
            resolved: deliveryLegacy,
          });
        }
        // #1744: the gate runs on BOTH delivery paths. The sync path
        // gates inside executeMCPTool; the queued path authorizes
        // BEFORE submitJob, so a refused call never receives a job
        // receipt (the receipt would imply the call was accepted).
        // A permission denial returns a stable business error token,
        // never a technical leak.
        let data: unknown;
        try {
          if (
            resolvedDelivery.mode === "queued" && context.submitJob && McpToolFactory.getTool(name) &&
            name !== "get_async_job" && name !== "list_async_jobs"
          ) {
            const port = context.permissionPort ?? createProductionMcpPermissionPort();
            const principal = context.principal ?? { kind: "system" as const, login: null };
            await authorizeMcpToolCall(port, principal, name, {
              sessionId: context.sessionId,
              audit: context.audit,
              decisionSink:
                context.permissionDecisionSink ?? createObservabilitySink(context.env),
            });
            data = await context.submitJob({
              capability: "mcp.tool",
              payload: { toolName: name, arguments: toolArgs || {} },
            });
          } else {
            data = await executeMCPTool(name, toolArgs || {}, context);
          }
        } catch (err) {
          if (err instanceof BusinessError && err.code === MCP_PERMISSION_DENIED_CODE) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: `[${MCP_PERMISSION_DENIED_CODE}] ${err.message}` },
            };
          }
          throw err;
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
              },
            ],
            isError: false,
          },
        };
      }

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            resources: MCP_RESOURCES,
          },
        };

      case "resources/read": {
        const { uri } = request.params || {};
        if (!uri) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Invalid params: 'uri' is required" },
          };
        }
        const resource = await readMCPResource(uri, context);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [resource],
          },
        };
      }

      case "prompts/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            prompts: MCP_PROMPTS,
          },
        };

      case "prompts/get": {
        const { name } = request.params || {};
        const prompt = MCP_PROMPTS.find((p) => p.name === name);
        if (!prompt) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Prompt not found: ${name}` },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: prompt.description,
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Execute workflow for prompt template: ${prompt.name}.`,
                },
              },
            ],
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        };
    }
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err.message || "Internal error during MCP execution",
      },
    };
  }
}
