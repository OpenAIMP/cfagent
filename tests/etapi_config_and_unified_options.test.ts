import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getEtapiConfig,
  getScreenerConfig,
  getStrategyEngineConfig,
  getOpportunityScannerConfig,
  getLlmIdeasConfig,
  getAiConfig,
  getVoiceConfig,
  getTradingConstraints,
  getExternalApisConfig,
  getAvailableAiModels,
  setRuntimeEtapiConfigOverrides,
} from "../src/config/etapiConfig";
import { resolveAiModelName } from "../src/agents/model";
import { normalizeVoiceTradingTranscript } from "../src/trading/voice/agent";
import { DynamicMarketScreener } from "../src/trading/screener";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import type { Env, ETradeOptionChain, ScreenedStockItem } from "../src/types";

describe("ETAPI Externalized Configuration & Unified Options Service", () => {
  beforeEach(() => {
    setRuntimeEtapiConfigOverrides(null);
  });

  afterEach(() => {
    setRuntimeEtapiConfigOverrides(null);
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("loads defaults and respects environment overrides without code changes", () => {
    const prodConfig = getEtapiConfig({ APP_ENV: "PROD" });
    expect(prodConfig.screener.maxScanSymbols).toBe(20);
    expect(prodConfig.screener.defaultMaxDte).toBe(90);
    expect(prodConfig.strategyEngine.riskFreeRate).toBe(0.04);
    expect(prodConfig.strategyEngine.feePerContract).toBe(0.65);
    expect(prodConfig.opportunityScanner.concurrency).toBe(3);
    expect(prodConfig.llmIdeas.inputTokenBudget).toBe(90000);

    const testConfig = getEtapiConfig({ APP_ENV: "TEST" });
    expect(testConfig.screener.maxScanSymbols).toBe(10);
    expect(testConfig.screener.symbolFetchConcurrency).toBe(2);
    expect(testConfig.client.defaultTimeoutMs).toBe(20000);
  });

  it("accepts runtime JSON string overrides via env.ETAPI_CONFIG", () => {
    const customConfig = getEtapiConfig({
      ETAPI_CONFIG: JSON.stringify({
        screener: { maxScanSymbols: 55, defaultMaxDte: 120 },
        strategyEngine: { riskFreeRate: 0.0525, feePerContract: 0.50 },
      }),
    });

    expect(customConfig.screener.maxScanSymbols).toBe(55);
    expect(customConfig.screener.defaultMaxDte).toBe(120);
    expect(customConfig.strategyEngine.riskFreeRate).toBe(0.0525);
    expect(customConfig.strategyEngine.feePerContract).toBe(0.50);
  });

  it("allows in-memory runtime overrides via setRuntimeEtapiConfigOverrides", () => {
    setRuntimeEtapiConfigOverrides({
      screener: {
        maxScanSymbols: 8,
        maxExpirationsPerSymbol: 5,
        defaultMaxDte: 45,
        defaultMinDte: 0,
        defaultQuoteAgeSeconds: 30,
        maxReturnedContracts: 50,
        maxRejectionsReturned: 10,
        symbolFetchConcurrency: 1,
        expiryFetchConcurrency: 1,
        unusualVolumeOiRatio: 2.0,
        highDeltaThreshold: 0.8,
        highIvThreshold: 0.85,
        lowIvThreshold: 0.2,
        atmBandPct: 0.03,
      },
    });

    const screenerCfg = getScreenerConfig();
    expect(screenerCfg.maxScanSymbols).toBe(8);
    expect(screenerCfg.defaultMaxDte).toBe(45);
    expect(screenerCfg.atmBandPct).toBe(0.03);
  });

  it("DynamicOptionsScreener reflects custom config parameters", () => {
    const customScreener = new DynamicOptionsScreener(undefined, {
      maxScanSymbols: 7,
      maxReturnedContracts: 25,
      atmBandPct: 0.05,
    });

    expect(customScreener.config.maxScanSymbols).toBe(7);
    expect(customScreener.config.maxReturnedContracts).toBe(25);
    expect(customScreener.config.atmBandPct).toBe(0.05);
  });

  it("UnifiedOptionsService formats outputs uniformly for UI, Slack, Email, Voice, and Webhook channels", async () => {
    const mockFixture: ETradeOptionChain = {
      symbol: "NVDA",
      underlyingPrice: 130,
      quoteTime: Date.now(),
      selectedExpiry: { year: 2026, month: 11, day: 20 },
      pairs: [
        {
          call: {
            symbol: "NVDA",
            optionType: "CALL",
            strikePrice: 135,
            bid: 4.5,
            ask: 4.8,
            volume: 500,
            openInterest: 1200,
            impliedVolatility: 0.45,
            delta: 0.55,
            gamma: 0.04,
            theta: -0.05,
            vega: 0.12,
            rho: 0.02,
          },
        },
      ],
    };
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: mockFixture });

    const mockEnv: Partial<Env> = {
      ETRADE_ENVIRONMENT: "sandbox",
    };

    const service = new UnifiedOptionsService(mockEnv as Env);
    const result = await service.execute({
      action: "screen",
      symbol: "NVDA",
      channel: "slack",
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe("screen");

    // 1. UI format
    const uiOutput = result.toUi();
    expect(uiOutput.success).toBe(true);
    expect(uiOutput.status).toBe("matches_found");
    expect(uiOutput.action).toBe("screen");

    // 2. Slack format
    const slackOutput = result.toSlack();
    expect(slackOutput.blocks).toBeDefined();
    expect(slackOutput.blocks.length).toBeGreaterThan(0);
    expect(slackOutput.text).toContain("Screened");

    // 3. Email HTML & Text format
    const emailHtml = result.toEmailHtml();
    expect(emailHtml).toContain("E*TRADE Options Intelligence: NVDA");
    const emailText = result.toEmailText();
    expect(emailText).toContain("E*TRADE Options Intelligence");

    // 4. Voice format
    const voiceOutput = result.toVoice();
    expect(voiceOutput.spokenText).toBeDefined();
    expect(voiceOutput.displayMarkdown).toContain("Options Analysis: NVDA");

    // 5. Webhook format
    const webhookOutput = result.toWebhook();
    expect(webhookOutput.status).toBe("success");
    expect(webhookOutput.result).toBeDefined();

    // 6. MCP format
    const mcpOutput = result.toMcp();
    expect(mcpOutput.content).toBeDefined();
  });

  it("handles unified action: config across omnichannel formatters", async () => {
    const mockEnv: Partial<Env> = {
      APP_ENV: "PROD",
      ETRADE_ENVIRONMENT: "live",
    };
    const service = new UnifiedOptionsService(mockEnv as Env);
    const configResult = await service.execute({
      action: "config",
    });

    expect(configResult.success).toBe(true);
    expect(configResult.action).toBe("config");
    expect(configResult.summary).toContain("Risk-Free Rate");

    const slack = configResult.toSlack();
    expect(slack.blocks.length).toBeGreaterThan(1);
    expect(JSON.stringify(slack.blocks)).toContain("Risk-Free Rate");

    const email = configResult.toEmailHtml();
    expect(email).toContain("ETAPI Runtime Parameters");

    const voice = configResult.toVoice();
    expect(voice.spokenText).toContain("Risk-Free Rate");

    const webhook = configResult.toWebhook();
    expect(webhook.status).toBe("success");
    expect((webhook.result as any).config).toBeDefined();
  });

  it("loads AI model configuration and resolves models dynamically by workflow task", () => {
    const aiConfig = getAiConfig();
    expect(aiConfig.defaultModel).toBe("@cf/zai-org/glm-4.7-flash");
    expect(aiConfig.taskModels?.optionsIdeas).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(aiConfig.taskModels?.nlqValidation).toBe("@cf/zai-org/glm-4.7-flash");

    const models = getAvailableAiModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.some((m) => m.id === "@cf/zai-org/glm-4.7-flash")).toBe(true);
    expect(models.some((m) => m.id === "@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe(true);

    // Dynamic resolution
    expect(resolveAiModelName({}, "optionsIdeas")).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(resolveAiModelName({}, "nlqValidation")).toBe("@cf/zai-org/glm-4.7-flash");
    expect(resolveAiModelName({}, "custom-model")).toBe("custom-model");
    expect(resolveAiModelName({})).toBe("@cf/zai-org/glm-4.7-flash");

    // Env override takes precedence when no task model is requested
    expect(resolveAiModelName({ AI_MODEL: "@cf/qwen/qwen2.5-72b-instruct" })).toBe("@cf/qwen/qwen2.5-72b-instruct");
  });

  it("normalizes voice speech transcripts using externalized phonetic dictionary and ticker mappings", () => {
    const voiceCfg = getVoiceConfig();
    expect(voiceCfg.phoneticCorrections?.["text talks"]).toBe("tech stocks");
    expect(voiceCfg.companyToTicker?.["apple"]).toBe("AAPL");

    // Verify transcript normalization
    const normalized1 = normalizeVoiceTradingTranscript("Screen all text talks");
    expect(normalized1.toLowerCase()).toContain("tech stocks");

    const normalized2 = normalizeVoiceTradingTranscript("Quote for Apple stock please");
    expect(normalized2).toContain("AAPL");

    const normalized3 = normalizeVoiceTradingTranscript("um like find NVDA please");
    expect(normalized3).toBe("find NVDA");
  });

  it("loads trading constraints and external API configurations correctly", () => {
    const constraints = getTradingConstraints();
    expect(constraints.maxOrderQuantity).toBe(10000);
    expect(constraints.maxOrderTotalUsd).toBe(500000);
    expect(constraints.requireHitlVoiceConfirmation).toBe(true);

    const extApis = getExternalApisConfig();
    expect(extApis.nasdaqListings.pageSize).toBe(5000);
    expect(extApis.nasdaqListings.timeoutMs).toBe(2500);
    expect(extApis.nasdaqListings.exchanges).toContain("nasdaq");
  });

  it("DynamicMarketScreener supports gainersLosers = 'movers' and sorts by absolute change magnitude", () => {
    const testUniverse: ScreenedStockItem[] = [
      {
        symbol: "FLAT",
        companyName: "Flat Corp",
        price: 50,
        lastPrice: 50,
        changePercent: 0.1,
        volume: 500000,
        rsi: 50,
      } as ScreenedStockItem,
      {
        symbol: "BIGG",
        companyName: "Big Gainer",
        price: 120,
        lastPrice: 120,
        changePercent: 12.5,
        volume: 1500000,
        rsi: 65,
      } as ScreenedStockItem,
      {
        symbol: "BIGL",
        companyName: "Big Loser",
        price: 80,
        lastPrice: 80,
        changePercent: -14.2,
        volume: 2000000,
        rsi: 30,
      } as ScreenedStockItem,
    ];

    const screener = new DynamicMarketScreener(testUniverse);

    const result = screener.screenStocks({
      gainersLosers: "movers",
    });

    expect(result.stocks.length).toBe(3);
    // Highest absolute magnitude should be first: BIGL (-14.2%) then BIGG (+12.5%) then FLAT (+0.1%)
    expect(result.stocks[0].symbol).toBe("BIGL");
    expect(result.stocks[1].symbol).toBe("BIGG");
    expect(result.stocks[2].symbol).toBe("FLAT");
  });
});

