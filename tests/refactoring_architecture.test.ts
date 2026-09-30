import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { McpToolFactory } from "../src/mcp/commands";
import { McpAgentToolAdapter } from "../src/agents/mcpAdapter";
import { RemoteMcpClient } from "../src/services/mcpClient";
import { McpSystemFacade } from "../src/patterns/facade";
import { AuditEventPublisher, TelemetryAuditObserver } from "../src/patterns/observer";
import type { Env } from "../src/types";

describe("Refactored Architecture & Design Verification", () => {
  let mockSql: MockSqlStorage;
  let orm: DatabaseORM;

  const mockEnv: Env = {
    ASSETS: {} as any,
    AI: {} as any,
    SESSIONS: {} as any,
    SEARCH_AGENT: {} as any,
    AI_SEARCH_ENDPOINT: "https://api.cloudflare.com/ai-search",
    APP_NAME: "Multi-Agent Assistant",
    GITHUB_CLIENT_ID: "client_id_test",
    GITHUB_CLIENT_SECRET: "client_secret_test",
    APP_BASE_URL: "http://localhost:8787",
    SESSION_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };

  beforeEach(() => {
    mockSql = new MockSqlStorage();
    orm = new DatabaseORM(mockSql);
    orm.initializeSchema("test_session_123");
  });

  describe("Unified Schema & ORM Seeding", () => {
    it("seeds default sponsor ads and initial transactions in DatabaseORM", () => {
      const ads = orm.ads.findMany();
      expect(ads.length).toBeGreaterThanOrEqual(4);
      expect(ads.some((a) => a.id === "ad_workers_ai")).toBe(true);

      const txs = orm.transactions.findMany();
      expect(txs.length).toBeGreaterThanOrEqual(2);
      expect(txs.some((t) => t.id === "pay_init_stripe")).toBe(true);
      expect(txs.some((t) => t.id === "pay_init_paypal")).toBe(true);
    });

    it("supports full repository CRUD on messages and memory tables", () => {
      orm.messages.create({
        id: "msg_1",
        sessionId: "test_session_123",
        role: "user",
        content: "Hello architecture",
        agent: "orchestrator",
        createdAt: new Date().toISOString(),
      });

      const msg = orm.messages.findById("msg_1");
      expect(msg).not.toBeNull();
      expect(msg?.content).toBe("Hello architecture");

      orm.memory.create({
        key: "user_preference",
        value: "dark_mode",
        updatedAt: new Date().toISOString(),
      });

      const mem = orm.memory.findById("user_preference");
      expect(mem?.value).toBe("dark_mode");
    });
  });

  describe("Dynamic E*TRADE Portfolio Positions Calculation", () => {
    it("dynamically adjusts position quantity and cost basis when trades are executed", () => {
      const etrade = new ETradeService(mockEnv, orm);

      const initialPositions = etrade.getPositions();
      const nvdaInitial = initialPositions.positions.find((p) => p.symbol === "NVDA");
      expect(nvdaInitial).toBeDefined();
      const initialQty = nvdaInitial!.quantity;

      // Preview and execute an order for 50 shares of NVDA @ 140.00
      const draft = etrade.previewOrder({
        symbol: "NVDA",
        orderAction: "BUY",
        quantity: 50,
        orderType: "LIMIT",
        limitPrice: 140.0,
        sessionId: "test_session_123",
      });

      etrade.executeOrder(draft.orderId, "test_session_123", "approved");

      // Verify updated positions reflect the executed BUY trade
      const updatedPositions = etrade.getPositions();
      const nvdaUpdated = updatedPositions.positions.find((p) => p.symbol === "NVDA");
      expect(nvdaUpdated).toBeDefined();
      expect(nvdaUpdated!.quantity).toBe(initialQty + 50);
    });

    it("dynamically adds new position for executed order of a new ticker", () => {
      const etrade = new ETradeService(mockEnv, orm);

      // Execute order for new ticker AMD (if not already held) or GOOGL
      const draft = etrade.previewOrder({
        symbol: "GOOGL",
        orderAction: "BUY",
        quantity: 25,
        orderType: "MARKET",
        sessionId: "test_session_123",
      });

      etrade.executeOrder(draft.orderId, "test_session_123", "approved");

      const updated = etrade.getPositions();
      const googlPos = updated.positions.find((p) => p.symbol === "GOOGL");
      expect(googlPos).toBeDefined();
      expect(googlPos!.quantity).toBe(25);
    });
  });

  describe("Unified McpToolFactory & Adapter Integration", () => {
    it("registers and executes create_task_draft command in McpToolFactory", async () => {
      const command = McpToolFactory.getTool("create_task_draft");
      expect(command).toBeDefined();
      expect(command?.name).toBe("create_task_draft");

      const result = await McpToolFactory.executeTool(
        "create_task_draft",
        { title: "Refactor architecture and submit audit report", priority: "high" },
        {
          env: mockEnv,
          orm,
          sessionId: "test_session_123",
          audit: () => {},
        }
      );

      expect(result.status).toBe("draft");
      expect(result.title).toBe("Refactor architecture and submit audit report");
      expect(result.requiresConfirmation).toBe(true);
    });

    it("adapts McpToolFactory commands into AI SDK tool format via McpAgentToolAdapter", async () => {
      const command = McpToolFactory.getTool("get_revenue_summary")!;
      const adaptedTool = McpAgentToolAdapter.adapt(command, {
        env: mockEnv,
        orm,
        sessionId: "test_session_123",
        audit: () => {},
      });

      expect(adaptedTool).toBeDefined();
      expect(typeof adaptedTool.execute).toBe("function");

      const result = await adaptedTool.execute({}, { messages: [] });
      expect(result).toHaveProperty("grossRevenue");
      expect(result).toHaveProperty("netRevenue");
    });
  });

  describe("RemoteMcpClient Resilience & Validation", () => {
    it("throws a descriptive error when serverUrl is invalid", async () => {
      await expect(
        RemoteMcpClient.callTool({
          serverUrl: "",
          toolName: "test_tool",
          arguments: {},
        })
      ).rejects.toThrow("Invalid remote MCP serverUrl");
    });

    it("handles request timeouts with AbortController gracefully", async () => {
      // Mock global fetch to simulate delay longer than timeout
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_, reject) => {
          const signal = options?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      });

      try {
        await expect(
          RemoteMcpClient.callTool({
            serverUrl: "https://mcp.external-payment-service.com/rpc",
            toolName: "create_checkout_session",
            arguments: { amount: 50 },
            timeoutMs: 50,
          })
        ).rejects.toThrow("timed out after 50ms");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("System Facade & Audit Publisher Observer", () => {
    it("publishes and notifies audit observers using GoF Observer Pattern", () => {
      const facade = new McpSystemFacade(mockEnv, orm, "test_session_123");
      const telemetry = new TelemetryAuditObserver();

      facade.auditPublisher.subscribe(telemetry);
      facade.publishAudit("system.refactored", "orchestrator", { status: "verified" });

      expect(telemetry.recordedEvents.length).toBe(1);
      expect(telemetry.recordedEvents[0].type).toBe("system.refactored");
      expect(telemetry.recordedEvents[0].sessionId).toBe("test_session_123");
    });
  });
});
