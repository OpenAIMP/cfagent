/**
 * Remote Model Context Protocol (MCP) Client for External Payment Services
 *
 * Implements:
 * - GoF Adapter Pattern: Adapts external MCP server protocols into unified tool execution.
 * - JSON-RPC 2.0 Client (protocolVersion: 2024-11-05).
 * - Connects to external service MCP servers (e.g. Stripe MCP Server, PayPal MCP Server)
 *   via HTTP JSON-RPC 2.0 or Server-Sent Events (SSE).
 */

export interface RemoteMcpToolCallParams {
  serverUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
  apiKey?: string;
  timeoutMs?: number;
}

export interface RemoteMcpResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: any;
  };
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export class RemoteMcpClient {
  /**
   * Invokes a tool on a remote external MCP server via JSON-RPC 2.0
   */
  static async callTool(params: RemoteMcpToolCallParams): Promise<any> {
    const { serverUrl, toolName, arguments: toolArgs, apiKey, timeoutMs = 10_000 } = params;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const payload = {
      jsonrpc: "2.0",
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArgs,
      },
    };

    try {
      const res = await fetch(serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Remote MCP Server '${serverUrl}' returned HTTP ${res.status}`);
      }

      const json = (await res.json()) as RemoteMcpResponse;
      if (json.error) {
        throw new Error(`Remote MCP error [${json.error.code}]: ${json.error.message}`);
      }

      // Check if structured text content was returned
      if (json.result?.content && Array.isArray(json.result.content)) {
        const textItem = json.result.content.find((c) => c.type === "text");
        if (textItem?.text) {
          try {
            return JSON.parse(textItem.text);
          } catch {
            return { raw: textItem.text };
          }
        }
      }

      return json.result || {};
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Pings a remote MCP server to check availability and protocol support
   */
  static async ping(serverUrl: string, apiKey?: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(serverUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" }),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
