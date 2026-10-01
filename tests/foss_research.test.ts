import { describe, it, expect, beforeEach } from "vitest";
import {
  YahooFinanceProvider,
  AlpacaMarketDataProvider,
  HybridFossProvider,
  FossResearchService,
} from "../src/services/fossResearch";
import { AGENT_DIDS } from "../src/agents/did";
import { McpToolFactory } from "../src/mcp/commands";
import { MCP_RESOURCES, MCP_PROMPTS, readMCPResource } from "../src/mcp/index";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

describe("FOSS Market Research & Quoting (Yahoo Finance & Alpaca APIs)", () => {
  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    SEARCH_AGENT: {} as any,
    ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
    ALPACA_DATA_URL: "https://data.alpaca.markets",
    FOSS_MARKET_DATA_PROVIDER: "hybrid",
  };

  let yfProvider: YahooFinanceProvider;
  let alpacaProvider: AlpacaMarketDataProvider;
  let hybridProvider: HybridFossProvider;
  let researchService: FossResearchService;
  let orm: DatabaseORM;
  const sessionId = "test_research_session_001";
  const userDid = "did:user:github:analyst_user";

  beforeEach(() => {
    yfProvider = new YahooFinanceProvider();
    alpacaProvider = new AlpacaMarketDataProvider();
    hybridProvider = new HybridFossProvider();
    researchService = new FossResearchService(mockEnv);

    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  // =========================================================================
  // 1. Yahoo Finance Provider (yfinance)
  // =========================================================================
  describe("YahooFinanceProvider", () => {
    it("fetches market quote for major equity (NVDA)", async () => {
      const quote = await yfProvider.getQuote("NVDA");
      expect(quote.symbol).toBe("NVDA");
      expect(quote.provider).toBe("yfinance");
      expect(quote.price).toBeGreaterThan(100);
      expect(quote.trailingPE).toBeGreaterThan(0);
      expect(quote.marketCap).toBeGreaterThan(1e12);
      expect(quote.volume).toBeGreaterThan(1e6);
      expect(typeof quote.currency).toBe("string");
    });

    it("fetches comprehensive accounting fundamentals (MSFT)", async () => {
      const fund = await yfProvider.getFundamentals("MSFT");
      expect(fund.symbol).toBe("MSFT");
      expect(fund.companyName).toBe("Microsoft Corporation");
      expect(fund.peForward).toBeGreaterThan(0);
      expect(fund.pegRatio).toBeGreaterThan(0);
      expect(fund.profitMargins).toBeGreaterThan(0);
      expect(fund.recommendationKey).toBeDefined();
      expect(fund.targetMeanPrice).toBeGreaterThan(300);
      expect(fund.marketCap).toBeGreaterThan(1e12);
    });

    it("generates OHLCV historical bars (AAPL)", async () => {
      const bars = await yfProvider.getHistoricalBars("AAPL", "1D", 30);
      expect(bars).toBeInstanceOf(Array);
      expect(bars.length).toBe(30);
      const firstBar = bars[0];
      expect(firstBar.open).toBeGreaterThan(0);
      expect(firstBar.high).toBeGreaterThanOrEqual(firstBar.low);
      expect(firstBar.volume).toBeGreaterThan(0);
      expect(firstBar.timestamp).toBeDefined();
    });

    it("generates deterministic fallback for unknown tickers", async () => {
      const quote = await yfProvider.getQuote("CUSTOMCORP");
      expect(quote.symbol).toBe("CUSTOMCORP");
      expect(quote.price).toBeGreaterThan(10);
      expect(quote.marketCap).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 2. Alpaca Market Data Provider
  // =========================================================================
  describe("AlpacaMarketDataProvider", () => {
    it("fetches Level 1 real-time quote with NBBO bid/ask (AAPL)", async () => {
      const quote = await alpacaProvider.getQuote("AAPL");
      expect(quote.symbol).toBe("AAPL");
      expect(quote.provider).toBe("alpaca");
      expect(quote.price).toBeGreaterThan(100);
      expect(quote.bid).toBeDefined();
      expect(quote.ask).toBeDefined();
      expect(quote.ask).toBeGreaterThanOrEqual(quote.bid!);
    });

    it("fetches full Level 1/2 market snapshot (NVDA)", async () => {
      const snapshot = await alpacaProvider.getMarketSnapshot("NVDA");
      expect(snapshot.symbol).toBe("NVDA");
      expect(snapshot.latestTrade.price).toBeGreaterThan(0);
      expect(snapshot.latestQuote.bidPrice).toBeGreaterThan(0);
      expect(snapshot.latestQuote.askPrice).toBeGreaterThanOrEqual(snapshot.latestQuote.bidPrice);
      expect(snapshot.nbboSpread).toBeCloseTo(
        snapshot.latestQuote.askPrice - snapshot.latestQuote.bidPrice,
        2
      );
      expect(snapshot.dailyBar.volume).toBeGreaterThan(0);
      expect(snapshot.prevDailyBar.close).toBeGreaterThan(0);
    });

    it("supports crypto trading pairs (BTC/USD)", async () => {
      const btcQuote = await alpacaProvider.getQuote("BTC/USD");
      expect(btcQuote.symbol).toBe("BTC/USD");
      expect(btcQuote.price).toBeGreaterThan(10000);

      const btcSnapshot = await alpacaProvider.getMarketSnapshot("BTC/USD");
      expect(btcSnapshot.symbol).toBe("BTC/USD");
      expect(btcSnapshot.latestTrade.price).toBeGreaterThan(10000);
    });
  });

  // =========================================================================
  // 3. Hybrid FOSS Provider
  // =========================================================================
  describe("HybridFossProvider (Alpaca Real-Time + YFinance Valuation)", () => {
    it("blends Alpaca real-time pricing with Yahoo Finance valuation multiples", async () => {
      const hybridQuote = await hybridProvider.getQuote("GOOGL");
      expect(hybridQuote.symbol).toBe("GOOGL");
      expect(hybridQuote.provider).toBe("hybrid");
      expect(hybridQuote.bid).toBeDefined();
      expect(hybridQuote.ask).toBeDefined();
      expect(hybridQuote.trailingPE).toBeGreaterThan(0);
      expect(hybridQuote.marketCap).toBeGreaterThan(1e12);
    });
  });

  // =========================================================================
  // 4. FossResearchService Facade & Autonomous Agent Attestation
  // =========================================================================
  describe("FossResearchService Facade", () => {
    it("generates an autonomous equity research report with W3C Agent DID attestation", async () => {
      const report = await researchService.generateResearchReport("NVDA");
      expect(report.symbol).toBe("NVDA");
      expect(report.fundamentals.companyName).toBe("NVIDIA Corporation");
      expect(report.quote.price).toBeGreaterThan(100);
      expect(report.analystRating).toBe("STRONG BUY");
      expect(report.fundamentals.targetMeanPrice).toBeGreaterThan(report.quote.price);
      expect(report.fundamentals.peTrailing).toBeGreaterThan(0);
      expect(report.fundamentals.pegRatio).toBeGreaterThan(0);
      expect(report.aiAnalysis).toContain("NVIDIA");
      expect(report.bars.length).toBeGreaterThanOrEqual(15);
      expect(report.technicalSummary.rsi14).toBeGreaterThan(0);

      // Verify W3C Agent Cryptographic Attestation
      expect(report.agentAttestation.did).toBe(AGENT_DIDS.RESEARCH);
      expect(report.agentAttestation.did).toBe("did:agent:openaimp:research");
      expect(report.agentAttestation.signature).toMatch(/^sig_/);
    });

    it("compares multi-ticker valuation metrics across peers", async () => {
      const comparison = await researchService.compareStocks(["NVDA", "AMD", "MSFT"]);
      expect(comparison.length).toBe(3);
      expect(comparison.map(c => c.symbol)).toEqual(["NVDA", "AMD", "MSFT"]);

      const nvda = comparison.find((d) => d.symbol === "NVDA");
      const amd = comparison.find((d) => d.symbol === "AMD");
      expect(nvda).toBeDefined();
      expect(amd).toBeDefined();
      expect(nvda?.quote.price).toBeGreaterThan(0);
      expect(amd?.quote.price).toBeGreaterThan(0);
    });

    it("inspects live health status of FOSS data providers", async () => {
      const statuses = await researchService.getProviderStatuses();
      expect(statuses.length).toBe(3);
      const yf = statuses.find((s) => s.provider === "yfinance");
      const alpaca = statuses.find((s) => s.provider === "alpaca");
      expect(yf?.configured).toBe(true);
      expect(alpaca?.configured).toBe(false);
    });
  });

  // =========================================================================
  // 5. GoF MCP Tool Commands Integration
  // =========================================================================
  describe("GoF MCP Tool Commands", () => {
    const getContext = () => ({
      env: mockEnv,
      orm,
      sessionId,
      audit: () => {},
    });

    it("executes foss_get_quote tool via McpToolFactory", async () => {
      const result = await McpToolFactory.executeTool("foss_get_quote", {
        symbol: "TSLA",
        provider: "hybrid",
      }, getContext());

      expect(result.symbol).toBe("TSLA");
      expect(result.price).toBeGreaterThan(0);
      expect(result.provider).toBeDefined();
    });

    it("executes foss_company_fundamentals tool via McpToolFactory", async () => {
      const result = await McpToolFactory.executeTool("foss_company_fundamentals", {
        symbol: "AAPL",
      }, getContext());

      expect(result.symbol).toBe("AAPL");
      expect(result.peTrailing).toBeGreaterThan(0);
      expect(result.marketCap).toBeGreaterThan(0);
    });

    it("executes foss_historical_bars tool via McpToolFactory", async () => {
      const result = await McpToolFactory.executeTool("foss_historical_bars", {
        symbol: "AMZN",
        period: "1mo",
        timeframe: "1d",
      }, getContext());

      expect(result.symbol).toBe("AMZN");
      expect(result.bars).toBeInstanceOf(Array);
      expect(result.bars.length).toBeGreaterThan(0);
    });

    it("executes foss_market_research tool via McpToolFactory", async () => {
      const result = await McpToolFactory.executeTool("foss_market_research", {
        symbol: "PLTR",
      }, getContext());

      expect(result.symbol).toBe("PLTR");
      expect(result.agentAttestation.did).toBe(AGENT_DIDS.RESEARCH);
      expect(result.aiAnalysis).toBeDefined();
      expect(result.bars.length).toBeGreaterThan(0);
    });

    it("executes foss_alpaca_snapshot tool via McpToolFactory with audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("foss_alpaca_snapshot", {
        symbol: "BTC/USD",
      }, ctx);

      expect(result.symbol).toBe("BTC/USD");
      expect(result.latestTrade).toBeDefined();
      expect(result.latestQuote).toBeDefined();
      expect(audits.some((a) => a.type === "foss.alpaca.snapshot" && a.domain === "research")).toBe(true);
    });

    it("executes foss_alpaca_account tool via McpToolFactory with agentic DID audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("foss_alpaca_account", {}, ctx);
      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.account.query" && a.domain === "trading")).toBe(true);
    });

    it("executes foss_alpaca_positions tool via McpToolFactory with agentic DID audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("foss_alpaca_positions", {}, ctx);
      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.positions.query" && a.domain === "trading")).toBe(true);
    });

    it("executes foss_alpaca_orders tool via McpToolFactory with status filter and audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("foss_alpaca_orders", { status: "all" }, ctx);
      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.orders.query" && a.payload.status === "all")).toBe(true);
    });

    it("executes foss_alpaca_place_order tool via McpToolFactory with agentic DID audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("foss_alpaca_place_order", {
        symbol: "NVDA",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: 120.5,
      }, ctx);

      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.order.place" && a.payload.symbol === "NVDA")).toBe(true);
    });

    it("supports both ALPACA_API_KEY and ALPACA_API_KEY_ID environment variable configurations", () => {
      const envWithStandardKey: Env = {
        ...mockEnv,
        ALPACA_API_KEY: "test_key_alpaca",
        ALPACA_SECRET_KEY: "test_secret_alpaca",
      };
      const provider1 = new AlpacaMarketDataProvider(envWithStandardKey);
      expect(provider1.getApiKey()).toBe("test_key_alpaca");
      expect(provider1.getApiSecret()).toBe("test_secret_alpaca");
      expect(provider1.isConfigured()).toBe(true);

      const service = new FossResearchService(envWithStandardKey);
      const statuses = service.getProviderStatuses();
      const alpacaStatus = statuses.find((s) => s.provider === "alpaca");
      expect(alpacaStatus?.configured).toBe(true);
      expect(alpacaStatus?.mode).toBe("live_api");
    });
  });

  // =========================================================================
  // 6. MCP Protocol Resources & Prompts
  // =========================================================================
  describe("MCP Resources & Prompts", () => {
    it("exposes FOSS market resources in MCP_RESOURCES", () => {
      const uris = MCP_RESOURCES.map((r) => r.uri);
      expect(uris).toContain("foss://market/quote/NVDA");
      expect(uris).toContain("foss://research/fundamentals/NVDA");
      expect(uris).toContain("foss://providers/status");
    });

    it("reads foss quote resource dynamically", async () => {
      const res = await readMCPResource("foss://market/quote/NVDA", { orm, sessionId });
      expect(res.uri).toBe("foss://market/quote/NVDA");
      const parsed = JSON.parse(res.text);
      expect(parsed.symbol).toBe("NVDA");
      expect(parsed.price).toBeGreaterThan(0);
    });

    it("reads foss providers status resource", async () => {
      const res = await readMCPResource("foss://providers/status", { orm, sessionId });
      expect(res.uri).toBe("foss://providers/status");
      const parsed = JSON.parse(res.text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((p: any) => p.provider === "yfinance")).toBe(true);
    });

    it("exposes and renders foss_equity_research_report prompt", () => {
      const prompt = MCP_PROMPTS.find((p) => p.name === "foss_equity_research_report");
      expect(prompt).toBeDefined();
      expect(prompt?.description).toContain("equity research report");
      expect(prompt?.arguments?.some((a) => a.name === "symbol")).toBe(true);
    });
  });

  // =========================================================================
  // 7. Natural Language Query (NLQ) Routing & Execution
  // =========================================================================
  describe("NLQ Agentic Research & Quoting Integration", () => {
    it("plans NLQ query for equity research (research NVDA)", async () => {
      const plan = await planNLQ(mockEnv, "Perform FOSS equity research on NVDA using yfinance and Alpaca");
      expect(plan.domain).toBe("research");
      expect(plan.researchData?.action).toBe("report");
      expect(plan.researchData?.symbol).toBe("NVDA");
    });

    it("plans NLQ query for market quote (quote BTC/USD)", async () => {
      const plan = await planNLQ(mockEnv, "Get live Alpaca quote and NBBO spread for BTC/USD");
      expect(plan.domain).toBe("research");
      expect(plan.researchData?.action).toBe("quote");
      expect(plan.researchData?.symbol).toBe("BTC/USD");
    });

    it("plans NLQ query for stock comparison (compare NVDA and AMD)", async () => {
      const plan = await planNLQ(mockEnv, "Compare valuation multiples between NVDA and AMD");
      expect(plan.domain).toBe("research");
      expect(plan.researchData?.action).toBe("compare");
      expect(plan.researchData?.symbols).toContain("NVDA");
      expect(plan.researchData?.symbols).toContain("AMD");
    });

    it("executes NLQ research report query and returns formatted rows & summary card", async () => {
      const plan = await planNLQ(mockEnv, "Run deep research on NVDA");
      const result = executeNLQQuery(orm, sessionId, plan, mockEnv, userDid);

      expect(result.domain).toBe("research");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.summary).toContain("NVDA");
      expect(result.summary).toContain("Target:");
      expect(result.summary).toContain("Consensus:");
    });

    it("executes NLQ quote query and returns real-time quote metrics", async () => {
      const plan = await planNLQ(mockEnv, "Get FOSS quote for AAPL on yfinance");
      const result = executeNLQQuery(orm, sessionId, plan, mockEnv, userDid);

      expect(result.domain).toBe("research");
      expect(result.rows[0].symbol).toBe("AAPL");
      expect(result.rows[0].price).toBeDefined();
    });

    it("executes NLQ comparison query and returns side-by-side valuation grid", async () => {
      const plan = await planNLQ(mockEnv, "Compare valuation of NVDA and AMD");
      const result = executeNLQQuery(orm, sessionId, plan, mockEnv, userDid);

      expect(result.domain).toBe("research");
      expect(result.rows.length).toBe(2);
      expect(result.rows.some((r) => r.symbol === "NVDA")).toBe(true);
      expect(result.rows.some((r) => r.symbol === "AMD")).toBe(true);
    });
  });
});
