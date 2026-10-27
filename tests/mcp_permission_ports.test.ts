/**
 * Issue #1744 — MCP tool permission port: scope declarations,
 * adapter-resolved scope assignment, and cryptographic execution
 * isolation. TDD red→green: this file was written before the
 * implementation module existed.
 *
 * Contract (port-first, adapter-first):
 * - Every registered MCP tool declares exactly one permission scope.
 * - Scope assignment resolves from the principal (kind + login) via
 *   an adapter — never from tool-call arguments.
 * - Default assignment = current behavior (every interactive
 *   principal holds every scope), recorded explicitly per #1717
 *   SCOPED DEFAULTS so the owner can overturn it; `unknown`
 *   principals hold nothing and are always denied.
 * - Execution isolation: each execution gets a fresh 256-bit random
 *   key + random id; opening requires the exact key; the record is
 *   destroyed on end. Cross-execution and post-end opens fail.
 */
import { describe, it, expect } from "vitest";
import { McpToolFactory } from "../src/mcp/commands";
import {
  MCP_SCOPES,
  MCP_TOOL_SCOPES,
  createInMemoryMcpPermissionPort,
  createProductionMcpPermissionPort,
  declareToolScope,
  type McpPrincipal,
  type McpScope,
  type ToolPermissionPort,
} from "../src/permissions/mcpPermissionPorts";

const ALL_SCOPES: readonly McpScope[] = MCP_SCOPES;

const SYSTEM: McpPrincipal = { kind: "system", login: null };
const SESSION: McpPrincipal = { kind: "session", login: "alice" };
const API_KEY: McpPrincipal = { kind: "api-key", login: "alice" };
const AGENT_TURN: McpPrincipal = { kind: "agent-turn", login: null };
const SCANNER: McpPrincipal = { kind: "scanner-payment", login: null };
const UNKNOWN: McpPrincipal = { kind: "unknown", login: null };

describe("MCP tool scope declarations (#1744)", () => {
  it("every registered tool declares exactly one scope", () => {
    const tools = McpToolFactory.getAllTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const scope = (MCP_TOOL_SCOPES as Record<string, McpScope | undefined>)[tool.name];
      expect(scope, `tool ${tool.name} must declare a scope`).toBeDefined();
      expect(ALL_SCOPES).toContain(scope);
    }
  });

  it("every declared scope names a registered tool (no stale declarations)", () => {
    const registered = new Set(McpToolFactory.getAllTools().map((t) => t.name));
    for (const name of Object.keys(MCP_TOOL_SCOPES)) {
      expect(registered.has(name), `declared tool ${name} is not registered`).toBe(true);
    }
  });

  it("declarations cover the sensitive tools with their strict scopes", () => {
    expect(MCP_TOOL_SCOPES["etrade_execute_order"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["alpaca_place_order"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["execute_durable_twap"]).toBe("mcp:trade");
    expect(MCP_TOOL_SCOPES["draft_payment"]).toBe("mcp:payments");
    expect(MCP_TOOL_SCOPES["confirm_payment_draft"]).toBe("mcp:payments");
    expect(MCP_TOOL_SCOPES["get_audit_events"]).toBe("mcp:admin");
    expect(MCP_TOOL_SCOPES["list_database_tables"]).toBe("mcp:admin");
    expect(MCP_TOOL_SCOPES["query_table_data"]).toBe("mcp:admin");
    expect(MCP_TOOL_SCOPES["chain.run"]).toBe("mcp:execute");
    expect(MCP_TOOL_SCOPES["execute_nlq"]).toBe("mcp:execute");
    expect(MCP_TOOL_SCOPES["manage_session_memory"]).toBe("mcp:write");
    expect(MCP_TOOL_SCOPES["agentdb.reports.list"]).toBe("mcp:read");
    expect(MCP_TOOL_SCOPES["etrade_get_quote"]).toBe("mcp:read");
  });
});

/** Scope-resolution contract, run unchanged against both adapters. */
function runScopeResolutionContract(makePort: () => ToolPermissionPort, label: string) {
  describe(`scope resolution (${label})`, () => {
    it("system, session, api-key, and agent-turn principals hold every scope by default", async () => {
      const port = makePort();
      for (const principal of [SYSTEM, SESSION, API_KEY, AGENT_TURN]) {
        const scopes = await port.scopesFor(principal);
        expect(new Set(scopes)).toEqual(new Set(ALL_SCOPES));
      }
    });

    it("scanner-payment principals hold only the paid-tool scope", async () => {
      const port = makePort();
      expect(await port.scopesFor(SCANNER)).toEqual(["mcp:payments"]);
    });

    it("unknown principals hold nothing (fail closed)", async () => {
      const port = makePort();
      expect(await port.scopesFor(UNKNOWN)).toEqual([]);
    });

    it("authorize allows a held scope and denies a missing one", async () => {
      const port = makePort();
      const allowed = await port.authorize(SESSION, "etrade_get_quote");
      expect(allowed.allowed).toBe(true);
      expect(allowed.scope).toBe("mcp:read");
      const denied = await port.authorize(SCANNER, "etrade_execute_order");
      expect(denied.allowed).toBe(false);
      expect(denied.scope).toBe("mcp:trade");
      expect(denied.reason).toMatch(/scope/);
    });

    it("authorize denies unknown tools (no scope declared, no execution)", async () => {
      const port = makePort();
      const decision = await port.authorize(SYSTEM, "no_such_tool");
      expect(decision.allowed).toBe(false);
      expect(decision.scope).toBeNull();
    });

    it("requiredScope returns the declared scope and null for unknown tools", () => {
      const port = makePort();
      expect(port.requiredScope("draft_payment")).toBe("mcp:payments");
      expect(port.requiredScope("no_such_tool")).toBeNull();
    });
  });
}

/** Execution-isolation contract, run unchanged against both adapters. */
function runIsolationContract(makePort: () => ToolPermissionPort, label: string) {
  describe(`execution isolation (${label})`, () => {
    it("two executions get distinct ids and distinct keys", () => {
      const port = makePort();
      const a = port.beginExecution(SESSION, "etrade_get_quote");
      const b = port.beginExecution(SESSION, "etrade_get_quote");
      expect(a.executionId).not.toBe(b.executionId);
      expect(a.executionKey).not.toBe(b.executionKey);
      expect(a.executionKey).toMatch(/^[0-9a-f]{64}$/);
      port.endExecution(a.executionId, a.executionKey);
      port.endExecution(b.executionId, b.executionKey);
    });

    it("opening requires the exact key: wrong key and other execution keys fail", () => {
      const port = makePort();
      const a = port.beginExecution(SESSION, "etrade_get_quote");
      const b = port.beginExecution(SESSION, "market_data_get_quote");
      expect(port.openExecution(a.executionId, a.executionKey)).not.toBeNull();
      expect(port.openExecution(a.executionId, b.executionKey)).toBeNull();
      expect(port.openExecution(a.executionId, "0".repeat(64))).toBeNull();
      expect(port.openExecution("missing-id", a.executionKey)).toBeNull();
      port.endExecution(a.executionId, a.executionKey);
      port.endExecution(b.executionId, b.executionKey);
    });

    it("an opened record carries the principal and tool, never the key", () => {
      const port = makePort();
      const seal = port.beginExecution(SESSION, "etrade_get_quote");
      const record = port.openExecution(seal.executionId, seal.executionKey);
      expect(record?.toolName).toBe("etrade_get_quote");
      expect(record?.principal).toEqual(SESSION);
      expect(JSON.stringify(record)).not.toContain(seal.executionKey);
      port.endExecution(seal.executionId, seal.executionKey);
    });

    it("ending destroys the record: post-end opens fail, even with the right key", () => {
      const port = makePort();
      const seal = port.beginExecution(SESSION, "etrade_get_quote");
      expect(port.endExecution(seal.executionId, seal.executionKey)).toBe(true);
      expect(port.openExecution(seal.executionId, seal.executionKey)).toBeNull();
      expect(port.endExecution(seal.executionId, seal.executionKey)).toBe(false);
    });

    it("ending with the wrong key does not destroy the record", () => {
      const port = makePort();
      const seal = port.beginExecution(SESSION, "etrade_get_quote");
      expect(port.endExecution(seal.executionId, "f".repeat(64))).toBe(false);
      expect(port.openExecution(seal.executionId, seal.executionKey)).not.toBeNull();
      expect(port.endExecution(seal.executionId, seal.executionKey)).toBe(true);
    });
  });
}

describe("dynamic scope declarations (#1744, factory OCP)", () => {
  it("a dynamically declared tool resolves and authorizes by its declared scope", async () => {
    const port = createProductionMcpPermissionPort();
    expect(port.requiredScope("dynamic_test_tool")).toBeNull();
    declareToolScope("dynamic_test_tool", "mcp:read");
    expect(port.requiredScope("dynamic_test_tool")).toBe("mcp:read");
    const denied = await port.authorize(SCANNER, "dynamic_test_tool");
    expect(denied.allowed).toBe(false);
    const allowed = await port.authorize(SESSION, "dynamic_test_tool");
    expect(allowed.allowed).toBe(true);
  });

  it("refuses to weaken a statically declared tool's scope", () => {
    expect(() => declareToolScope("etrade_execute_order", "mcp:read")).toThrow(/static scope/);
    expect(() => declareToolScope("dynamic_bad_scope_tool", "mcp:everything" as McpScope)).toThrow(
      /unknown scope/
    );
  });
});

describe("production adapter (#1744)", () => {
  runScopeResolutionContract(() => createProductionMcpPermissionPort(), "production");
  runIsolationContract(() => createProductionMcpPermissionPort(), "production");
});

describe("in-memory adapter (#1744)", () => {
  runScopeResolutionContract(() => createInMemoryMcpPermissionPort(), "in-memory");
  runIsolationContract(() => createInMemoryMcpPermissionPort(), "in-memory");

  it("explicit per-principal overrides replace the default assignment", async () => {
    const port = createInMemoryMcpPermissionPort({
      overrides: new Map<string, readonly McpScope[]>([
        ["session:alice", ["mcp:read"]],
      ]),
    });
    expect(await port.scopesFor({ kind: "session", login: "alice" })).toEqual(["mcp:read"]);
    expect(await port.scopesFor({ kind: "session", login: "bob" })).toEqual([...ALL_SCOPES]);
    const denied = await port.authorize({ kind: "session", login: "alice" }, "draft_payment");
    expect(denied.allowed).toBe(false);
    const allowed = await port.authorize({ kind: "session", login: "alice" }, "etrade_get_quote");
    expect(allowed.allowed).toBe(true);
  });
});
