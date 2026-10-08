import defaultConfig from "../../environment.config.json";
import type { Env } from "../types";

export interface EtapiScreenerConfig {
  maxScanSymbols: number;
  maxExpirationsPerSymbol: number;
  defaultMaxDte: number;
  defaultMinDte: number;
  defaultQuoteAgeSeconds: number;
  maxReturnedContracts: number;
  maxRejectionsReturned: number;
  symbolFetchConcurrency: number;
  expiryFetchConcurrency: number;
  unusualVolumeOiRatio: number;
  highDeltaThreshold: number;
  highIvThreshold: number;
  lowIvThreshold: number;
  atmBandPct: number;
}

export interface EtapiStrategyScoreWeights {
  thesisAlignment: number;
  targetRewardRisk: number;
  liquidity: number;
  volatilityAlignment: number;
  thetaBurden: number;
  freshness: number;
}

export interface EtapiStrategyEngineConfig {
  riskFreeRate: number;
  feePerContract: number;
  maxCombinations: number;
  detailLimit: number;
  maxLegs: number;
  scoreWeights: EtapiStrategyScoreWeights;
}

export interface EtapiOpportunityScannerConfig {
  maxScanSymbols: number;
  concurrency: number;
  targetFactors: {
    bullish: number;
    bearish: number;
    large_move: number;
    range_bound: number;
  };
}

export interface EtapiExpirationGroup {
  id: "near-term" | "mid-term" | "long-term";
  label: string;
  minDays: number;
  maxDays: number;
}

export interface EtapiLlmIdeasConfig {
  inputTokenBudget: number;
  defaultModel: string;
  expirationGroups: EtapiExpirationGroup[];
}

export interface EtapiClientConfig {
  defaultTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  detailFlag: "ALL" | "MF" | "INTRADAY";
  includeWeekly: boolean;
}

export interface EtapiCacheConfig {
  quoteTtlSeconds: number;
  chainTtlSeconds: number;
  expirationsTtlSeconds: number;
}

export interface AiModelDefinition {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  category: "flagship" | "reasoning" | "fast" | "analytical" | "general";
  description?: string;
}

export interface AiConfig {
  defaultModel: string;
  fallbackModel: string;
  fastModel: string;
  reasoningModel: string;
  availableModels: AiModelDefinition[];
  taskModels: {
    nlqPlanning?: string;
    nlqValidation?: string;
    optionsIdeas?: string;
    optionsComparison?: string;
    orchestrator?: string;
    marketResearch?: string;
    searchAgent?: string;
    [task: string]: string | undefined;
  };
  temperatureDefaults: {
    deterministic: number;
    analytical: number;
    creative: number;
  };
  maxTokens: {
    nlq: number;
    ideas: number;
    comparison: number;
    orchestrator: number;
    search: number;
  };
}

export interface VoiceAgentConfig {
  companyToTicker: Record<string, string>;
  wordToNumber: Record<string, string>;
  phoneticCorrections: Record<string, string>;
  maxPromptLength: number;
  defaultOrderType: string;
}

export interface TradingConstraintsConfig {
  maxOrderQuantity: number;
  maxOrderTotalUsd: number;
  defaultOrderQuantity: number;
  maxDiscountPercent: number;
  maxPremiumPercent: number;
  requireHitlVoiceConfirmation: boolean;
}

export interface ExternalApisConfig {
  nasdaqListings: {
    url: string;
    pageSize: number;
    timeoutMs: number;
    exchanges: string[];
  };
  yahooFinance: {
    timeoutMs: number;
    maxRetries: number;
  };
}

export interface EtapiConfig {
  screener: EtapiScreenerConfig;
  strategyEngine: EtapiStrategyEngineConfig;
  opportunityScanner: EtapiOpportunityScannerConfig;
  llmIdeas: EtapiLlmIdeasConfig;
  client: EtapiClientConfig;
  cache: EtapiCacheConfig;
  ai: AiConfig;
  voice: VoiceAgentConfig;
  tradingConstraints: TradingConstraintsConfig;
  externalApis: ExternalApisConfig;
}

const DEFAULT_SCORE_WEIGHTS: EtapiStrategyScoreWeights = {
  thesisAlignment: 0.30,
  targetRewardRisk: 0.20,
  liquidity: 0.20,
  volatilityAlignment: 0.10,
  thetaBurden: 0.05,
  freshness: 0.15,
};

const BASELINE_FALLBACK_CONFIG: EtapiConfig = {
  screener: {
    maxScanSymbols: 20,
    maxExpirationsPerSymbol: 100,
    defaultMaxDte: 90,
    defaultMinDte: 0,
    defaultQuoteAgeSeconds: 60,
    maxReturnedContracts: 10000,
    maxRejectionsReturned: 1000,
    symbolFetchConcurrency: 4,
    expiryFetchConcurrency: 3,
    unusualVolumeOiRatio: 1.5,
    highDeltaThreshold: 0.65,
    highIvThreshold: 0.70,
    lowIvThreshold: 0.30,
    atmBandPct: 0.02,
  },
  strategyEngine: {
    riskFreeRate: 0.04,
    feePerContract: 0.65,
    maxCombinations: 5000,
    detailLimit: 5000,
    maxLegs: 6,
    scoreWeights: DEFAULT_SCORE_WEIGHTS,
  },
  opportunityScanner: {
    maxScanSymbols: 20,
    concurrency: 3,
    targetFactors: {
      bullish: 1.05,
      bearish: 0.95,
      large_move: 1.10,
      range_bound: 1.00,
    },
  },
  llmIdeas: {
    inputTokenBudget: 90000,
    defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    expirationGroups: [
      { id: "near-term", label: "Near-term (0–30 days)", minDays: 0, maxDays: 30 },
      { id: "mid-term", label: "Mid-term (31–90 days)", minDays: 31, maxDays: 90 },
      { id: "long-term", label: "Long-term (91+ days)", minDays: 91, maxDays: 9999 },
    ],
  },
  client: {
    defaultTimeoutMs: 15000,
    maxRetries: 2,
    retryDelayMs: 500,
    detailFlag: "ALL",
    includeWeekly: true,
  },
  cache: {
    quoteTtlSeconds: 30,
    chainTtlSeconds: 60,
    expirationsTtlSeconds: 300,
  },
  ai: {
    defaultModel: "@cf/zai-org/glm-4.7-flash",
    fallbackModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    fastModel: "@cf/zai-org/glm-4.7-flash",
    reasoningModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    availableModels: [
      {
        id: "@cf/zai-org/glm-4.7-flash",
        name: "GLM 4.7 Flash (Flagship, 131k context)",
        provider: "workers-ai",
        contextWindow: 131072,
        supportsTools: true,
        supportsStreaming: true,
        category: "flagship",
        description: "High-speed reasoning, 131k context, native tool use, optimal for NLQ and trading execution",
      },
      {
        id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        name: "Llama 3.3 70B Instruct FP8 Fast",
        provider: "workers-ai",
        contextWindow: 131072,
        supportsTools: true,
        supportsStreaming: true,
        category: "reasoning",
        description: "Deep multi-leg quantitative options reasoning and contract payoff evaluation",
      },
      {
        id: "@cf/meta/llama-3.1-70b-instruct",
        name: "Llama 3.1 70B Instruct",
        provider: "workers-ai",
        contextWindow: 131072,
        supportsTools: true,
        supportsStreaming: true,
        category: "general",
        description: "General financial Q&A, comprehensive explanations, and macro analysis",
      },
      {
        id: "@cf/qwen/qwen2.5-72b-instruct",
        name: "Qwen 2.5 72B Instruct",
        provider: "workers-ai",
        contextWindow: 32768,
        supportsTools: true,
        supportsStreaming: true,
        category: "analytical",
        description: "High precision mathematical reasoning, risk factor decomposition, and code synthesis",
      },
      {
        id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        name: "DeepSeek R1 Distill Qwen 32B",
        provider: "workers-ai",
        contextWindow: 65536,
        supportsTools: false,
        supportsStreaming: true,
        category: "reasoning",
        description: "Chain-of-thought deep analytical reasoning and scenario risk assessment",
      },
    ],
    taskModels: {
      nlqPlanning: "@cf/zai-org/glm-4.7-flash",
      nlqValidation: "@cf/zai-org/glm-4.7-flash",
      optionsIdeas: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      optionsComparison: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      orchestrator: "@cf/zai-org/glm-4.7-flash",
      marketResearch: "@cf/zai-org/glm-4.7-flash",
      searchAgent: "@cf/zai-org/glm-4.7-flash",
    },
    temperatureDefaults: {
      deterministic: 0.0,
      analytical: 0.2,
      creative: 0.7,
    },
    maxTokens: {
      nlq: 2048,
      ideas: 4096,
      comparison: 4096,
      orchestrator: 2048,
      search: 2048,
    },
  },
  voice: {
    companyToTicker: {
      nvidia: "NVDA",
      nvda: "NVDA",
      apple: "AAPL",
      aapl: "AAPL",
      microsoft: "MSFT",
      msft: "MSFT",
      tesla: "TSLA",
      tsla: "TSLA",
      amazon: "AMZN",
      amzn: "AMZN",
      google: "GOOGL",
      googl: "GOOGL",
      alphabet: "GOOGL",
      broadcom: "AVGO",
      avgo: "AVGO",
      amd: "AMD",
      meta: "META",
      palantir: "PLTR",
      pltr: "PLTR",
      coinbase: "COIN",
      coin: "COIN",
      jpmorgan: "JPM",
      jpm: "JPM",
      goldman: "GS",
      gs: "GS",
      schwab: "SCHW",
      schw: "SCHW",
      robinhood: "HOOD",
      hood: "HOOD",
      spy: "SPY",
      qqq: "QQQ",
    },
    wordToNumber: {
      one: "1",
      two: "2",
      three: "3",
      four: "4",
      five: "5",
      six: "6",
      seven: "7",
      eight: "8",
      nine: "9",
      ten: "10",
      fifteen: "15",
      twenty: "20",
      twentyfive: "25",
      fifty: "50",
      hundred: "100",
    },
    phoneticCorrections: {
      "text talks": "tech stocks",
      "text talk": "tech stock",
      "tech talks": "tech stocks",
      "text stocks": "tech stocks",
      "talks": "stocks",
    },
    maxPromptLength: 500,
    defaultOrderType: "MARKET",
  },
  tradingConstraints: {
    maxOrderQuantity: 10000,
    maxOrderTotalUsd: 500000,
    defaultOrderQuantity: 1,
    maxDiscountPercent: 90,
    maxPremiumPercent: 500,
    requireHitlVoiceConfirmation: true,
  },
  externalApis: {
    nasdaqListings: {
      url: "https://api.nasdaq.com/api/screener/stocks",
      pageSize: 5000,
      timeoutMs: 2500,
      exchanges: ["nasdaq", "nyse", "amex"],
    },
    yahooFinance: {
      timeoutMs: 5000,
      maxRetries: 2,
    },
  },
};

let runtimeEtapiOverrides: Partial<EtapiConfig> | null = null;

export function setRuntimeEtapiConfigOverrides(overrides: Partial<EtapiConfig> | null): void {
  runtimeEtapiOverrides = overrides;
}

function deepMerge<T extends Record<string, any>>(target: T, source?: Record<string, any>): T {
  if (!source) return target;
  const output = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    if (srcVal === undefined || srcVal === null) continue;
    if (typeof srcVal === "object" && !Array.isArray(srcVal) && typeof (target as any)[key] === "object") {
      (output as any)[key] = deepMerge((target as any)[key], srcVal);
    } else {
      (output as any)[key] = srcVal;
    }
  }
  return output;
}

export function getEtapiConfig(env?: Partial<Env>, overrideEnv?: string): EtapiConfig {
  const activeEnv = (
    overrideEnv ||
    (env?.ETRADE_ENVIRONMENT === "sandbox" ? "TEST" : env?.ETRADE_ENVIRONMENT === "live" ? "PROD" : undefined) ||
    env?.APP_ENV ||
    defaultConfig.environment ||
    "PROD"
  ).toUpperCase();

  // 1. Start with baseline
  let config = deepMerge(BASELINE_FALLBACK_CONFIG, (defaultConfig as any).defaults?.etapi);

  // 2. Merge environment-specific overrides from environment.config.json
  const envBlock = (defaultConfig as any).environments?.[activeEnv]?.etapi;
  if (envBlock) {
    config = deepMerge(config, envBlock);
  }

  // 3. Merge env.ETAPI_CONFIG if provided as JSON string or object
  if (env && (env as any).ETAPI_CONFIG) {
    try {
      const raw = (env as any).ETAPI_CONFIG;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      config = deepMerge(config, parsed);
    } catch (e) {
      console.warn("[etapiConfig] Failed to parse env.ETAPI_CONFIG:", e);
    }
  }

  // 4. Check process.env if available in Node / test environment
  if (typeof process !== "undefined" && process?.env) {
    const proc = process.env;
    if (proc.ETAPI_CONFIG) {
      try {
        const parsed = JSON.parse(proc.ETAPI_CONFIG);
        config = deepMerge(config, parsed);
      } catch (e) {
        console.warn("[etapiConfig] Failed to parse process.env.ETAPI_CONFIG:", e);
      }
    }
    if (proc.ETAPI_MAX_SCAN_SYMBOLS) config.screener.maxScanSymbols = Number(proc.ETAPI_MAX_SCAN_SYMBOLS);
    if (proc.ETAPI_MAX_RETURNED_CONTRACTS) config.screener.maxReturnedContracts = Number(proc.ETAPI_MAX_RETURNED_CONTRACTS);
    if (proc.ETAPI_DEFAULT_MAX_DTE) config.screener.defaultMaxDte = Number(proc.ETAPI_DEFAULT_MAX_DTE);
    if (proc.ETAPI_RISK_FREE_RATE) config.strategyEngine.riskFreeRate = Number(proc.ETAPI_RISK_FREE_RATE);
    if (proc.ETAPI_FEE_PER_CONTRACT) config.strategyEngine.feePerContract = Number(proc.ETAPI_FEE_PER_CONTRACT);
    if (proc.ETAPI_LLM_TOKEN_BUDGET) config.llmIdeas.inputTokenBudget = Number(proc.ETAPI_LLM_TOKEN_BUDGET);
  }

  // 5. Apply runtime in-memory overrides (e.g. for testing)
  if (runtimeEtapiOverrides) {
    config = deepMerge(config, runtimeEtapiOverrides);
  }

  return config;
}

export function getScreenerConfig(env?: Partial<Env>, overrideEnv?: string): EtapiScreenerConfig {
  return getEtapiConfig(env, overrideEnv).screener;
}

export function getStrategyEngineConfig(env?: Partial<Env>, overrideEnv?: string): EtapiStrategyEngineConfig {
  return getEtapiConfig(env, overrideEnv).strategyEngine;
}

export function getOpportunityScannerConfig(env?: Partial<Env>, overrideEnv?: string): EtapiOpportunityScannerConfig {
  return getEtapiConfig(env, overrideEnv).opportunityScanner;
}

export function getLlmIdeasConfig(env?: Partial<Env>, overrideEnv?: string): EtapiLlmIdeasConfig {
  return getEtapiConfig(env, overrideEnv).llmIdeas;
}

export function getClientConfig(env?: Partial<Env>, overrideEnv?: string): EtapiClientConfig {
  return getEtapiConfig(env, overrideEnv).client;
}

export function getCacheConfig(env?: Partial<Env>, overrideEnv?: string): EtapiCacheConfig {
  return getEtapiConfig(env, overrideEnv).cache;
}

export function getAiConfig(env?: Partial<Env>, overrideEnv?: string): AiConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.ai;
}

export function getVoiceConfig(env?: Partial<Env>, overrideEnv?: string): VoiceAgentConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.voice;
}

export function getTradingConstraints(env?: Partial<Env>, overrideEnv?: string): TradingConstraintsConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.tradingConstraints;
}

export function getExternalApisConfig(env?: Partial<Env>, overrideEnv?: string): ExternalApisConfig {
  const cfg = getEtapiConfig(env, overrideEnv);
  return cfg.externalApis;
}

export function getAvailableAiModels(env?: Partial<Env>, overrideEnv?: string): AiModelDefinition[] {
  return getAiConfig(env, overrideEnv).availableModels;
}
