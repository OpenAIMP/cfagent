import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { AGENT_DIDS } from "../src/agents/did";
import { McpToolFactory } from "../src/mcp/commands";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import type { Env } from "../src/types";

describe("E*TRADE Agentic Trading Hub & Screening Engine", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let etrade: ETradeService;
  const sessionId = "trader_session_001";
  const userDid = "did:user:github:trader_user";

  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    SEARCH_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
  };

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    etrade = new ETradeService(orm, mockEnv);
  });

  // =========================================================================
  // 1. Market Screener & Scanning Engine
  // =========================================================================
  describe("Market Screener & Technical Scanning", () => {
    it("screens default universe and returns technical indicators and AI signals", () => {
      const result = etrade.screenStocks({});
      expect(result.stocks.length).toBeGreaterThanOrEqual(10);
      expect(result.totalScreened).toBeGreaterThanOrEqual(10);

      const nvda = result.stocks.find((s) => s.symbol === "NVDA");
      expect(nvda).toBeDefined();
      expect(nvda?.price).toBeGreaterThan(100);
      expect(nvda?.rsi14).toBeDefined();
      expect(nvda?.macdSignal).toBeDefined();
      expect(nvda?.sector).toBe("Semiconductors");
      expect(["BULLISH_MOMENTUM", "OVERSOLD_BOUNCE", "RANGE_BOUND", "OVERBOUGHT"]).toContain(nvda?.signal);
    });

    it("filters equities by sector (e.g. Technology or Semiconductors)", () => {
      const techResult = etrade.screenStocks({ sector: "Semiconductors" });
      expect(techResult.stocks.length).toBeGreaterThanOrEqual(2);
      expect(techResult.stocks.every((s) => s.sector === "Semiconductors")).toBe(true);
      expect(techResult.stocks.some((s) => s.symbol === "NVDA")).toBe(true);
      expect(techResult.stocks.some((s) => s.symbol === "AMD")).toBe(true);
    });

    it("filters equities by RSI (e.g. oversold maxRsi < 40 or momentum minRsi > 55)", () => {
      const momentumStocks = etrade.screenStocks({ minRsi: 55 });
      expect(momentumStocks.stocks.every((s) => s.rsi14 >= 55)).toBe(true);

      const oversoldStocks = etrade.screenStocks({ maxRsi: 40 });
      expect(oversoldStocks.stocks.every((s) => s.rsi14 <= 40)).toBe(true);
    });

    it("filters equities by price movement (gainersOnly / losersOnly)", () => {
      const gainers = etrade.screenStocks({ gainersOnly: true });
      expect(gainers.stocks.every((s) => s.changePercent >= 0)).toBe(true);

      const losers = etrade.screenStocks({ losersOnly: true });
      expect(losers.stocks.every((s) => s.changePercent <= 0)).toBe(true);
    });

    it("filters equities by minimum market capitalization", () => {
      const megaCaps = etrade.screenStocks({ minMarketCap: 1_000_000_000_000 }); // $1T+
      expect(megaCaps.stocks.every((s) => s.marketCap >= 1_000_000_000_000)).toBe(true);
      expect(megaCaps.stocks.some((s) => s.symbol === "MSFT" || s.symbol === "AAPL" || s.symbol === "NVDA")).toBe(true);
    });
  });

  // =========================================================================
  // 2. Real-Time Quotes
  // =========================================================================
  describe("Real-Time Quotes", () => {
    it("retrieves real-time quote with bid, ask, and 52-week statistics", () => {
      const quote = etrade.getQuote("NVDA");
      expect(quote.symbol).toBe("NVDA");
      expect(quote.companyName).toBe("NVIDIA Corporation");
      expect(quote.lastPrice).toBeGreaterThan(0);
      expect(quote.bid).toBeLessThanOrEqual(quote.ask);
      expect(quote.volume).toBeGreaterThan(1_000_000);
      expect(quote.high52).toBeGreaterThan(quote.low52);
    });

    it("generates deterministic quote for any custom ticker", () => {
      const quote = etrade.getQuote("GOOGL");
      expect(quote.symbol).toBe("GOOGL");
      expect(quote.lastPrice).toBeGreaterThan(0);
      expect(quote.bid).toBeGreaterThan(0);
      expect(quote.ask).toBeGreaterThanOrEqual(quote.bid);
    });
  });

  // =========================================================================
  // 3. Human-in-the-Loop (HITL) Order Preview & Execution with DIDs
  // =========================================================================
  describe("HITL Order Preview & Execution with Agent DIDs", () => {
    it("previews an order draft, stamps Agent DID, and saves to SQLite mas_trades", () => {
      const draft = etrade.previewOrder({
        sessionId,
        symbol: "NVDA",
        orderAction: "BUY",
        quantity: 15,
        orderType: "MARKET",
      });

      expect(draft.orderId).toMatch(/^ord_[a-f0-9]{8}$/);
      expect(draft.symbol).toBe("NVDA");
      expect(draft.orderAction).toBe("BUY");
      expect(draft.quantity).toBe(15);
      expect(draft.estimatedPrice).toBeGreaterThan(0);
      expect(draft.estimatedTotal).toBeGreaterThan(0);
      expect(draft.status).toBe("previewed");
      expect(draft.proposerDid).toBe(AGENT_DIDS.TRADING);
      expect(draft.proofSignature).toMatch(/^sig_0x/);

      // Verify persisted in mas_trades ORM repository
      const saved = orm.trades.findById(draft.orderId);
      expect(saved).toBeDefined();
      expect(saved?.symbol).toBe("NVDA");
      expect(saved?.action).toBe("BUY");
      expect(saved?.quantity).toBe(15);
      expect(saved?.proposerDid).toBe(AGENT_DIDS.TRADING);
      expect(saved?.status).toBe("previewed");
    });

    it("executes confirmed order draft after explicit human authorization", () => {
      const draft = etrade.previewOrder({
        sessionId,
        symbol: "MSFT",
        orderAction: "BUY",
        quantity: 5,
        orderType: "MARKET",
      });

      const execResult = etrade.executeOrder(draft.orderId, userDid, "approved");
      expect(execResult.success).toBe(true);
      expect(execResult.status).toBe("executed");
      expect(execResult.orderId).toBe(draft.orderId);
      expect(execResult.authorizerDid).toBe(userDid);
      expect(execResult.executionId).toBeDefined();

      // Verify database update
      const updated = orm.trades.findById(draft.orderId);
      expect(updated?.status).toBe("executed");
      expect(updated?.authorizerDid).toBe(userDid);
      expect(updated?.orderRef).toBe(execResult.executionId);
    });

    it("rejects an order draft when human authorizer declines", () => {
      const draft = etrade.previewOrder({
        sessionId,
        symbol: "TSLA",
        orderAction: "SELL",
        quantity: 10,
      });

      const execResult = etrade.executeOrder(draft.orderId, userDid, "rejected");
      expect(execResult.success).toBe(false);
      expect(execResult.status).toBe("rejected");

      const updated = orm.trades.findById(draft.orderId);
      expect(updated?.status).toBe("rejected");
    });

    it("retrieves open broker positions and portfolio balances", () => {
      const initial = etrade.getPositions();
      expect(initial.account.accountId).toBeDefined();
      expect(initial.positions).toEqual([]);

      // Execute confirmed trade to verify dynamic position calculation without hardcoding
      const draft = etrade.previewOrder({ sessionId, symbol: "NVDA", orderAction: "BUY", quantity: 15 });
      etrade.executeOrder(draft.orderId, userDid, "approved");

      const portfolio = etrade.getPositions();
      expect(portfolio.account.totalAccountValue).toBeGreaterThan(0);
      expect(portfolio.positions.length).toBe(1);

      const firstPos = portfolio.positions[0];
      expect(firstPos.symbol).toBe("NVDA");
      expect(firstPos.quantity).toBe(15);
      expect(firstPos.costBasis).toBeGreaterThan(0);
      expect(firstPos.marketPrice).toBeGreaterThan(0);
      expect(firstPos.marketValue).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. Model Context Protocol (MCP) Trading Commands
  // =========================================================================
  describe("E*TRADE Model Context Protocol (MCP) Commands", () => {
    const auditMock = vi.fn();
    const mcpContext = {
      get env() { return mockEnv; },
      get orm() { return orm; },
      sessionId,
      audit: auditMock,
    };

    it("etrade_market_scan: screens market and returns structured results", async () => {
      const cmd = McpToolFactory.getTool("etrade_market_scan");
      expect(cmd).toBeDefined();

      const res = await cmd.execute({ sector: "Semiconductors", minRsi: 50 }, mcpContext);
      expect(res.stocks.length).toBeGreaterThan(0);
      expect(res.totalScreened).toBeGreaterThan(0);
      expect(auditMock).toHaveBeenCalledWith("etrade.market_scanned", "trading", expect.any(Object));
    });

    it("etrade_get_quote: retrieves real-time quote", async () => {
      const cmd = McpToolFactory.getTool("etrade_get_quote");
      expect(cmd).toBeDefined();

      const quote = await cmd.execute({ symbol: "AAPL" }, mcpContext);
      expect(quote.symbol).toBe("AAPL");
      expect(quote.lastPrice).toBeGreaterThan(0);
      expect(quote.bid).toBeGreaterThan(0);
    });

    it("etrade_preview_order: drafts order preview with safety guarantees", async () => {
      const cmd = McpToolFactory.getTool("etrade_preview_order");
      expect(cmd).toBeDefined();

      const preview = await cmd.execute(
        {
          symbol: "AMD",
          orderAction: "BUY",
          quantity: 20,
          orderType: "MARKET",
        },
        mcpContext
      );

      expect(preview.orderId).toMatch(/^ord_/);
      expect(preview.proposerDid).toBe(AGENT_DIDS.TRADING);
      expect(preview.status).toBe("previewed");
      expect(preview.safetyNotice).toContain("HUMAN APPROVAL REQUIRED");
    });

    it("etrade_execute_order: executes previewed draft upon human confirmation", async () => {
      // First preview
      const previewCmd = McpToolFactory.getTool("etrade_preview_order");
      const draft = await previewCmd.execute(
        { symbol: "PLTR", orderAction: "BUY", quantity: 50 },
        mcpContext
      );

      // Now execute
      const execCmd = McpToolFactory.getTool("etrade_execute_order");
      const executed = await execCmd.execute(
        { orderId: draft.orderId, decision: "approved" },
        mcpContext
      );

      expect(executed.success).toBe(true);
      expect(executed.status).toBe("executed");
      expect(executed.orderId).toBe(draft.orderId);
    });

    it("etrade_get_positions: returns broker account holdings", async () => {
      const cmd = McpToolFactory.getTool("etrade_get_positions");
      const pos = await cmd.execute({}, mcpContext);
      expect(pos.account).toBeDefined();
      expect(Array.isArray(pos.positions)).toBe(true);
    });
  });

  // =========================================================================
  // 5. Natural Language Query (NLQ) Trading Interface
  // =========================================================================
  describe("Natural Language Query (NLQ) Trading Integration", () => {
    it("NLQ classifies 'screen tech stocks with RSI < 35' into trading domain", async () => {
      const plan = await planNLQ(mockEnv, "screen tech stocks with RSI < 35");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.sector).toBe("Technology");
      expect(plan.tradingData?.filters?.maxRsi).toBe(35);

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.rows).toBeDefined();
    });

    it("NLQ classifies 'quote NVDA' and returns real-time quote card", async () => {
      const plan = await planNLQ(mockEnv, "quote NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("quote");
      expect(plan.tradingData?.symbol).toBe("NVDA");

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      expect(result.rows[0].symbol).toBe("NVDA");
      expect(result.rows[0].lastPrice).toBeDefined();
    });

    it("NLQ classifies 'buy 10 shares of NVDA' and creates order draft preview", async () => {
      const plan = await planNLQ(mockEnv, "buy 10 shares of NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("preview_order");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.quantity).toBe(10);
      expect(plan.tradingData?.orderAction).toBe("BUY");

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      expect(result.rows[0].orderId).toMatch(/^ord_/);
      expect(result.rows[0].status).toBe("PREVIEWED");
      expect(result.rows[0].proposerDid).toBe(AGENT_DIDS.TRADING);

      // Verify draft exists in database
      const draft = orm.trades.findById(result.rows[0].orderId as string);
      expect(draft).toBeDefined();
      expect(draft?.symbol).toBe("NVDA");
      expect(draft?.quantity).toBe(10);
    });

    it("NLQ classifies 'show my portfolio positions' and returns holdings", async () => {
      // Execute trade draft first
      const draft = etrade.previewOrder({ sessionId, symbol: "MSFT", orderAction: "BUY", quantity: 10 });
      etrade.executeOrder(draft.orderId, userDid, "approved");

      const plan = await planNLQ(mockEnv, "show my portfolio positions");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("positions");

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.count).toBeGreaterThan(0);
      expect(result.rows[0].symbol).toBeDefined();
      expect(result.rows[0].marketValue).toBeDefined();
    });

    it("NLQ classifies 'Quote NVDA' and executeNLQQueryAsync fetches live quote with formatted market cap", async () => {
      const { executeNLQQueryAsync } = await import("../src/agents/nlq");
      const plan = await planNLQ(mockEnv, "Quote NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("quote");
      expect(plan.tradingData?.symbol).toBe("NVDA");

      const result = await executeNLQQueryAsync(orm, sessionId, plan, mockEnv);
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      const row = result.rows[0];
      expect(row.symbol).toBe("NVDA");
      expect(row.lastPrice).toBeDefined();
      expect(row.marketCap).not.toBe("$0.0B");
      expect(row.marketCap).toMatch(/\$[0-9.]+[TB]/);
      expect(row.source).toMatch(/Live|Market/);
    });

    it("DynamicMarketScreener.screenMarkets enriches stocks with real-time quotes", async () => {
      const result = await etrade.screenMarketsAsync({ sector: "Semiconductors", limit: 3 });
      expect(result.stocks.length).toBeGreaterThan(0);
      expect(result.stocks[0].price).toBeGreaterThan(0);
      expect(result.stocks[0].marketCap).toBeGreaterThan(0);
    });

    it("NLQ classifies 'Preview buy 10 shares of NVDA at market' and executeNLQQueryAsync drafts order with live quote", async () => {
      const { executeNLQQueryAsync } = await import("../src/agents/nlq");
      const plan = await planNLQ(mockEnv, "Preview buy 10 shares of NVDA at market");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("preview_order");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.quantity).toBe(10);

      const result = await executeNLQQueryAsync(orm, sessionId, plan, mockEnv);
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      const row = result.rows[0];
      expect(row.symbol).toBe("NVDA");
      expect(row.quantity).toBe(10);
      expect(row.action).toBe("BUY");
      expect(row.estimatedPrice).toBeDefined();
      expect(row.estimatedTotal).toBeDefined();
      expect(row.status).toBe("PREVIEWED");
    });
  });

  // =========================================================================
  // 6. Security Layer & Aspect-Oriented Sandbox Guards
  // =========================================================================
  describe("Security Layer & Aspect-Oriented Sandbox Guards", () => {
    it("etrade_auth_status MCP command inspects token health and active environment", async () => {
      const res = await McpToolFactory.executeTool("etrade_auth_status", {}, {
        env: mockEnv,
        orm,
        sessionId,
        audit: vi.fn(),
      });
      expect(res.broker).toBe("etrade");
      expect(res.environment).toBe("sandbox");
      expect(res.activeEnvironment).toBeDefined();
    });

    it("etrade_account_discovery MCP command discovers account list via real API contract", async () => {
      const res = await McpToolFactory.executeTool("etrade_account_discovery", {}, {
        env: mockEnv,
        orm,
        sessionId,
        audit: vi.fn(),
      });
      expect(res.accounts).toBeDefined();
      expect(Array.isArray(res.accounts)).toBe(true);
      expect(res.count).toBe(res.accounts.length);
    });

    it("assertSandboxUrlSafety blocks outgoing calls to live production when isLive is false", async () => {
      const { assertSandboxUrlSafety } = await import("../src/aspects/loggingAspect");
      const { ETradeErrorCode } = await import("../src/aspects/errorCodes");

      expect(() => {
        assertSandboxUrlSafety("https://api.etrade.com/v1/market/quote/NVDA.json", false);
      }).toThrowError(/SECURITY VIOLATION/);

      // Safe sandbox URLs must be allowed
      expect(() => {
        assertSandboxUrlSafety("https://apisb.etrade.com/v1/market/quote/NVDA.json", false);
      }).not.toThrow();

      // In live production mode, api.etrade.com must be allowed
      expect(() => {
        assertSandboxUrlSafety("https://api.etrade.com/v1/market/quote/NVDA.json", true);
      }).not.toThrow();
    });

    it("fetchQuoteRemote rejects E*TRADE Sandbox Google mock stubs and returns authentic equity quotes", async () => {
      // NVDA quote must have NVIDIA Corporation and authentic pricing, NOT GOOGLE INC CL A or 577.51
      const nvda = await etrade.fetchQuoteRemote("NVDA");
      expect(nvda.symbol).toBe("NVDA");
      expect(nvda.companyName).toBe("NVIDIA Corporation");
      expect(nvda.companyName).not.toContain("GOOGLE INC");
      expect(nvda.lastPrice).not.toBe(577.51);
      expect(nvda.lastPrice).toBe(228.38);

      // AAPL quote must have Apple Inc. and authentic pricing, NOT GOOGLE INC CL A or 577.51
      const aapl = await etrade.fetchQuoteRemote("AAPL");
      expect(aapl.symbol).toBe("AAPL");
      expect(aapl.companyName).toBe("Apple Inc.");
      expect(aapl.companyName).not.toContain("GOOGLE INC");
      expect(aapl.lastPrice).not.toBe(577.51);

      // MSFT quote must have Microsoft Corporation and authentic pricing, NOT GOOGLE INC CL A or 577.51
      const msft = await etrade.fetchQuoteRemote("MSFT");
      expect(msft.symbol).toBe("MSFT");
      expect(msft.companyName).toBe("Microsoft Corporation");
      expect(msft.companyName).not.toContain("GOOGLE INC");
      expect(msft.lastPrice).not.toBe(577.51);
    });
  });
});

