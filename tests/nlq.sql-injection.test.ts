/**
 * Assessment P0 (#143): NLQ SQL-injection / table-allowlist tests.
 *
 * Two layers are pinned here:
 *  1. Parameter binding regression — adversarial `terms` values (quotes,
 *     OR 1=1, stacked statements) must stay bound as LIKE parameters and
 *     never become SQL.
 *  2. Table allowlist — a prompt-injected planner can no longer point the
 *     table_data domain at arbitrary tables (sqlite_master and friends).
 *     Refusals are clean errors with no partial data.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  executeNLQQuery,
  isNlqTableAllowed,
  NLQ_TABLE_ALLOWLIST,
  type NLQPlan,
} from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";

function tableDataPlan(targetTable: string, terms?: string): NLQPlan {
  return {
    domain: "table_data",
    operation: "list",
    targetTable,
    role: "any",
    ...(terms !== undefined ? { terms } : {}),
  };
}

describe("NLQ SQL injection defenses (Assessment P0 #143)", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    const now = new Date().toISOString();
    orm.categories.create({
      id: "cat_obrien_0001",
      name: "O'Brien's Picks",
      slug: "obriens-picks",
      description: "Referral categories taxonomy",
      icon: "🏷️",
      isActive: true,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
  });

  describe("table allowlist", () => {
    it("allows the tables the product's planner legitimately targets", () => {
      for (const t of [
        "mas_categories",
        "mas_trades",
        "mas_transactions",
        "mas_watchlists",
        "mas_referrals",
        "mas_external_ads",
        "mas_ads",
        "mas_events",
        "mas_memory",
        "etrade_portfolio_live",
        "options_flows",
        "mas_agentic_wallet",
        "etrade_options_screener",
        "etrade_market_screener",
        "etrade_market_quotes",
        "cf_agent_schedules",
        "yfinance_fundamentals",
        "mas_messages",
        "market_data_stock_comparison",
        "market_data_research_report",
        "market_data_quote",
        "etrade_premium_research",
        "etrade_premium_options",
        "alpaca_snapshot",
        "platform_capabilities",
      ]) {
        expect(isNlqTableAllowed(t), t).toBe(true);
        expect(NLQ_TABLE_ALLOWLIST.has(t), t).toBe(true);
      }
    });

    it("refuses sqlite system tables (any case)", () => {
      for (const t of ["sqlite_master", "SQLITE_MASTER", "Sqlite_Master", "sqlite_sequence"]) {
        expect(isNlqTableAllowed(t), t).toBe(false);
      }
    });

    it("refuses fabricated or empty table names", () => {
      expect(isNlqTableAllowed("mas_secret")).toBe(false);
      expect(isNlqTableAllowed("users")).toBe(false);
      expect(isNlqTableAllowed("")).toBe(false);
      expect(isNlqTableAllowed(undefined)).toBe(false);
      expect(isNlqTableAllowed(null)).toBe(false);
    });

    it("allowlist matching is case-insensitive like SQLite table resolution", () => {
      expect(isNlqTableAllowed("Mas_Trades")).toBe(true);
      expect(isNlqTableAllowed("MAS_CATEGORIES")).toBe(true);
    });

    it("a planner targeting sqlite_master gets a clean refusal with no data", () => {
      const result = executeNLQQuery(orm, "s1", tableDataPlan("sqlite_master"));
      expect(result.status).toBe("error");
      expect(result.rows).toEqual([]);
      expect(result.count).toBe(0);
      expect(result.summary).toContain("sqlite_master");
      expect(result.targetTable).toBe("sqlite_master");
    });

    it("a mixed-case sqlite_master bypass attempt is also refused", () => {
      const result = executeNLQQuery(orm, "s1", tableDataPlan("SQLITE_master"));
      expect(result.status).toBe("error");
      expect(result.rows).toEqual([]);
    });

    it("a fabricated table name is refused, not probed", () => {
      const result = executeNLQQuery(orm, "s1", tableDataPlan("mas_secret"));
      expect(result.status).toBe("error");
      expect(result.rows).toEqual([]);
    });

    it("allowlisted tables still execute normally", () => {
      const result = executeNLQQuery(orm, "s1", tableDataPlan("mas_categories"));
      expect(result.status).not.toBe("error");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.targetTable).toBe("mas_categories");
    });
  });

  describe("parameter binding of search terms", () => {
    // Records every (query, args) pair the ORM sends to storage, so we can
    // assert the binding invariant: adversarial text travels only in bound
    // args, never interpolated into SQL.
    function spyOnSql() {
      const seen: Array<{ q: string; args: unknown[] }> = [];
      const origExec = sql.exec.bind(sql);
      sql.exec = ((q: string, ...args: unknown[]) => {
        seen.push({ q, args });
        return origExec(q, ...args);
      }) as typeof sql.exec;
      return seen;
    }

    function assertPayloadBoundNotInterpolated(seen: Array<{ q: string; args: unknown[] }>, payload: string) {
      // getTableData lowercases the search term; compare case-insensitively.
      const needle = payload.toLowerCase();
      for (const { q } of seen) {
        expect(q.toLowerCase(), `query must not interpolate the payload: ${q}`).not.toContain(needle);
      }
      const bound = seen.some(({ args }) =>
        args.some((a) => String(a).toLowerCase().includes(needle))
      );
      expect(bound, "payload must travel as a bound parameter").toBe(true);
    }

    it("OR 1=1 payload is bound as a literal, not executed", () => {
      const payload = "' OR '1'='1";
      const seen = spyOnSql();
      const result = executeNLQQuery(orm, "s1", tableDataPlan("mas_categories", payload));
      expect(result.status).not.toBe("error");
      // No row contains that literal text: the payload matched nothing
      // instead of dumping the table.
      expect(result.rows).toEqual([]);
      assertPayloadBoundNotInterpolated(seen, payload);
    });

    it("stacked-statement payload does not drop the table", () => {
      const payload = "'; DROP TABLE mas_categories; --";
      const seen = spyOnSql();
      const result = executeNLQQuery(orm, "s1", tableDataPlan("mas_categories", payload));
      expect(result.status).not.toBe("error");
      expect(result.rows).toEqual([]);
      assertPayloadBoundNotInterpolated(seen, payload);
      // The table is intact: a plain list still returns the seeded row.
      const after = executeNLQQuery(orm, "s1", tableDataPlan("mas_categories"));
      expect(after.rows.length).toBeGreaterThan(0);
    });

    it("values containing quotes are bound, never interpolated into SQL", () => {
      const payload = "O'Brien";
      const seen = spyOnSql();
      const result = executeNLQQuery(orm, "s1", tableDataPlan("mas_categories", payload));
      expect(result.status).not.toBe("error");
      assertPayloadBoundNotInterpolated(seen, payload);
    });

    it("search terms never become SQL in the table name either", () => {
      // An attacker-controlled table string with SQL metacharacters: the
      // allowlist refuses it before any identifier handling matters.
      const result = executeNLQQuery(orm, "s1", tableDataPlan('mas_categories" OR "1"="1'));
      expect(result.status).toBe("error");
      expect(result.rows).toEqual([]);
    });
  });
});
