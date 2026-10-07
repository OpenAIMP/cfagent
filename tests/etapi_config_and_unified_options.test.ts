import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getEtapiConfig,
  getScreenerConfig,
  getStrategyEngineConfig,
  getOpportunityScannerConfig,
  getLlmIdeasConfig,
  setRuntimeEtapiConfigOverrides,
} from "../src/config/etapiConfig";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import type { Env, ETradeOptionChain } from "../src/types";

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
});
