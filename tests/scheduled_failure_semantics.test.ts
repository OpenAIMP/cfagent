import { describe, it, expect, vi, beforeEach } from "vitest";

// The orchestrator extends AIChatAgent from @cloudflare/ai-chat, whose real
// module graph pulls in `cloudflare:` protocol imports the node test loader
// cannot resolve. Mock it with a plain base class (the same pattern as
// tests/schedules_create_route.test.ts); the agent callbacks under test run
// on a bare prototype instance with ctx/env/broadcast stubbed.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});

// Issue #224 rewired autonomousMarketScreen to the liveScreener module
// (fetchTechnologySymbols / fetchLiveQuotes, E*TRADE primary with Nasdaq
// fallback) instead of DynamicMarketScreener.screenStocks. Mock that seam —
// mocking screenStocks no longer injects anything into the screen path.
vi.mock("../src/trading/liveScreener", () => ({
  fetchTechnologySymbols: vi.fn(),
  fetchLiveQuotes: vi.fn(),
}));

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { fetchTechnologySymbols, fetchLiveQuotes } from "../src/trading/liveScreener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import type { Env } from "../src/types";

const mockFetchTechnologySymbols = vi.mocked(fetchTechnologySymbols);
const mockFetchLiveQuotes = vi.mocked(fetchLiveQuotes);

/**
 * Issue #112 — failure semantics for scheduled options jobs.
 *
 * Before #112 the failure paths were asymmetric and partly invisible:
 *  - a failing market screen returned {success:false} with NO audit event
 *    (options analysis at least audited its failures);
 *  - a failing options analysis was audited but never surfaced — no
 *    session message (the success path inserts one) and no broadcast
 *    (the orchestrator callbacks broadcast only on success);
 *  - nothing recorded that the SDK's default callback retry is
 *    deliberately unused (services return terminal results instead of
 *    throwing; see the failure contract on ScheduledTasksService).
 *
 * These tests pin the fixed behaviour at the service level and at the
 * OrchestratorAgent callback level. Success-path behaviour is covered by
 * tests/scheduled_tasks.test.ts and is unchanged.
 *
 * NOTE (issue #224): the market-screen tests inject failures/results at the
 * liveScreener module seam (fetchTechnologySymbols / fetchLiveQuotes) and at
 * DynamicMarketScreener.screenWithQuotes — the screen no longer calls
 * screenStocks, so spying on screenStocks is a no-op.
 */
describe("Scheduled job failure semantics (#112)", () => {
  let env: Env;
  const sessionId = "failure_semantics_trader";

  beforeEach(() => {
    vi.restoreAllMocks();
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    env = {
      APP_ENV: "TEST",
      APP_BASE_URL: "https://agent.openaimp.com",
      AI_SEARCH_ENDPOINT: "https://ai-search.internal",
      ETRADE_ENVIRONMENT: "sandbox",
      ET_API_KEY: "sandbox_consumer_key_123",
      ET_API_SECRET: "sandbox_consumer_secret_456",
      ET_BASE_URL: "https://apisb.etrade.com/v1",
      ETRADE_KV: {} as any,
      SESSIONS: {} as any,
      SEARCH_AGENT: {} as any,
    } as Env;
  });

  function makeOrm(sql: MockSqlStorage) {
    const orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    return orm;
  }

  function eventPayload(event: any) {
    return typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
  }

  // =========================================================================
  // Service level
  // =========================================================================
  describe("ScheduledTasksService failure paths", () => {
    it("audits a market screen failure and records a failure session message", async () => {
      const orm = makeOrm(new MockSqlStorage());
      mockFetchTechnologySymbols.mockRejectedValue(new Error("universe fetch exploded"));

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousMarketScreen({ sector: "Technology", maxItems: 3 });

      expect(res.success).toBe(false);
      expect(res.taskType).toBe("market_screen");
      expect(res.error).toContain("universe fetch exploded");

      // The failure is audited, symmetric with options analysis.
      const failures = orm.events.findMany({ where: { type: "screener.screen_failed" } });
      expect(failures.length).toBe(1);
      const payload = eventPayload(failures[0]);
      expect(payload.sector).toBe("Technology");
      expect(payload.error).toContain("universe fetch exploded");

      // ...and surfaced in the session, plainly labelled a failure.
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(
        messages.some(
          m => m.content.includes("Scheduled Market Screen failed") && m.content.includes("universe fetch exploded")
        )
      ).toBe(true);

      // No success-shaped audit event was written for the failed run.
      expect(orm.events.findMany({ where: { type: "screener.opportunities_detected" } }).length).toBe(0);
    });

    it("audits an options analysis failure AND records a failure session message naming the error", async () => {
      const orm = makeOrm(new MockSqlStorage());
      vi.spyOn(UnifiedOptionsService.prototype, "execute").mockRejectedValue(
        new Error("broker chain unavailable")
      );

      const service = new ScheduledTasksService(env, orm, sessionId);
      const res = await service.autonomousOptionsAnalysis({
        symbols: ["AAPL", "NVDA"],
        thesis: "bullish",
        pushToSlack: false,
      });

      expect(res.success).toBe(false);
      expect(res.taskType).toBe("options_analysis");
      expect(res.error).toContain("broker chain unavailable");

      const failures = orm.events.findMany({ where: { type: "options.scheduled_analysis_failed" } });
      expect(failures.length).toBe(1);
      const payload = eventPayload(failures[0]);
      expect(payload.symbols).toEqual(["AAPL", "NVDA"]);
      expect(payload.error).toContain("broker chain unavailable");

      // The failure is surfaced in the conversation, mirroring the
      // success path's session message — and it says "failed".
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(
        messages.some(
          m =>
            m.content.includes("Scheduled Options Intelligence failed") &&
            m.content.includes("AAPL") &&
            m.content.includes("broker chain unavailable")
        )
      ).toBe(true);

      expect(orm.events.findMany({ where: { type: "options.scheduled_analysis_completed" } }).length).toBe(0);
    });
  });

  // =========================================================================
  // Orchestrator callback level
  // =========================================================================
  describe("OrchestratorAgent scheduled callbacks", () => {
    function makeAgent(sql: MockSqlStorage) {
      const ctx = {
        storage: { sql },
        id: { toString: () => sessionId },
      } as any;
      const agent: any = Object.create(OrchestratorAgent.prototype);
      agent.ctx = ctx;
      agent.env = env;
      agent.broadcast = vi.fn();
      return agent;
    }

    function broadcasts(agent: any): any[] {
      return agent.broadcast.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    }

    it("broadcasts an options analysis failure as well as auditing + messaging it", async () => {
      const sql = new MockSqlStorage();
      const agent = makeAgent(sql);
      vi.spyOn(UnifiedOptionsService.prototype, "execute").mockRejectedValue(new Error("quote stream down"));

      await agent.autonomousOptionsAnalysis({ symbols: ["AAPL"] });

      const sent = broadcasts(agent);
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("options_alert");
      expect(sent[0].title).toBe("Autonomous Options Intelligence Failed");
      expect(sent[0].success).toBe(false);
      expect(sent[0].error).toContain("quote stream down");
      expect(sent[0].symbols).toEqual(["AAPL"]);

      // The service-level surfacing happened on the same run.
      const orm = makeOrm(sql);
      expect(orm.events.findMany({ where: { type: "options.scheduled_analysis_failed" } }).length).toBe(1);
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(messages.some(m => m.content.includes("Scheduled Options Intelligence failed"))).toBe(true);
    });

    it("still broadcasts an options analysis success with the unchanged shape", async () => {
      const sql = new MockSqlStorage();
      const agent = makeAgent(sql);
      vi.spyOn(UnifiedOptionsService.prototype, "execute").mockResolvedValue({
        summary: "Scanned 2 symbols; 1 actionable setup.",
        data: { scanned: 2, withTrades: 1, opportunities: [] },
        toSlack: () => ({}),
        toEmailHtml: () => "",
        toEmailText: () => "",
        toWebhook: () => ({}),
      } as any);

      await agent.autonomousOptionsAnalysis({ symbols: ["AAPL", "NVDA"] });

      const sent = broadcasts(agent);
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("options_alert");
      expect(sent[0].title).toBe("Autonomous Options Intelligence Alert");
      expect(sent[0].summary).toContain("Scanned 2 symbols");
      expect(sent[0].success).toBeUndefined();

      const orm = makeOrm(sql);
      expect(orm.events.findMany({ where: { type: "options.scheduled_analysis_failed" } }).length).toBe(0);
    });

    it("broadcasts a market screen failure as well as auditing + messaging it", async () => {
      const sql = new MockSqlStorage();
      const agent = makeAgent(sql);
      mockFetchTechnologySymbols.mockRejectedValue(new Error("screener universe unavailable"));

      await agent.autonomousMarketScreen({ sector: "Technology", maxItems: 5 });

      const sent = broadcasts(agent);
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("market_alert");
      expect(sent[0].title).toBe("Autonomous Screener Failed");
      expect(sent[0].success).toBe(false);
      expect(sent[0].sector).toBe("Technology");
      expect(sent[0].error).toContain("screener universe unavailable");

      const orm = makeOrm(sql);
      expect(orm.events.findMany({ where: { type: "screener.screen_failed" } }).length).toBe(1);
      const messages = orm.messages.findMany({ where: { sessionId } });
      expect(messages.some(m => m.content.includes("Scheduled Market Screen failed"))).toBe(true);
    });

    it("still broadcasts a market screen success with standouts, with the unchanged shape", async () => {
      const sql = new MockSqlStorage();
      const agent = makeAgent(sql);
      mockFetchTechnologySymbols.mockResolvedValue([
        { symbol: "ACME", companyName: "ACME Technology" },
        { symbol: "XYZ", companyName: "XYZ Data Systems" },
      ] as any);
      mockFetchLiveQuotes.mockResolvedValue([
        { symbol: "ACME", companyName: "ACME Technology", lastPrice: 100, changePercent: 2.5 },
        { symbol: "XYZ", companyName: "XYZ Data Systems", lastPrice: 50, changePercent: 0.1 },
      ] as any);
      vi.spyOn(DynamicMarketScreener.prototype, "screenWithQuotes").mockReturnValue({
        totalScanned: 12,
        matchedCount: 2,
        stocks: [
          { symbol: "ACME", signal: "BULLISH_MOMENTUM", momentumScore: 88 },
          { symbol: "XYZ", signal: "NEUTRAL", momentumScore: 10 },
        ],
      } as any);

      await agent.autonomousMarketScreen({ sector: "Technology", maxItems: 5 });

      const sent = broadcasts(agent);
      expect(sent.length).toBe(1);
      expect(sent[0].type).toBe("market_alert");
      expect(sent[0].title).toBe("Autonomous Screener Alert");
      expect(sent[0].count).toBe(1);
      expect(sent[0].success).toBeUndefined();

      const orm = makeOrm(sql);
      expect(orm.events.findMany({ where: { type: "screener.screen_failed" } }).length).toBe(0);
    });
  });
});
