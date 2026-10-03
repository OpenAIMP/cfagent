import { describe, it, expect, beforeEach } from "vitest";
import { planNLQ, executeNLQQuery, formatMarketCap } from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import type { Env } from "../src/types";

describe("Natural Language Query (NLQ) Engine", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    SEARCH_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  };

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
  });

  describe("NLQ Planner Fast-paths", () => {
    it("parses stock listing price, exchange, market-cap, and result-limit filters", async () => {
      const plan = await planNLQ(
        mockEnv,
        "Screen Nasdaq stocks priced between $20 and $200 with market cap above $50B; show 30 stocks"
      );

      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.exchange).toBe("NASDAQ");
      expect(plan.tradingData?.filters?.minPrice).toBe(20);
      expect(plan.tradingData?.filters?.maxPrice).toBe(200);
      expect(plan.tradingData?.filters?.minMarketCap).toBe(50);
      expect(plan.tradingData?.filters?.limit).toBe(30);
    });

    it("parses the stock price-range shortcut without adding sector or RSI constraints", async () => {
      const plan = await planNLQ(mockEnv, "Find stocks priced between $20 and $200");

      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.minPrice).toBe(20);
      expect(plan.tradingData?.filters?.maxPrice).toBe(200);
      expect(plan.tradingData?.filters?.sector).toBeUndefined();
      expect(plan.tradingData?.filters?.minRsi).toBeUndefined();
      expect(plan.tradingData?.filters?.maxRsi).toBeUndefined();
    });

    it("classifies schema and table queries into domain 'tables'", async () => {
      const plan = await planNLQ(mockEnv, "List all database tables and schema");
      expect(plan.domain).toBe("tables");
      expect(plan.operation).toBe("list");
    });

    it("classifies category creation into domain 'category_mutation'", async () => {
      const plan = await planNLQ(mockEnv, "Add category 'Autonomous Agents' to categories table");
      expect(plan.domain).toBe("category_mutation");
      expect(plan.operation).toBe("create");
      expect(plan.categoryData?.name).toBe("Autonomous Agents");
    });

    it("classifies table data requests into domain 'table_data'", async () => {
      const plan = await planNLQ(mockEnv, "Show referral categories");
      expect(plan.domain).toBe("table_data");
      expect(plan.targetTable).toBe("mas_categories");
    });

    it("classifies conversation questions into domain 'conversation'", async () => {
      const plan = await planNLQ(mockEnv, "How many questions did the user ask?");
      expect(plan.domain).toBe("conversation");
      expect(plan.role).toBe("user");
    });
  });

  describe("NLQ Query Execution over DatabaseORM", () => {
    it("executes domain 'tables' and returns schema metadata", () => {
      const plan = {
        domain: "tables" as const,
        operation: "list" as const,
        terms: "",
        role: "any" as const,
        since: null,
        limit: 25,
      };

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.domain).toBe("tables");
      expect(result.count).toBe(9);
      expect(result.rows.some((r) => r.tableName === "mas_categories")).toBe(true);
      expect(result.rows.some((r) => r.tableName === "mas_trades")).toBe(true);
      expect(result.rows.some((r) => r.tableName === "mas_external_ads")).toBe(true);
    });

    it("executes domain 'category_mutation' and adds new category to mas_categories", () => {
      const initialCount = orm.categories.count();
      const plan = {
        domain: "category_mutation" as const,
        operation: "create" as const,
        categoryData: {
          name: "Edge Compute & Serverless",
          description: "Edge infrastructure and workers",
          icon: "⚡",
        },
        terms: "Edge Compute & Serverless",
        role: "any" as const,
        since: null,
        limit: 25,
      };

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.domain).toBe("category_mutation");
      expect(result.count).toBe(initialCount + 1);

      const added = orm.categories.findMany().find((c) => c.name === "Edge Compute & Serverless");
      expect(added).toBeDefined();
      expect(added?.icon).toBe("⚡");
    });

    it("executes domain 'table_data' and returns rows from target table", () => {
      const plan = {
        domain: "table_data" as const,
        operation: "list" as const,
        targetTable: "mas_external_ads",
        terms: "",
        role: "any" as const,
        since: null,
        limit: 10,
      };

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.domain).toBe("table_data");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0].cpm_rate ?? result.rows[0].cpmRate).toBeDefined();
    });
  });

  describe("Market Screener NLQ & Audit Ledger Verification", () => {
    it("formatMarketCap scales raw dollars and billions accurately without redundant unit suffixes", () => {
      // Raw dollar numbers (from Yahoo Finance / live feeds)
      expect(formatMarketCap(3.39e12)).toBe("$3.39T");
      expect(formatMarketCap(2.53e11)).toBe("$253.00B");
      expect(formatMarketCap(4.5e10)).toBe("$45.00B");
      // Billion-normalized numbers (from internal screener universe)
      expect(formatMarketCap(3390)).toBe("$3.39T");
      expect(formatMarketCap(253)).toBe("$253.0B");
      expect(formatMarketCap(45.2)).toBe("$45.2B");
      // Edge cases
      expect(formatMarketCap(undefined)).toBe("N/A");
      expect(formatMarketCap(0)).toBe("N/A");
    });

    it("executes 'Show top momentum gainers' with strict filter enforcement, audit ledger, and fail-closed validation", async () => {
      const plan = await planNLQ(mockEnv, "Show top momentum gainers");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.gainersOnly).toBe(true);

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.targetTable).toBe("etrade_market_screener");
      expect(result.status).toBe("matches_found");

      // Verify every returned row is strictly positive
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(String(row.change)).toMatch(/^\+/);
        expect(row.actionAvailable).toContain("Preview Buy/Sell");
        expect(row.changePeriod).toBe("1D (Regular Trading Day)");
        expect(row.rsiLookback).toBe("14-Period Daily RSI");
        expect(row.calculationVersion).toBe("MACD (12, 26, 9 EMA)");
        expect(row.priorClose).toBeDefined();
        // Market cap should NEVER have nonsensical trillion prefixes like $3390000000.00T
        expect(String(row.marketCap)).not.toMatch(/\$3390000000/);
        expect(String(row.marketCap)).toMatch(/^\$[0-9.]+[TB]$/);
        // MACD signal should be an authentic technical indicator, not a pattern name
        expect(String(row.macdSignal)).not.toContain("Support Bounce at 50-Day EMA");
        expect(String(row.macdSignal)).not.toContain("New 52-Week High Breakout");
        expect(String(row.macdSignal)).toMatch(/MACD|Centerline|Divergence/);
      }

      // Verify Scan Ledger is present and accurately documents rejected symbols
      expect(result.scanLedger).toBeDefined();
      const ledger = result.scanLedger as any;
      expect(ledger.universeSymbols).toHaveLength(10);
      expect(ledger.totalEvaluated).toBe(10);
      expect(ledger.passedCount + ledger.rejectedCount).toBe(10);
      // Losers like AVGO, AAPL, TSLA, GOOGL, META must be in rejections with clear explanations
      expect(ledger.rejections.some((r: any) => r.symbol === "AVGO")).toBe(true);
      const avgoRej = ledger.rejections.find((r: any) => r.symbol === "AVGO");
      expect(avgoRej.reason).toContain("violates gainersOnly rule");
    });
  });
});
