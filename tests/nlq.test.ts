import { describe, it, expect, beforeEach } from "vitest";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
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
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
  });

  describe("NLQ Planner Fast-paths", () => {
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
      expect(result.count).toBe(8);
      expect(result.rows.some((r) => r.tableName === "mas_categories")).toBe(true);
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
});
