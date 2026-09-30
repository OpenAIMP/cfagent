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

import type { Env } from "../types";
import type { DatabaseORM } from "../orm";
import { McpToolFactory } from "./commands";
import { McpSystemFacade } from "../patterns/facade";

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
  description: "Exposes autonomous agent orchestration, SQLite ORM, HITL payments with DIDs, NLQ database querying, referral categories taxonomy, and revenue monetization engines via Model Context Protocol.",
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
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
  }
): Promise<any> {
  const facade = new McpSystemFacade(context.env, context.orm, context.sessionId);
  return McpToolFactory.executeTool(toolName, args, {
    ...context,
    facade,
  });
}

/**
 * Reads an MCP Resource by URI.
 */
export async function readMCPResource(
  uri: string,
  context: { orm: DatabaseORM; sessionId: string }
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
      const memories = orm.memory.findMany({ orderBy: "updated_at DESC" });
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
      const etrade = new ETradeService(orm);
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
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
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

        const data = await executeMCPTool(name, toolArgs || {}, context);
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
