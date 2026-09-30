/**
 * Comprehensive Verification Suite:
 * - Agent Self-Consumption of MCP Tools and APIs
 * - SOLID Principles (SRP, OCP, LSP, ISP, DIP)
 * - GoF Design Patterns (Command, Adapter, Strategy, Facade, Factory, Observer)
 * - GRASP Patterns (Information Expert, Creator, Controller, Low Coupling, High Cohesion, Polymorphism, Pure Fabrication, Indirection, Protected Variations)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import {
  McpToolFactory,
  ListDatabaseTablesCommand,
  GetRevenueSummaryCommand,
  ManageCategoriesCommand,
  DraftPaymentCommand,
  ConfirmPaymentDraftCommand,
} from "../src/mcp/commands";
import { McpAgentToolAdapter, createAgentMcpTools } from "../src/agents/mcpAdapter";
import { McpSystemFacade } from "../src/patterns/facade";
import {
  PaymentStrategyFactory,
  StripePaymentStrategy,
  PayPalPaymentStrategy,
  LemonSqueezyPaymentStrategy,
  SandboxPaymentStrategy,
} from "../src/patterns/paymentStrategies";
import {
  AuditEventPublisher,
  TelemetryAuditObserver,
  SqliteAuditObserver,
} from "../src/patterns/observer";
import type { IMcpToolCommand, IPaymentGatewayStrategy, McpToolContext } from "../src/patterns/interfaces";
import { z } from "zod";

describe("SOLID Principles, GoF Patterns & Agent Dogfooding Suite", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    SEARCH_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
    STRIPE_SECRET_KEY: "sk_test_mock123",
    PAYPAL_CLIENT_ID: "client_mock",
    PAYPAL_CLIENT_SECRET: "secret_mock",
    LEMONSQUEEZY_API_KEY: "ls_mock",
    LEMONSQUEEZY_STORE_ID: "12345",
  };
  const auditLogs: any[] = [];
  const auditMock = (type: string, agent: any, payload: Record<string, unknown>) => {
    auditLogs.push({ type, agent, payload });
  };
  const sessionId = "session_solid_test";

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    auditLogs.length = 0;
  });

  // =========================================================================
  // 1. Agent Self-Consumption (Dogfooding) of MCP Tools
  // =========================================================================
  describe("1. Agent Self-Consumption (Dogfooding) of MCP Tools", () => {
    it("adapts all 14 MCP commands directly into the AI Agent toolset", () => {
      const facade = new McpSystemFacade(mockEnv, orm, sessionId);
      const agentTools = createAgentMcpTools({
        env: mockEnv,
        orm,
        sessionId,
        facade,
        audit: auditMock,
      });

      // Verify all 14 canonical MCP tools are present in the agent's toolset
      const expectedMcpTools = [
        "knowledge_search",
        "draft_payment",
        "confirm_payment_draft",
        "get_payment_gateways",
        "get_transactions",
        "execute_nlq",
        "list_database_tables",
        "query_table_data",
        "manage_categories",
        "manage_referrals",
        "manage_external_ads",
        "get_revenue_summary",
        "manage_session_memory",
        "get_audit_events",
      ];

      for (const toolName of expectedMcpTools) {
        expect(agentTools[toolName]).toBeDefined();
        expect(typeof agentTools[toolName].execute).toBe("function");
      }

      // Verify legacy convenience aliases are also wired
      expect(agentTools["searchKnowledge"]).toBeDefined();
      expect(agentTools["draftPayment"]).toBeDefined();
      expect(agentTools["confirmDraft"]).toBeDefined();
      expect(agentTools["createTaskDraft"]).toBeDefined();
    });

    it("executes database introspection and revenue calculation when called through agent tools", async () => {
      const facade = new McpSystemFacade(mockEnv, orm, sessionId);
      const agentTools = createAgentMcpTools({
        env: mockEnv,
        orm,
        sessionId,
        facade,
        audit: auditMock,
      });

      // Agent dogfoods list_database_tables
      const tablesResult = await agentTools["list_database_tables"].execute({});
      expect(tablesResult.count).toBe(8);
      expect(tablesResult.tables.some((t: any) => t.name === "mas_categories")).toBe(true);

      // Agent dogfoods get_revenue_summary
      const revenueResult = await agentTools["get_revenue_summary"].execute({});
      expect(revenueResult.grossRevenue).toBeGreaterThan(0);
      expect(revenueResult.adNetworkRevenue).toBeGreaterThan(0);
      expect(revenueResult.marketplaceRevenue).toBeGreaterThan(0);

      // Agent dogfoods manage_categories
      const createCatResult = await agentTools["manage_categories"].execute({
        action: "create",
        name: "DevOps & Cloud",
        icon: "🚀",
      });
      expect(createCatResult.success).toBe(true);
      expect(createCatResult.category.name).toBe("DevOps & Cloud");
    });
  });

  // =========================================================================
  // 2. SOLID Principles
  // =========================================================================
  describe("2. SOLID Principles Implementation", () => {
    it("Single Responsibility Principle (SRP): Each command has one dedicated execution domain", async () => {
      const context: McpToolContext = {
        env: mockEnv,
        orm,
        sessionId,
        audit: auditMock,
      };

      const listTablesCmd = new ListDatabaseTablesCommand();
      const revenueCmd = new GetRevenueSummaryCommand();
      const categoriesCmd = new ManageCategoriesCommand();

      // Table command handles schema introspection only
      const tables = await listTablesCmd.execute({}, context);
      expect(tables.tables.length).toBe(8);

      // Revenue command handles financial metrics only
      const revenue = await revenueCmd.execute({}, context);
      expect(revenue.grossRevenue).toBeGreaterThan(0);
      expect(revenue.netRevenue).toBeDefined();

      // Category command handles taxonomy CRUD only
      const catList = await categoriesCmd.execute({ action: "list" }, context);
      expect(catList.categories.length).toBeGreaterThanOrEqual(4);
    });

    it("Open/Closed Principle (OCP): Easily extend MCP with new commands without modifying core engine", async () => {
      // Create a brand new custom command
      class CustomAuditReportCommand implements IMcpToolCommand<{ format: string }> {
        readonly name = "custom_audit_report";
        readonly description = "Generate custom compliance report";
        readonly jsonSchema = {
          type: "object" as const,
          properties: { format: { type: "string" } },
        };
        readonly zodSchema = z.object({ format: z.string().default("json") });

        async execute(input: { format: string }) {
          return { status: "success", format: input.format, generatedAt: new Date().toISOString() };
        }
      }

      // Register dynamically (OCP: open for extension)
      const customCmd = new CustomAuditReportCommand();
      McpToolFactory.registerTool(customCmd);

      // Verify factory has registered it
      expect(McpToolFactory.getTool("custom_audit_report")).toBe(customCmd);

      // Verify agent adapter immediately incorporates the new tool
      const agentTools = createAgentMcpTools({
        env: mockEnv,
        orm,
        sessionId,
        audit: auditMock,
      });
      expect(agentTools["custom_audit_report"]).toBeDefined();

      const runResult = await agentTools["custom_audit_report"].execute({ format: "pdf" });
      expect(runResult.status).toBe("success");
      expect(runResult.format).toBe("pdf");
    });

    it("Liskov Substitution Principle (LSP): Any IMcpToolCommand or IPaymentGatewayStrategy is fully substitutable", async () => {
      const context: McpToolContext = {
        env: mockEnv,
        orm,
        sessionId,
        audit: auditMock,
      };

      const commands: IMcpToolCommand[] = [
        new ListDatabaseTablesCommand(),
        new GetRevenueSummaryCommand(),
      ];

      // Polymorphically execute through the base interface
      for (const cmd of commands) {
        expect(cmd.name).toBeDefined();
        expect(cmd.description).toBeDefined();
        const res = await cmd.execute({}, context);
        expect(res).toBeDefined();
      }

      // Payment Gateway Strategies are substitutable
      const strategies: IPaymentGatewayStrategy[] = [
        new StripePaymentStrategy(),
        new PayPalPaymentStrategy(),
        new LemonSqueezyPaymentStrategy(),
        new SandboxPaymentStrategy(),
      ];

      for (const strategy of strategies) {
        const status = strategy.getStatus(mockEnv);
        expect(status.id).toBe(strategy.gatewayId);
        expect(status.capabilities.length).toBeGreaterThan(0);
      }
    });

    it("Interface Segregation Principle (ISP): Narrow, focused interfaces prevent fat contracts", () => {
      // Telemetry observer only needs to implement onAuditEvent
      const observer = new TelemetryAuditObserver();
      expect(typeof observer.onAuditEvent).toBe("function");

      // Commands do not have unwanted lifecycle methods forced upon them
      const cmd = new ListDatabaseTablesCommand();
      expect(cmd.execute).toBeDefined();
      expect(cmd.jsonSchema).toBeDefined();
      expect(cmd.zodSchema).toBeDefined();
    });

    it("Dependency Inversion Principle (DIP): High-level modules depend on abstractions (facade & interfaces)", () => {
      const facade = new McpSystemFacade(mockEnv, orm, sessionId);
      expect(facade.orm).toBe(orm);
      expect(facade.env).toBe(mockEnv);
      expect(typeof facade.createCheckout).toBe("function");
      expect(typeof facade.executeNlq).toBe("function");
      expect(typeof facade.getGatewayStatuses).toBe("function");
    });
  });

  // =========================================================================
  // 3. GoF Design Patterns
  // =========================================================================
  describe("3. GoF (Gang of Four) Patterns Implementation", () => {
    it("Command Pattern: Tool execution encapsulated with metadata and validation", async () => {
      const draftCmd = new DraftPaymentCommand();
      const context: McpToolContext = { env: mockEnv, orm, sessionId, audit: auditMock };

      const draftResult = await draftCmd.execute(
        {
          amount: 85.5,
          customer: "Alpha Corp",
          gateway: "stripe",
          description: "API Tokens",
        },
        context
      );

      expect(draftResult.draftId.startsWith("pay_")).toBe(true);
      expect(draftResult.amount).toBe(85.5);
      expect(draftResult.status).toBe("awaiting_confirmation");
      expect(draftResult.requiresConfirmation).toBe(true);

      // Execute Confirm Command
      const confirmCmd = new ConfirmPaymentDraftCommand();
      const confirmResult = await confirmCmd.execute(
        {
          draftId: draftResult.draftId,
          decision: "approved",
          note: "Authorized by CFO",
        },
        context
      );

      expect(confirmResult.status).toBe("completed");
      expect(confirmResult.decision).toBe("approved");
    });

    it("Adapter Pattern: McpAgentToolAdapter adapts MCP command into AI SDK tool", async () => {
      const listTablesCmd = new ListDatabaseTablesCommand();
      const context: McpToolContext = { env: mockEnv, orm, sessionId, audit: auditMock };

      // Adapt command to AI SDK tool
      const adaptedTool = McpAgentToolAdapter.adapt(listTablesCmd, context);
      expect(adaptedTool.description).toBe(listTablesCmd.description);

      const result = await adaptedTool.execute({});
      expect(result.count).toBe(8);
      expect(result.tables.length).toBe(8);
    });

    it("Strategy Pattern: Dynamic payment gateway execution across providers", async () => {
      const stripeStrategy = PaymentStrategyFactory.getStrategy("stripe");
      const paypalStrategy = PaymentStrategyFactory.getStrategy("paypal");
      const lsStrategy = PaymentStrategyFactory.getStrategy("lemonsqueezy");
      const sandboxStrategy = PaymentStrategyFactory.getStrategy("sandbox");

      expect(stripeStrategy.gatewayId).toBe("stripe");
      expect(paypalStrategy.gatewayId).toBe("paypal");
      expect(lsStrategy.gatewayId).toBe("lemonsqueezy");
      expect(sandboxStrategy.gatewayId).toBe("sandbox");

      // Verify statuses
      expect(stripeStrategy.getStatus(mockEnv).configured).toBe(true);
      expect(paypalStrategy.getStatus(mockEnv).configured).toBe(true);
      expect(lsStrategy.getStatus(mockEnv).configured).toBe(true);
      expect(sandboxStrategy.getStatus(mockEnv).configured).toBe(true);
    });

    it("Facade Pattern: McpSystemFacade coordinates ORM, payments, NLQ, and DIDs", async () => {
      const facade = new McpSystemFacade(mockEnv, orm, sessionId);

      // Verify Facade orchestrates checkout creation
      const checkout = await facade.createCheckout({
        draftId: "pay_facade_test",
        amount: 50,
        currency: "USD",
        customer: "Beta Logistics",
        gateway: "sandbox",
        userLogin: "user_test",
      });

      expect(checkout.success).toBe(true);
      expect(checkout.checkoutUrl).toContain("sandbox");
      expect(checkout.didAttestation.proposerDid).toBeDefined();

      // Verify Facade orchestrates NLQ
      const nlqResult = await facade.executeNlq("List all database tables and schema");
      expect(nlqResult.domain).toBe("tables");
    });

    it("Observer Pattern: AuditEventPublisher notifies multiple decoupled observers", () => {
      const publisher = new AuditEventPublisher(sessionId);
      const observer1 = new TelemetryAuditObserver();
      const observer2 = new TelemetryAuditObserver();

      const unsubscribe1 = publisher.subscribe(observer1);
      publisher.subscribe(observer2);
      expect(publisher.getObserverCount()).toBe(2);

      // Publish event
      publisher.publish("test.event", "test_agent", { message: "Hello Observer" });

      expect(observer1.recordedEvents.length).toBe(1);
      expect(observer1.recordedEvents[0].type).toBe("test.event");
      expect(observer2.recordedEvents.length).toBe(1);

      // Unsubscribe
      unsubscribe1();
      expect(publisher.getObserverCount()).toBe(1);

      publisher.publish("test.event.2", "test_agent", { message: "Second event" });
      expect(observer1.recordedEvents.length).toBe(1); // Did not receive
      expect(observer2.recordedEvents.length).toBe(2); // Received
    });
  });

  // =========================================================================
  // 4. GRASP Patterns
  // =========================================================================
  describe("4. GRASP (General Responsibility Assignment) Patterns", () => {
    it("Information Expert: DatabaseORM calculates revenue and aggregates table data", () => {
      // Information Expert: DatabaseORM possesses the data necessary to compute revenue
      const revenue = orm.getRevenueSummary();
      expect(revenue.grossRevenue).toBeGreaterThan(0);
      expect(revenue.netRevenue).toBeDefined();

      // Information Expert: DatabaseORM knows table names and schemas
      const tables = orm.listTables();
      expect(tables.some(t => t.name === "mas_ads")).toBe(true);
    });

    it("Pure Fabrication & Indirection: McpAgentToolAdapter decouples AI Agents from MCP transport", () => {
      // The Adapter is a pure fabrication introduced to maintain high cohesion and low coupling
      const context: McpToolContext = { env: mockEnv, orm, sessionId, audit: auditMock };
      const cmd = new GetRevenueSummaryCommand();
      const adapted = McpAgentToolAdapter.adapt(cmd, context);

      expect(adapted).toBeDefined();
      expect(typeof adapted.execute).toBe("function");
    });

    it("Protected Variations: IMcpToolCommand contract shields caller from underlying DB changes", async () => {
      const context: McpToolContext = { env: mockEnv, orm, sessionId, audit: auditMock };
      const cmd = new ListDatabaseTablesCommand();

      // Caller invokes command without any knowledge of internal SQLite execution
      const result = await cmd.execute({}, context);
      expect(Array.isArray(result.tables)).toBe(true);
    });
  });
});
