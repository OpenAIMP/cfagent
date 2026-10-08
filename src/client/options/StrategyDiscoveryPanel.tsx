import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  discoverStrategies,
  generateExpirations,
  generateStrikeLadder,
  evaluateStrategyPnL,
  getOptimizationFactors,
  updateLegStrike,
  updateLegsExpiration,
  analyzeStrategy,
  calculateNetGreeks,
  calculateRealizedAndUnrealizedPnl,
  evaluate2dPayoffMatrix,
  shiftAllStrikes,
  shiftSymmetricStrikes,
  type DiscoveredStrategy,
  type ExpirationOption,
  type SentimentType,
  type StrategyLegItem,
  type StrategyDiscoveryConfig,
  type NetOptionGreeks,
  type RealizedUnrealizedPnl,
} from "./strategyDiscoveryEngine";
import {
  STRATEGY_LIBRARY,
  type StrategyDefinition,
} from "./strategyLibrary";
import {
  calculateProbabilityDensityPoints,
  calculateProbabilityAboveBelow,
} from "./blackScholes";
import { apiFetch as fetch } from "../apiFetch";
import { UniversalChart } from "../components/UniversalChart";
import { LlmStrategyEvalModal, type StrategyToEvaluate } from "./LlmStrategyEvalModal";
import { OptionsDataDownloadDropdown } from "./optionsDataExporter";
import type { OptionsTradeContext } from "./OptionsResearchPanel";
import "./strategyDiscovery.css";

const SENTIMENT_ITEMS: Array<{
  id: SentimentType;
  label: string;
  icon: React.ReactNode;
}> = [
  {
    id: "all",
    label: "ALL",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v18M3 12h18M6.3 6.3l11.4 11.4M6.3 17.7L17.7 6.3" />
      </svg>
    ),
  },
  {
    id: "very_bearish",
    label: "Very Bearish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 5l-7 7-7-7" />
        <path d="M19 12l-7 7-7-7" />
      </svg>
    ),
  },
  {
    id: "bearish",
    label: "Bearish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="7" y1="7" x2="17" y2="17" />
        <polyline points="17 7 17 17 7 17" />
      </svg>
    ),
  },
  {
    id: "neutral",
    label: "Neutral",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="12" x2="19" y2="12" />
        <polyline points="12 5 19 12 12 19" />
      </svg>
    ),
  },
  {
    id: "directional",
    label: "High Volatility",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 3 21 3 21 8" />
        <line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" />
        <line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </svg>
    ),
  },
  {
    id: "bullish",
    label: "Bullish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="7" y1="17" x2="17" y2="7" />
        <polyline points="7 7 17 7 17 17" />
      </svg>
    ),
  },
  {
    id: "very_bullish",
    label: "Very Bullish",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 19l7-7 7 7" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    ),
  },
];

interface StrategyDiscoveryPanelProps {
  initialSymbol?: string;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  onPreviewTrade?: (ctx: OptionsTradeContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  flowTradeBanner?: {
    title: string;
    returnText: string;
    timestamp?: string;
  } | null;
  initialCustomLegs?: StrategyLegItem[];
  initialStrategyName?: string;
  initialExpirationDate?: string;
  onBackToFlows?: () => void;
}

interface StockQuoteState {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  companyName: string;
  delayed: boolean;
}

interface SavedOptionTrade {
  id: string;
  name: string;
  notes?: string;
  createdAt: string;
  symbol: string;
  expirationDate: string;
  dte: number;
  legs: StrategyLegItem[];
  strategyName: string;
  underlyingPriceAtSave: number;
  ivAtSave: number;
}

const STORAGE_KEY_SAVED_TRADES = "etrade_saved_options_trades";

// Popular stock & ETF presets including futures
const POPULAR_TICKERS: StockQuoteState[] = [
  { symbol: "WMT", price: 107.20, change: 0.0, changePercent: 0.0, companyName: "Walmart Inc.", delayed: true },
  { symbol: "TSLA", price: 380.68, change: 1.95, changePercent: 0.51, companyName: "Tesla, Inc.", delayed: true },
  { symbol: "NVDA", price: 233.95, change: 0.0, changePercent: 0.0, companyName: "NVIDIA Corporation", delayed: true },
  { symbol: "AAPL", price: 232.50, change: 1.25, changePercent: 0.54, companyName: "Apple Inc.", delayed: true },
  { symbol: "SPY", price: 586.20, change: 2.10, changePercent: 0.36, companyName: "SPDR S&P 500 ETF Trust", delayed: true },
  { symbol: "QQQ", price: 494.30, change: 1.80, changePercent: 0.37, companyName: "Invesco QQQ Trust", delayed: true },
  { symbol: "MSFT", price: 428.15, change: -0.85, changePercent: -0.20, companyName: "Microsoft Corporation", delayed: true },
  { symbol: "AMD", price: 172.40, change: 3.10, changePercent: 1.83, companyName: "Advanced Micro Devices", delayed: true },
  { symbol: "AMZN", price: 186.50, change: 0.90, changePercent: 0.49, companyName: "Amazon.com, Inc.", delayed: true },
  { symbol: "GOOGL", price: 168.20, change: -0.40, changePercent: -0.24, companyName: "Alphabet Inc.", delayed: true },
  { symbol: "META", price: 588.60, change: 4.50, changePercent: 0.77, companyName: "Meta Platforms, Inc.", delayed: true },
  { symbol: "IWM", price: 221.80, change: 0.75, changePercent: 0.34, companyName: "iShares Russell 2000 ETF", delayed: true },
  { symbol: "/ES", price: 5875.50, change: 14.25, changePercent: 0.24, companyName: "E-mini S&P 500 Futures", delayed: true },
  { symbol: "/NQ", price: 20420.00, change: 65.50, changePercent: 0.32, companyName: "E-mini Nasdaq 100 Futures", delayed: true },
];

const DEFAULT_QUOTES: Record<string, StockQuoteState> = Object.fromEntries(
  POPULAR_TICKERS.map((t) => [t.symbol, t])
);

// URL hash encoding / decoding for Capability 10 (Share Trades)
function encodeTradeToHash(payload: {
  symbol: string;
  expirationDate: string;
  dte: number;
  legs: StrategyLegItem[];
  strategyName: string;
  iv: number;
}): string {
  try {
    const json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)));
  } catch {
    return "";
  }
}

function decodeTradeFromHash(hashStr: string): {
  symbol: string;
  expirationDate: string;
  dte: number;
  legs: StrategyLegItem[];
  strategyName: string;
  iv: number;
} | null {
  try {
    const raw = decodeURIComponent(escape(atob(hashStr)));
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function StrategyDiscoveryPanel({
  initialSymbol = "TSLA",
  activeEnv = "TEST",
  userLogin,
  onPreviewTrade,
  onSendPrompt,
  flowTradeBanner,
  initialCustomLegs,
  initialStrategyName,
  initialExpirationDate,
  onBackToFlows,
}: StrategyDiscoveryPanelProps) {
  // Navigation View: "discovery" or "builder"
  const [activeView, setActiveView] = useState<"discovery" | "builder">("builder");

  // LLM Strategy Evaluation Modal State
  const [evaluatingStrategy, setEvaluatingStrategy] = useState<StrategyToEvaluate | null>(null);

  // Core ticker state
  const [symbolInput, setSymbolInput] = useState(initialSymbol);
  const [activeSymbol, setActiveSymbol] = useState(initialSymbol.toUpperCase());
  const [showSymbolSearchMenu, setShowSymbolSearchMenu] = useState(false);
  const [customStrategyName, setCustomStrategyName] = useState<string | null>(initialStrategyName || null);
  const [isFlowBannerDismissed, setIsFlowBannerDismissed] = useState<boolean>(false);
  const [quote, setQuote] = useState<StockQuoteState>(
    DEFAULT_QUOTES[initialSymbol.toUpperCase()] || {
      symbol: initialSymbol.toUpperCase(),
      price: 250.0,
      change: 1.2,
      changePercent: 0.48,
      companyName: `${initialSymbol.toUpperCase()} Equity`,
      delayed: true,
    }
  );

  // Expirations schedule
  const expirations = useMemo(() => generateExpirations(), []);
  const [selectedExpiration, setSelectedExpiration] = useState<ExpirationOption>(
    expirations[6] || expirations[0]
  );

  // Sentiment selector
  const [sentiment, setSentiment] = useState<SentimentType>("bullish");

  // Target price state
  const [targetPrice, setTargetPrice] = useState<number>(() => {
    const p = quote.price;
    return Number((p * 1.43).toFixed(2));
  });

  // Budget state (null = None)
  const [budget, setBudget] = useState<number | null>(null);

  // Minimum Reward/Risk (Max Profit vs Max Loss) filter ratio (null = Any)
  const [minRewardRiskRatio, setMinRewardRiskRatio] = useState<number | null>(null);

  // Optimization Slider (0 = Max Return, 100 = Max Chance)
  const [optimizationBias, setOptimizationBias] = useState<number>(50);

  // Builder View State
  const [selectedStrategy, setSelectedStrategy] = useState<DiscoveredStrategy | null>(null);
  const [builderLegs, setBuilderLegs] = useState<StrategyLegItem[]>(() => {
    return initialCustomLegs && initialCustomLegs.length > 0 ? [...initialCustomLegs] : [];
  });
  const [builderIv, setBuilderIv] = useState<number>(27.5);

  // Synchronize when custom trade legs are passed
  useEffect(() => {
    if (initialCustomLegs && initialCustomLegs.length > 0) {
      setBuilderLegs([...initialCustomLegs]);
    }
    if (initialStrategyName) {
      setCustomStrategyName(initialStrategyName);
    }
    if (initialExpirationDate) {
      const match = expirations.find(
        (e) =>
          e.date === initialExpirationDate ||
          e.label.toLowerCase().includes(initialExpirationDate.toLowerCase())
      );
      if (match) setSelectedExpiration(match);
    }
  }, [initialCustomLegs, initialStrategyName, initialExpirationDate, expirations]);

  // Capability 1: Strategy Library Modal State (50+ Strategies)
  const [showStrategyModal, setShowStrategyModal] = useState<boolean>(false);
  const [strategyCategoryFilter, setStrategyCategoryFilter] = useState<string>("All");
  const [strategySearchQuery, setStrategySearchQuery] = useState<string>("");
  const [hoveredStrategyDef, setHoveredStrategyDef] = useState<StrategyDefinition | null>(null);

  // Capability 4: Dual Stats Switcher & Side-by-Side View (Default: both active simultaneously)
  const [showKeyStats, setShowKeyStats] = useState<boolean>(true);
  const [showNetGreeks, setShowNetGreeks] = useState<boolean>(true);

  const toggleKeyStats = () => {
    if (showKeyStats && !showNetGreeks) {
      setShowKeyStats(false);
      setShowNetGreeks(true);
    } else {
      setShowKeyStats(!showKeyStats);
    }
  };

  const toggleNetGreeks = () => {
    if (showNetGreeks && !showKeyStats) {
      setShowNetGreeks(false);
      setShowKeyStats(true);
    } else {
      setShowNetGreeks(!showNetGreeks);
    }
  };

  // Capability 8: Legs Inspector & Actions
  const [editingLegCostId, setEditingLegCostId] = useState<string | null>(null);
  const [customCostInputValue, setCustomCostInputValue] = useState<string>("");
  const [rollingLeg, setRollingLeg] = useState<StrategyLegItem | null>(null);

  // Capability 9: Price History Modal
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);

  // Capability 10 & 11: Save, Share, and Saved Trades Drawers
  const [showSaveModal, setShowSaveModal] = useState<boolean>(false);
  const [saveTradeName, setSaveTradeName] = useState<string>("");
  const [saveTradeNotes, setSaveTradeNotes] = useState<string>("");
  const [showSavedTradesModal, setShowSavedTradesModal] = useState<boolean>(false);
  const [savedTrades, setSavedTrades] = useState<SavedOptionTrade[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_SAVED_TRADES);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Capability 12: Previous Trade Comparison
  const [previousStrategyLegs, setPreviousStrategyLegs] = useState<StrategyLegItem[] | null>(null);
  const [isComparingPrevious, setIsComparingPrevious] = useState<boolean>(false);

  // Dynamic Engine Config loaded from externalized ETAPI settings
  const [engineConfig, setEngineConfig] = useState<StrategyDiscoveryConfig>({
    riskFreeRate: 0.04,
    feePerContract: 0.65,
    maxCombinations: 5000,
  });

  useEffect(() => {
    fetch("/api/trading/options/config", {
      headers: {
        "x-environment": activeEnv,
        ...(userLogin ? { "x-user-login": userLogin } : {}),
      },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: any) => {
        if (data?.config?.strategyEngine) {
          setEngineConfig({
            riskFreeRate: data.config.strategyEngine.riskFreeRate ?? 0.04,
            feePerContract: data.config.strategyEngine.feePerContract ?? 0.65,
            maxCombinations: data.config.strategyEngine.maxCombinations ?? 5000,
          });
        }
      })
      .catch(() => {
        // Fallback to baseline defaults
      });
  }, [activeEnv, userLogin]);

  // Display and Zoom Modes
  const [builderRangePct, setBuilderRangePct] = useState<number>(20);
  const [builderZoomLevel, setBuilderZoomLevel] = useState<"x1" | "x2" | "x3">("x1");
  const [builderDateSliderPct, setBuilderDateSliderPct] = useState<number>(100);
  const [builderDisplayMode, setBuilderDisplayMode] = useState<"graph" | "table">("graph");
  const [builderMetricMode, setBuilderMetricMode] = useState<"pnl_dollar" | "pnl_pct" | "contract_val" | "collateral_pct">("pnl_dollar");
  const [showPositionsDrawer, setShowPositionsDrawer] = useState<boolean>(false);
  const [graphHoverPrice, setGraphHoverPrice] = useState<number | null>(null);

  // Toast feedback helper
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3200);
  };

  // Check URL hash for shared trades on mount (Capability 10)
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash.startsWith("#trade=")) {
      const hashData = window.location.hash.slice(7);
      const decoded = decodeTradeFromHash(hashData);
      if (decoded && decoded.symbol && decoded.legs?.length > 0) {
        setActiveSymbol(decoded.symbol.toUpperCase());
        setSymbolInput(decoded.symbol.toUpperCase());
        const matchingExp = expirations.find((e) => e.date === decoded.expirationDate) || expirations[0];
        setSelectedExpiration(matchingExp);
        setBuilderLegs(decoded.legs);
        if (decoded.iv) setBuilderIv(decoded.iv);
        setActiveView("builder");
        showToast(`Loaded shared trade: ${decoded.strategyName} (${decoded.symbol})`);
      }
    }
  }, [expirations]);

  const [isQuoteRefreshing, setIsQuoteRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  // Auto-refresh configuration state (persisted to localStorage)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem("cfagent_options_autorefresh_enabled") === "true";
    } catch {
      return false;
    }
  });

  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(() => {
    try {
      const stored = localStorage.getItem("cfagent_options_autorefresh_interval");
      return stored ? Number(stored) || 30 : 30;
    } catch {
      return 30;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("cfagent_options_autorefresh_enabled", String(autoRefreshEnabled));
    } catch {
      // ignore storage errors
    }
  }, [autoRefreshEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem("cfagent_options_autorefresh_interval", String(autoRefreshInterval));
    } catch {
      // ignore storage errors
    }
  }, [autoRefreshInterval]);

  // Fetch live or FOSS quote with optional notification and reanalysis
  const fetchQuoteData = async (sym: string, showNotification: boolean = false) => {
    setIsQuoteRefreshing(true);
    try {
      const resp = await fetch(`/api/foss/quote?symbol=${encodeURIComponent(sym)}`);
      if (resp.ok) {
        const data = (await resp.json()) as any;
        if (data && (data.lastPrice || data.price)) {
          const freshPrice = Number(data.lastPrice || data.price);
          const freshQuote: StockQuoteState = {
            symbol: sym,
            price: freshPrice,
            change: Number(data.change || 0),
            changePercent: Number(data.changePercent || 0),
            companyName: data.companyName || sym,
            delayed: true,
          };
          setQuote(freshQuote);
          if (builderLegs.length > 0) {
            const updated = builderLegs.map((l) =>
              updateLegStrike(l, l.strike, freshPrice, selectedExpiration.dte, builderIv / 100, engineConfig.riskFreeRate)
            );
            setBuilderLegs(updated);
            reanalyze(updated);
          }
          const timeStr = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          setLastRefreshedAt(timeStr);
          if (showNotification) {
            showToast(`Refreshed ${sym} market data: $${freshPrice.toFixed(2)}`);
          }
          return;
        }
      }
    } catch {
      // Fallback to defaults
    } finally {
      setIsQuoteRefreshing(false);
    }

    if (DEFAULT_QUOTES[sym]) {
      setQuote(DEFAULT_QUOTES[sym]);
    }
  };

  useEffect(() => {
    void fetchQuoteData(activeSymbol, false);
  }, [activeSymbol]);

  // Periodic auto-refresh timer
  const fetchQuoteDataRef = useRef(fetchQuoteData);
  fetchQuoteDataRef.current = fetchQuoteData;

  useEffect(() => {
    if (!autoRefreshEnabled) return;
    const ms = Math.max(5, autoRefreshInterval) * 1000;
    const intervalId = window.setInterval(() => {
      void fetchQuoteDataRef.current(activeSymbol, false);
    }, ms);
    return () => window.clearInterval(intervalId);
  }, [autoRefreshEnabled, autoRefreshInterval, activeSymbol]);

  const handleRefreshOptions = () => {
    void fetchQuoteData(activeSymbol, true);
  };

  // Implied move calculated using options market formula: spot * IV * sqrt(dte / 365)
  const computeImpliedMove = (spotPrice: number, ivPercent: number, dteDays: number) => {
    const ivDec = Math.max(0.05, ivPercent / 100);
    const tYears = Math.max(0.5, dteDays) / 365;
    return spotPrice * ivDec * Math.sqrt(tYears);
  };

  // Target price calculation for sentiment presets based on ±1x or ±2x implied move
  const getTargetPriceForSentiment = (
    nextSentiment: SentimentType,
    spotPrice: number,
    ivPercent: number,
    dteDays: number
  ) => {
    const move = computeImpliedMove(spotPrice, ivPercent, dteDays);
    if (nextSentiment === "all") return Number(spotPrice.toFixed(2));
    if (nextSentiment === "very_bullish") return Number((spotPrice + 2 * move).toFixed(2));
    if (nextSentiment === "bullish") return Number((spotPrice + move).toFixed(2));
    if (nextSentiment === "neutral") return Number(spotPrice.toFixed(2));
    if (nextSentiment === "directional") return Number((spotPrice + move).toFixed(2));
    if (nextSentiment === "bearish") return Number(Math.max(0.01, spotPrice - move).toFixed(2));
    if (nextSentiment === "very_bearish") return Number(Math.max(0.01, spotPrice - 2 * move).toFixed(2));
    return Number(spotPrice.toFixed(2));
  };

  // Adjust target price default when sentiment or quote price changes
  const handleSentimentChange = (nextSentiment: SentimentType) => {
    setSentiment(nextSentiment);
    const target = getTargetPriceForSentiment(nextSentiment, quote.price, builderIv, selectedExpiration.dte);
    setTargetPrice(target);
  };

  const handleSelectExpiration = (exp: ExpirationOption) => {
    setSelectedExpiration(exp);
    const target = getTargetPriceForSentiment(sentiment, quote.price, builderIv, exp.dte);
    setTargetPrice(target);
  };

  const handleSelectSymbol = (sym: string) => {
    const clean = sym.trim().toUpperCase();
    if (clean && clean !== activeSymbol) {
      setActiveSymbol(clean);
      setSymbolInput(clean);
      setShowSymbolSearchMenu(false);
      const fallback = DEFAULT_QUOTES[clean] || {
        symbol: clean,
        price: clean.startsWith("/") ? 5000.0 : 150.0,
        change: 0.5,
        changePercent: 0.33,
        companyName: clean,
        delayed: true,
      };
      setQuote(fallback);
      setTargetPrice(getTargetPriceForSentiment(sentiment, fallback.price, builderIv, selectedExpiration.dte));
    }
  };

  const handleSymbolSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSelectSymbol(symbolInput);
  };

  // Generate strategy candidates based on criteria
  const discoveredStrategies = useMemo(() => {
    return discoverStrategies({
      symbol: activeSymbol,
      currentPrice: quote.price,
      sentiment,
      targetPrice,
      budget,
      minRewardRisk: minRewardRiskRatio,
      expiration: selectedExpiration,
      optimizationBias,
      baseIv: builderIv / 100,
      config: engineConfig,
    });
  }, [activeSymbol, quote.price, sentiment, targetPrice, budget, minRewardRiskRatio, selectedExpiration, optimizationBias, builderIv, engineConfig]);

  // When discovering strategies, initialize selectedStrategy with the first match if empty
  useEffect(() => {
    if (discoveredStrategies.length > 0 && (!selectedStrategy || activeView === "discovery")) {
      const top = discoveredStrategies[0];
      setSelectedStrategy(top);
      if (builderLegs.length === 0) {
        setBuilderLegs([...top.legs]);
      }
    }
  }, [discoveredStrategies, activeView, selectedStrategy, builderLegs.length]);

  // Transition from Discovery card to Builder view
  const openInBuilder = (strat: DiscoveredStrategy) => {
    // Preserve current legs as previous for comparison (Capability 12)
    if (builderLegs.length > 0) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    setSelectedStrategy(strat);
    setBuilderLegs([...strat.legs]);
    setActiveView("builder");
  };

  // Capability 1: Choose a strategy from 50+ Library
  const handleSelectPreMadeStrategy = (stratDef: StrategyDefinition) => {
    if (builderLegs.length > 0) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const newLegs = stratDef.buildLegs(
      quote.price,
      selectedExpiration.dte,
      selectedExpiration.date,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    const analyzed = analyzeStrategy(
      stratDef.name,
      stratDef.category,
      stratDef.subtitle,
      stratDef.theses,
      newLegs,
      quote.price,
      targetPrice,
      selectedExpiration.dte,
      selectedExpiration.date,
      builderIv / 100,
      stratDef.description,
      optimizationBias,
      engineConfig
    );
    setSelectedStrategy(analyzed);
    setBuilderLegs(newLegs);
    setShowStrategyModal(false);
    setActiveView("builder");
    showToast(`Loaded ${stratDef.name} (${stratDef.category})`);
  };

  // Target price percentage change from spot
  const targetPctChange = useMemo(() => {
    if (!quote.price) return 0;
    return Number((((targetPrice - quote.price) / quote.price) * 100).toFixed(0));
  }, [targetPrice, quote.price]);

  // Optimization Factor breakdown
  const optFactors = useMemo(() => {
    return getOptimizationFactors(optimizationBias);
  }, [optimizationBias]);

  // =========================================================================
  // BUILDER VIEW CALCULATIONS & MATHEMATICAL ENGINE
  // =========================================================================
  const spot = quote.price;
  const currentStrategyName = customStrategyName || selectedStrategy?.name || "Options Strategy";

  // Effective DTE and time remaining for the Date slider
  const maxDte = selectedExpiration.dte;
  const tRemainingDays = maxDte * (1 - builderDateSliderPct / 100);
  const tRemainingYears = Math.max(0, tRemainingDays) / 365;

  // Zoom / Range %
  const effectiveRangePct = useMemo(() => {
    if (builderZoomLevel === "x1") return builderRangePct;
    if (builderZoomLevel === "x2") return builderRangePct * 2.0;
    return builderRangePct * 3.5;
  }, [builderRangePct, builderZoomLevel]);

  const priceLow = Math.max(0.1, spot * (1 - effectiveRangePct / 100));
  const priceHigh = spot * (1 + effectiveRangePct / 100);

  // Full Payoff points across the range for the primary Builder graph
  const builderGraphPoints = useMemo(() => {
    const steps = 60;
    const stepSize = (priceHigh - priceLow) / (steps - 1);
    const points: Array<{ price: number; pnlEvaluated: number; pnlExpiry: number }> = [];

    for (let i = 0; i < steps; i++) {
      const p = priceLow + i * stepSize;
      const pnlEvaluated = evaluateStrategyPnL(
        builderLegs,
        p,
        tRemainingYears,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      const pnlExpiry = evaluateStrategyPnL(
        builderLegs,
        p,
        0,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      points.push({
        price: Number(p.toFixed(2)),
        pnlEvaluated: Number(pnlEvaluated.toFixed(2)),
        pnlExpiry: Number(pnlExpiry.toFixed(2)),
      });
    }
    return points;
  }, [builderLegs, priceLow, priceHigh, tRemainingYears, builderIv, engineConfig.riskFreeRate]);

  // Capability 12: Comparison curve points for previous trade (dashed gray line)
  const comparisonGraphPoints = useMemo(() => {
    if (!isComparingPrevious || !previousStrategyLegs || previousStrategyLegs.length === 0) {
      return undefined;
    }
    const steps = 60;
    const stepSize = (priceHigh - priceLow) / (steps - 1);
    const points: Array<{ x: number; y: number }> = [];

    for (let i = 0; i < steps; i++) {
      const p = priceLow + i * stepSize;
      const pnl = evaluateStrategyPnL(
        previousStrategyLegs,
        p,
        tRemainingYears,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      points.push({
        x: Number(p.toFixed(2)),
        y: Number(pnl.toFixed(2)),
      });
    }
    return points;
  }, [isComparingPrevious, previousStrategyLegs, priceLow, priceHigh, tRemainingYears, builderIv, engineConfig.riskFreeRate]);

  // Capability 6: Log-Normal Probability Distribution Overlay Curve
  const probabilityOverlayPoints = useMemo(() => {
    const raw = calculateProbabilityDensityPoints(
      spot,
      Math.max(0.001, tRemainingYears),
      builderIv / 100,
      priceLow,
      priceHigh,
      60,
      engineConfig.riskFreeRate
    );
    return raw.map((pt) => ({ x: pt.price, density: pt.density, probBelow: pt.probBelow }));
  }, [spot, tRemainingYears, builderIv, priceLow, priceHigh, engineConfig.riskFreeRate]);

  // Capability 6: Hover Chance Indicators (← X% | Y% →)
  const hoverProbabilities = useMemo(() => {
    if (graphHoverPrice === null) return null;
    return calculateProbabilityAboveBelow(
      spot,
      graphHoverPrice,
      Math.max(0.001, tRemainingYears),
      builderIv / 100,
      engineConfig.riskFreeRate
    );
  }, [spot, graphHoverPrice, tRemainingYears, builderIv, engineConfig.riskFreeRate]);

  // Capability 4: Net Option Greeks & Realized / Unrealized P&L
  const netGreeks: NetOptionGreeks = useMemo(() => {
    return calculateNetGreeks(
      builderLegs,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
  }, [builderLegs, spot, selectedExpiration.dte, builderIv, engineConfig.riskFreeRate]);

  const pnlBreakdown: RealizedUnrealizedPnl = useMemo(() => {
    return calculateRealizedAndUnrealizedPnl(
      builderLegs,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
  }, [builderLegs, spot, selectedExpiration.dte, builderIv, engineConfig.riskFreeRate]);

  // Capability 5: 2D Payoff Matrix Heatmap Data
  const matrix2dData = useMemo(() => {
    return evaluate2dPayoffMatrix(
      builderLegs,
      spot,
      selectedExpiration.dte,
      selectedExpiration.date,
      builderIv / 100,
      effectiveRangePct,
      17,
      7,
      selectedStrategy?.riskOrCollateral || 1000,
      engineConfig.riskFreeRate
    );
  }, [builderLegs, spot, selectedExpiration, builderIv, effectiveRangePct, selectedStrategy, engineConfig.riskFreeRate]);

  // Strike ladder for ruler and sliders
  const strikeLadder = useMemo(() => generateStrikeLadder(spot), [spot]);
  const minStrike = strikeLadder[0] || spot * 0.5;
  const maxStrike = strikeLadder[strikeLadder.length - 1] || spot * 1.5;
  const strikeStep = strikeLadder.length > 1 ? Number((strikeLadder[1] - strikeLadder[0]).toFixed(2)) : 1;

  // Visible ruler strikes centered around spot
  const rulerStrikes = useMemo(() => {
    const centerIdx = strikeLadder.findIndex((k) => Math.abs(k - spot) < strikeStep * 1.5);
    const startIdx = Math.max(0, (centerIdx >= 0 ? centerIdx : 15) - 10);
    return strikeLadder.slice(startIdx, startIdx + 21);
  }, [strikeLadder, spot, strikeStep]);

  // Re-analyze strategy helper
  const reanalyze = (updatedLegs: StrategyLegItem[]) => {
    if (selectedStrategy) {
      const analyzed = analyzeStrategy(
        selectedStrategy.name,
        selectedStrategy.category,
        selectedStrategy.subtitle,
        selectedStrategy.theses,
        updatedLegs,
        spot,
        targetPrice,
        selectedExpiration.dte,
        selectedExpiration.date,
        builderIv / 100,
        selectedStrategy.description,
        optimizationBias,
        engineConfig
      );
      setSelectedStrategy(analyzed);
    }
  };

  // Strike change handlers
  const handleStrikeChange = (legId: string, newStrike: number, e?: React.MouseEvent | React.ChangeEvent) => {
    // If Shift key is held, move all strikes at once (Capability 3)
    if (e && "shiftKey" in e && (e as React.MouseEvent).shiftKey) {
      const leg = builderLegs.find((l) => l.id === legId);
      if (leg) {
        const delta = Math.round((newStrike - leg.strike) / strikeStep);
        handleMoveAllStrikes(delta);
        return;
      }
    }

    if (builderLegs.length > 0 && !previousStrategyLegs) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const updatedLegs = builderLegs.map((l) => {
      if (l.id === legId) {
        return updateLegStrike(l, newStrike, spot, selectedExpiration.dte, builderIv / 100, engineConfig.riskFreeRate);
      }
      return l;
    });
    setBuilderLegs(updatedLegs);
    reanalyze(updatedLegs);
  };

  // Step strike up or down
  const handleStrikeStep = (legId: string, stepDirection: number, e?: React.MouseEvent) => {
    if (e?.shiftKey) {
      handleMoveAllStrikes(stepDirection);
      return;
    }
    const leg = builderLegs.find((l) => l.id === legId);
    if (!leg) return;
    const currIdx = strikeLadder.findIndex((k) => Math.abs(k - leg.strike) < strikeStep * 0.5);
    const nextIdx = Math.max(0, Math.min(strikeLadder.length - 1, (currIdx >= 0 ? currIdx : 0) + stepDirection));
    handleStrikeChange(legId, strikeLadder[nextIdx]);
  };

  // Capability 3: Move All Strikes simultaneously (Shift+Drag / Stepper)
  const handleMoveAllStrikes = (stepDelta: number) => {
    if (builderLegs.length > 0 && !previousStrategyLegs) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const updated = shiftAllStrikes(
      builderLegs,
      stepDelta,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 3: Symmetric Wing adjustments for Condors / Butterflies
  const handleSymmetricMove = (widthDelta: number) => {
    if (builderLegs.length > 0 && !previousStrategyLegs) {
      setPreviousStrategyLegs([...builderLegs]);
    }
    const updated = shiftSymmetricStrikes(
      builderLegs,
      widthDelta,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Expiration change handler
  const handleBuilderExpirationChange = (exp: ExpirationOption) => {
    setSelectedExpiration(exp);
    if (builderLegs.length > 0) {
      const updatedLegs = updateLegsExpiration(
        builderLegs,
        exp.dte,
        exp.date,
        spot,
        builderIv / 100,
        engineConfig.riskFreeRate
      );
      setBuilderLegs(updatedLegs);
      if (selectedStrategy) {
        const analyzed = analyzeStrategy(
          selectedStrategy.name,
          selectedStrategy.category,
          selectedStrategy.subtitle,
          selectedStrategy.theses,
          updatedLegs,
          spot,
          targetPrice,
          exp.dte,
          exp.date,
          builderIv / 100,
          selectedStrategy.description,
          optimizationBias,
          engineConfig
        );
        setSelectedStrategy(analyzed);
      }
    }
  };

  // Capability 8: Adjusting Leg Quantity
  const handleLegQuantityChange = (legId: string, delta: number) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        const newQty = Math.max(1, leg.quantity + delta);
        return { ...leg, quantity: newQty };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 8: Adjusting Leg Side (BUY / SELL)
  const handleLegSideToggle = (legId: string) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        const newSide: "BUY" | "SELL" = leg.side === "BUY" ? "SELL" : "BUY";
        const newEntry = newSide === "BUY" ? leg.ask : leg.bid;
        return { ...leg, side: newSide, entryPrice: newEntry };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 8: Exclude / Include Leg toggle
  const handleLegExcludeToggle = (legId: string) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        return { ...leg, isExcluded: !leg.isExcluded };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
  };

  // Capability 8: Custom Cost-Basis Input
  const handleSaveCustomCost = (legId: string) => {
    const val = parseFloat(customCostInputValue);
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        return {
          ...leg,
          customCostBasis: isNaN(val) || val <= 0 ? undefined : val,
        };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
    setEditingLegCostId(null);
  };

  const handleResetCustomCost = (legId: string) => {
    const updated = builderLegs.map((leg) => {
      if (leg.id === legId) {
        return { ...leg, customCostBasis: undefined };
      }
      return leg;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
    setEditingLegCostId(null);
  };

  // Capability 8 & 11: Close Leg (Locks in realized P&L)
  const handleCloseLeg = (legId: string) => {
    const leg = builderLegs.find((l) => l.id === legId);
    if (!leg) return;
    // Default closing exit price to current mark
    const exitPrice = leg.side === "BUY" ? leg.bid : leg.ask;
    const updated = builderLegs.map((l) => {
      if (l.id === legId) {
        return {
          ...l,
          isClosed: true,
          closingPrice: exitPrice,
        };
      }
      return l;
    });
    setBuilderLegs(updated);
    reanalyze(updated);
    showToast(`Closed ${leg.side} ${leg.strike}${leg.optionType[0]} @ $${exitPrice.toFixed(2)} ✓`);
  };

  // Capability 8: Add New Option Leg
  const handleAddLeg = (optionType: "CALL" | "PUT") => {
    const defaultStrike = optionType === "CALL" ? strikeLadder.find((k) => k >= spot) || spot : strikeLadder.find((k) => k <= spot) || spot;
    const newLeg = updateLegStrike(
      {
        id: `${optionType}_${defaultStrike}_BUY_${Date.now()}`,
        side: "BUY",
        optionType,
        strike: defaultStrike,
        quantity: 1,
        expirationDate: selectedExpiration.date,
        dte: selectedExpiration.dte,
        entryPrice: 2.5,
        bid: 2.4,
        ask: 2.6,
        impliedVolatility: builderIv / 100,
        delta: 0.5,
        gamma: 0.02,
        theta: -0.05,
        vega: 0.12,
      },
      defaultStrike,
      spot,
      selectedExpiration.dte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );
    const updated = [...builderLegs, newLeg];
    setBuilderLegs(updated);
    reanalyze(updated);
    showToast(`Added Long ${defaultStrike}${optionType[0]} Leg`);
  };

  // Capability 11: Execute Leg Roll
  const handleExecuteRoll = (newDte: number, newExpDate: string, newStrike: number) => {
    if (!rollingLeg) return;
    // 1. Close current rolling leg
    const closingExit = rollingLeg.side === "BUY" ? rollingLeg.bid : rollingLeg.ask;
    const closedOriginal = {
      ...rollingLeg,
      isClosed: true,
      closingPrice: closingExit,
    };
    // 2. Open new rolled leg
    const rolledNew = updateLegStrike(
      {
        ...rollingLeg,
        id: `${rollingLeg.optionType}_${newStrike}_${rollingLeg.side}_rolled_${Date.now()}`,
        strike: newStrike,
        expirationDate: newExpDate,
        dte: newDte,
        isClosed: false,
        closingPrice: undefined,
        customCostBasis: undefined,
      },
      newStrike,
      spot,
      newDte,
      builderIv / 100,
      engineConfig.riskFreeRate
    );

    const updated = builderLegs.map((l) => (l.id === rollingLeg.id ? closedOriginal : l)).concat(rolledNew);
    setBuilderLegs(updated);
    reanalyze(updated);
    setRollingLeg(null);
    showToast(`Rolled ${rollingLeg.strike}${rollingLeg.optionType[0]} to ${newExpDate} $${newStrike} ✓`);
  };

  // Capability 10: Save Trade to LocalStorage
  const handleSaveTrade = () => {
    const name = saveTradeName.trim() || `${activeSymbol} ${currentStrategyName}`;
    const newSaved: SavedOptionTrade = {
      id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      notes: saveTradeNotes.trim(),
      createdAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }),
      symbol: activeSymbol,
      expirationDate: selectedExpiration.date,
      dte: selectedExpiration.dte,
      legs: builderLegs,
      strategyName: currentStrategyName,
      underlyingPriceAtSave: spot,
      ivAtSave: builderIv,
    };
    const nextList = [newSaved, ...savedTrades.filter((t) => t.name !== name)];
    setSavedTrades(nextList);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_TRADES, JSON.stringify(nextList));
    } catch {
      // ignore
    }
    setShowSaveModal(false);
    showToast(`Trade "${name}" saved! 💾`);
  };

  // Capability 10: Share Trade Link
  const handleShareTrade = () => {
    const hash = encodeTradeToHash({
      symbol: activeSymbol,
      expirationDate: selectedExpiration.date,
      dte: selectedExpiration.dte,
      legs: builderLegs,
      strategyName: currentStrategyName,
      iv: builderIv,
    });
    const url = `${window.location.origin}${window.location.pathname}#trade=${hash}`;
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => showToast("Shareable link copied to clipboard! 📋"),
        () => showToast("Link generated in address bar")
      );
    } else {
      window.location.hash = `trade=${hash}`;
      showToast("Link set in address bar!");
    }
  };

  // Capability 11: Load Saved Trade
  const handleLoadSavedTrade = (trade: SavedOptionTrade) => {
    setActiveSymbol(trade.symbol);
    setSymbolInput(trade.symbol);
    const exp = expirations.find((e) => e.date === trade.expirationDate) || expirations[0];
    setSelectedExpiration(exp);
    setBuilderLegs(trade.legs);
    setBuilderIv(trade.ivAtSave || 44.2);
    setShowSavedTradesModal(false);
    showToast(`Loaded saved trade: ${trade.name}`);
  };

  const handleDeleteSavedTrade = (tradeId: string) => {
    const nextList = savedTrades.filter((t) => t.id !== tradeId);
    setSavedTrades(nextList);
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_TRADES, JSON.stringify(nextList));
    } catch {
      // ignore
    }
    showToast("Saved trade deleted.");
  };

  // Capability 12: Revert to Previous Trade
  const handleRevertToPrevious = () => {
    if (previousStrategyLegs) {
      setBuilderLegs([...previousStrategyLegs]);
      reanalyze(previousStrategyLegs);
      setIsComparingPrevious(false);
      showToast("Reverted to previous strategy configuration.");
    }
  };

  // Fast order ticket context creator
  const sendToFastOrder = () => {
    if (!onPreviewTrade || !selectedStrategy) return;
    const ctx: OptionsTradeContext = {
      symbol: activeSymbol,
      action: sentiment.includes("bearish") ? "SELL_SHORT" : "BUY",
      quantity: 1,
      underlyingPrice: quote.price,
      label: `${selectedStrategy.name} (${selectedExpiration.date})`,
      legs: builderLegs.map(
        (leg) =>
          `${leg.side} ${leg.quantity} ${
            leg.optionType === "STOCK" ? "Shares" : leg.strike + leg.optionType[0]
          } @ $${leg.entryPrice.toFixed(2)}`
      ),
    };
    onPreviewTrade(ctx);
  };

  // Filtered Strategy Library (Capability 1)
  const filteredStrategyLibrary = useMemo(() => {
    return STRATEGY_LIBRARY.filter((s) => {
      const matchCat = strategyCategoryFilter === "All" || s.category === strategyCategoryFilter;
      const matchSearch =
        strategySearchQuery.trim() === "" ||
        s.name.toLowerCase().includes(strategySearchQuery.toLowerCase()) ||
        s.subtitle.toLowerCase().includes(strategySearchQuery.toLowerCase()) ||
        s.description.toLowerCase().includes(strategySearchQuery.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [strategyCategoryFilter, strategySearchQuery]);

  // Autocomplete suggestions for stock search
  const filteredTickers = useMemo(() => {
    if (!symbolInput) return POPULAR_TICKERS.slice(0, 8);
    const q = symbolInput.trim().toUpperCase();
    return POPULAR_TICKERS.filter((t) => t.symbol.includes(q) || t.companyName.toUpperCase().includes(q));
  }, [symbolInput]);

  return (
    <div className="strat-discovery-container">
      {/* Toast Alert Notification */}
      {toastMessage && (
        <div className="strat-toast-notification">
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Top View Mode Switcher */}
      <div className="strat-view-tabs">
        <div className="strat-view-tab-buttons">
          <button
            type="button"
            className={`strat-view-tab-btn ${activeView === "builder" ? "active" : ""}`}
            onClick={() => setActiveView("builder")}
          >
            📊 Builder / Payoff Analyzer
          </button>
          <button
            type="button"
            className={`strat-view-tab-btn ${activeView === "discovery" ? "active" : ""}`}
            onClick={() => setActiveView("discovery")}
          >
            🔍 Discovery Scanner
          </button>
        </div>

        <div className="strat-top-controls-group">
          <button
            type="button"
            className={`strat-action-chip refresh ${isQuoteRefreshing ? "refreshing" : ""}`}
            onClick={handleRefreshOptions}
            disabled={isQuoteRefreshing}
            title={`Refresh options quotes & market data for ${activeSymbol}`}
          >
            <span className={isQuoteRefreshing ? "strat-spin" : ""}>↻</span> {isQuoteRefreshing ? "Refreshing…" : "Refresh"}
            {lastRefreshedAt && <span className="strat-chip-subtime">{lastRefreshedAt}</span>}
          </button>
          <div className={`strat-autorefresh-group ${autoRefreshEnabled ? "active" : ""}`}>
            <button
              type="button"
              className={`strat-action-chip autorefresh ${autoRefreshEnabled ? "active" : ""}`}
              onClick={() => {
                const next = !autoRefreshEnabled;
                setAutoRefreshEnabled(next);
                if (next) {
                  showToast(`Auto-refresh enabled (${autoRefreshInterval}s)`);
                } else {
                  showToast("Auto-refresh paused");
                }
              }}
              title={
                autoRefreshEnabled
                  ? `Auto-refresh active every ${autoRefreshInterval}s (click to turn off)`
                  : "Turn on auto-refresh for options quotes & market data"
              }
              aria-pressed={autoRefreshEnabled}
            >
              <span className={`autorefresh-dot ${autoRefreshEnabled ? "active" : ""}`} />
              <span>Auto-Refresh</span>
              <span className={`autorefresh-badge ${autoRefreshEnabled ? "on" : "off"}`}>
                {autoRefreshEnabled ? "ON" : "OFF"}
              </span>
            </button>
            {autoRefreshEnabled && (
              <select
                className="strat-autorefresh-select"
                value={autoRefreshInterval}
                onChange={(e) => {
                  const nextVal = Number(e.target.value);
                  setAutoRefreshInterval(nextVal);
                  showToast(`Auto-refresh interval set to ${nextVal}s`);
                }}
                title="Select auto-refresh interval"
                aria-label="Auto-refresh interval"
              >
                <option value={10}>10s</option>
                <option value={15}>15s</option>
                <option value={30}>30s</option>
                <option value={60}>1m</option>
                <option value={120}>2m</option>
                <option value={300}>5m</option>
              </select>
            )}
          </div>
          <button
            type="button"
            className="strat-action-chip highlight"
            onClick={() => setShowStrategyModal(true)}
            title={`Browse ${STRATEGY_LIBRARY.length} pre-made options strategies`}
          >
            📚 Strategies ({STRATEGY_LIBRARY.length})
          </button>
          <button
            type="button"
            className="strat-action-chip"
            onClick={() => setShowSavedTradesModal(true)}
            title="Open saved strategies & tracking"
          >
            📂 Saved Trades ({savedTrades.length})
          </button>
          <button
            type="button"
            className="strat-action-chip"
            onClick={handleShareTrade}
            title="Copy shareable trade link to clipboard"
          >
            🔗 Share
          </button>
          <button
            type="button"
            className="strat-action-chip save"
            onClick={() => {
              setSaveTradeName(`${activeSymbol} ${currentStrategyName}`);
              setShowSaveModal(true);
            }}
            title="Save this strategy"
          >
            💾 Save
          </button>
          <span className="strat-env-badge">
            ⚡ {activeEnv} · Black-Scholes
          </span>
        </div>
      </div>

      {/* ====================================================================
          VIEW 1: STRATEGY DISCOVERY SCANNER (IMAGE 2)
          ==================================================================== */}
      {activeView === "discovery" && (
        <div className="strat-discovery-view">
          <div className="strat-discovery-header">
            {/* Top Row: Symbol & Sentiment (Left) and Optimization Bias & Factors (Right) Side-by-Side */}
            <div className="strat-discovery-top-row">
              {/* Left Column (Image 1): Symbol Input, Quote Price Badge & 6 Sentiment Direction Buttons */}
              <div className="strat-discovery-left-col">
                <form onSubmit={handleSymbolSubmit} className="strat-symbol-bar">
                  <div className="strat-symbol-input-wrap">
                    <label>Symbol:</label>
                    <input
                      type="text"
                      value={symbolInput}
                      onChange={(e) => {
                        setSymbolInput(e.target.value);
                        setShowSymbolSearchMenu(true);
                      }}
                      onFocus={() => setShowSymbolSearchMenu(true)}
                      placeholder="TSLA, /ES..."
                    />
                  </div>

                  <div className="strat-price-badge">
                    ${quote.price.toFixed(2)}
                    <span className={`strat-change-pill ${quote.change >= 0 ? "gain" : "loss"}`}>
                      {quote.change >= 0 ? "+" : ""}
                      {quote.changePercent.toFixed(2)}% ({quote.change >= 0 ? "+$" : "-$"}{Math.abs(quote.change).toFixed(2)})
                    </span>
                    <span className="strat-delayed-tag">↻ Delayed</span>
                    <button
                      type="button"
                      className="strat-mini-refresh-btn"
                      onClick={handleRefreshOptions}
                      disabled={isQuoteRefreshing}
                      title={`Refresh ${activeSymbol} quote & options`}
                    >
                      <span className={isQuoteRefreshing ? "strat-spin" : ""}>↻</span>
                    </button>
                  </div>
                </form>

                {/* Symbol Autocomplete Dropdown */}
                {showSymbolSearchMenu && (
                  <div className="strat-symbol-dropdown-overlay" onClick={() => setShowSymbolSearchMenu(false)}>
                    <div className="strat-symbol-dropdown" onClick={(e) => e.stopPropagation()}>
                      <div className="strat-dropdown-header">Stocks, ETFs & Futures</div>
                      {filteredTickers.map((t) => (
                        <div
                          key={t.symbol}
                          className="strat-dropdown-item"
                          onClick={() => handleSelectSymbol(t.symbol)}
                        >
                          <span className="strat-dropdown-sym">{t.symbol}</span>
                          <span className="strat-dropdown-name">{t.companyName}</span>
                          <span className="strat-dropdown-price">${t.price.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sentiment Selector Group (6 Circular Buttons Aligned Horizontally with Icons) */}
                <div className="strat-sentiment-group strat-sentiment-selector" role="radiogroup" aria-label="Market sentiment">
                  {SENTIMENT_ITEMS.map((item) => {
                    const isActive = sentiment === item.id;
                    return (
                      <div
                        key={item.id}
                        className={`strat-sentiment-btn-wrap strat-sentiment-card ${item.id} ${isActive ? "active" : ""}`}
                        onClick={() => handleSentimentChange(item.id)}
                        role="radio"
                        aria-checked={isActive}
                        title={item.label}
                      >
                        <div className="strat-sentiment-circle">
                          {item.icon}
                        </div>
                        <span className="strat-sentiment-label">{item.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right Column (Image 2): Optimization Objective Regime & Evaluation Factors Breakdown */}
              <div className="strat-discovery-right-col">
                {/* Optimization Slider */}
                <div className="strat-opt-slider-wrap">
                  <span>← Max Return</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={optimizationBias}
                    onChange={(e) => setOptimizationBias(Number(e.target.value))}
                  />
                  <span>Max Chance →</span>
                </div>

                {/* Evaluation Factors UI Breakdown Panel */}
                <div className="strat-opt-factors-panel">
                  <div className="strat-opt-regime-row">
                    <span className="strat-opt-regime-badge">{optFactors.regime}</span>
                    <span className="strat-opt-regime-desc">{optFactors.regimeDescription}</span>
                  </div>
                  <div className="strat-factors-grid">
                    <div className="strat-factor-card" title="Target Return & Leverage">
                      <div className="strat-factor-header">
                        <span className="strat-factor-title">Target Return</span>
                        <span className="strat-factor-weight">{optFactors.returnWeight}% wt</span>
                      </div>
                      <div className="strat-factor-bar-bg">
                        <div className="strat-factor-bar-fill return" style={{ width: `${optFactors.returnWeight}%` }} />
                      </div>
                    </div>
                    <div className="strat-factor-card" title="Win Probability (POP)">
                      <div className="strat-factor-header">
                        <span className="strat-factor-title">Win Prob (POP)</span>
                        <span className="strat-factor-weight">{optFactors.chanceWeight}% wt</span>
                      </div>
                      <div className="strat-factor-bar-bg">
                        <div className="strat-factor-bar-fill chance" style={{ width: `${optFactors.chanceWeight}%` }} />
                      </div>
                    </div>
                    <div className="strat-factor-card" title="Breakeven Buffer">
                      <div className="strat-factor-header">
                        <span className="strat-factor-title">Breakeven</span>
                        <span className="strat-factor-weight">{optFactors.safetyWeight}% wt</span>
                      </div>
                      <div className="strat-factor-bar-bg">
                        <div className="strat-factor-bar-fill safety" style={{ width: `${optFactors.safetyWeight * 3.5}%` }} />
                      </div>
                    </div>
                    <div className="strat-factor-card" title="Capital Efficiency">
                      <div className="strat-factor-header">
                        <span className="strat-factor-title">Cap. Efficiency</span>
                        <span className="strat-factor-weight">{optFactors.capitalWeight}% wt</span>
                      </div>
                      <div className="strat-factor-bar-bg">
                        <div className="strat-factor-bar-fill capital" style={{ width: `${optFactors.capitalWeight * 4.5}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Target Price & Budget Bar */}
            <div className="strat-target-bar">
              <div className="strat-input-pill" title="Tap or edit to customize target price. Defaults to ±1x or ±2x implied move based on sentiment.">
                <label>Target Price: $</label>
                <input
                  type="number"
                  step="0.1"
                  value={targetPrice}
                  onChange={(e) => setTargetPrice(Number(e.target.value))}
                />
                <span className={`strat-pct-tag ${targetPctChange >= 0 ? "gain" : "loss"}`}>
                  ({targetPctChange >= 0 ? `+${targetPctChange}%` : `${targetPctChange}%`})
                </span>
              </div>

              <div className="strat-implied-move-info" title="Market Implied Move calculated from options market IV and days to expiration">
                <span className="strat-implied-icon">📐</span>
                <span>Implied Move: <strong>±${computeImpliedMove(quote.price, builderIv, selectedExpiration.dte).toFixed(2)}</strong> (±{(((computeImpliedMove(quote.price, builderIv, selectedExpiration.dte) / (quote.price || 1)) * 100).toFixed(1))}%)</span>
              </div>

              <div className="strat-input-pill">
                <label>Budget: $</label>
                <input
                  type="text"
                  placeholder="None"
                  value={budget !== null ? budget : ""}
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    setBudget(val === "" ? null : Number(val) || null);
                  }}
                />
              </div>

              <div className="strat-input-pill" title="Filter strategies by minimum Reward/Risk (Max Profit to Max Loss ratio)">
                <label>Min R:R:</label>
                <select
                  value={minRewardRiskRatio ?? ""}
                  onChange={(e) => setMinRewardRiskRatio(e.target.value === "" ? null : Number(e.target.value))}
                  className="strat-rr-select"
                >
                  <option value="">Any R:R</option>
                  <option value="1">≥ 1:1 (Profit &gt; Loss)</option>
                  <option value="1.5">≥ 1:1.5 (+50%)</option>
                  <option value="2">≥ 1:2 (2x)</option>
                  <option value="3">≥ 1:3 (3x)</option>
                  <option value="4">≥ 1:4 (4x)</option>
                </select>
              </div>
            </div>

            {/* Expiration Timeline Chips */}
            <div className="strat-timeline-row">
              {expirations.map((exp) => (
                <button
                  key={exp.date}
                  type="button"
                  className={`strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                  onClick={() => handleSelectExpiration(exp)}
                >
                  <span className="strat-chip-month">{exp.monthGroup}</span>
                  <span className="strat-chip-day">{exp.dayLabel}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Discovered Strategies Grid */}
          <div className="strat-cards-grid">
            {discoveredStrategies.map((strat) => {
              const returnLabel =
                strat.returnOnRiskPct !== null
                  ? `${strat.returnOnRiskPct}% Return on risk`
                  : `${strat.returnOnCollateralPct}% Return on collateral`;

              return (
                <div key={strat.id} className="strat-card strat-discovery-card">
                  <div className="strat-card-title-row">
                    <div className="strat-card-header-left">
                      <span className="strat-card-name">{strat.name}</span>
                      <span className="strat-card-subtitle">{strat.subtitle}</span>
                    </div>
                    {strat.rewardRiskRatio !== undefined && strat.rewardRiskRatio !== null && (
                      <span className="strat-stat-rr-badge" title="Reward / Risk Ratio (Max Profit vs Max Loss)">
                        R:R 1:{strat.rewardRiskRatio}
                      </span>
                    )}
                    {strat.maxProfit === null && (
                      <span className="strat-stat-rr-badge uncapped" title="Uncapped Upside Potential">
                        R:R ∞ (Uncapped)
                      </span>
                    )}
                  </div>

                  <div className="strat-card-stats-row">
                    <div className="strat-card-stat-left">
                      <span className="strat-stat-return">{returnLabel}</span>
                      <span className="strat-stat-profit">${strat.targetProfit.toLocaleString()} Profit</span>
                    </div>
                    <div className="strat-card-stat-right">
                      <span className="strat-stat-chance">{strat.chanceOfProfit}% Chance 🔒</span>
                      <span className="strat-stat-risk">
                        ${strat.riskOrCollateral.toLocaleString()} {strat.returnOnRiskPct !== null ? "Risk" : "Collateral"}
                      </span>
                    </div>
                  </div>

                  <div style={{ height: "90px", width: "100%", margin: "0.4rem 0" }}>
                    <UniversalChart
                      mode="mini_payoff"
                      points={strat.miniPayoffPoints.map((pt) => ({ x: pt.price, y: pt.pnl }))}
                      spotPrice={spot}
                      targetPrice={targetPrice}
                      width={300}
                      height={90}
                      ariaLabel={`${strat.name} mini payoff chart`}
                    />
                  </div>

                  <div className="strat-card-actions-row">
                    <button
                      type="button"
                      className="strat-card-btn-builder"
                      onClick={() => openInBuilder(strat)}
                    >
                      Open in Builder 📊
                    </button>
                    <button
                      type="button"
                      className="strat-card-btn-eval"
                      onClick={() => {
                        setEvaluatingStrategy({
                          symbol: activeSymbol,
                          strategyName: strat.name,
                          sentiment,
                          targetPrice,
                          expirationDate: selectedExpiration.date,
                          dte: selectedExpiration.dte,
                          legsText: strat.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                          netDebit: strat.netDebit,
                          maxLoss: strat.riskOrCollateral,
                          maxProfit: strat.maxProfit,
                          chanceOfProfit: strat.chanceOfProfit,
                          breakevenText: strat.breakevens.map((b) => `$${b.toFixed(2)}`).join(" · "),
                          underlyingPrice: spot,
                          legs: strat.legs.map((l) => `${l.side} ${l.quantity} ${activeSymbol} ${selectedExpiration.date} $${l.strike} ${l.optionType}`),
                        });
                      }}
                      title="Evaluate with Workers AI LLM"
                    >
                      🧠 Evaluate with LLM
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ====================================================================
          VIEW 2: INTERACTIVE STRATEGY BUILDER / PAYOFF ANALYZER (IMAGE 1)
          ==================================================================== */}
      {activeView === "builder" && (
        <div className="strat-builder-view">
          {/* Capability: Flow Trade Banner (Screenshot 4) */}
          {flowTradeBanner && !isFlowBannerDismissed && (
            <div className="strat-flow-alert-banner">
              <div className="strat-flow-alert-content">
                <span className="strat-flow-alert-title">{flowTradeBanner.title}</span>
                <span className="strat-flow-alert-subtitle">{flowTradeBanner.returnText}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                {onBackToFlows && (
                  <button type="button" className="strat-flow-back-btn" onClick={onBackToFlows}>
                    ← Back to Flows
                  </button>
                )}
                <button
                  type="button"
                  className="strat-flow-alert-close"
                  onClick={() => setIsFlowBannerDismissed(true)}
                  aria-label="Dismiss banner"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Header Bar */}
          <div className="strat-builder-header-bar">
            <div className="strat-builder-title-group">
              <div className="strat-strategy-name-badge-wrap">
                <h2>{currentStrategyName}</h2>
                <button
                  type="button"
                  className="strat-change-strat-btn"
                  onClick={() => setShowStrategyModal(true)}
                  title={`Change Strategy (${STRATEGY_LIBRARY.length} available)`}
                >
                  Change ▾
                </button>
              </div>
              <span title={selectedStrategy?.description} className="strat-info-icon">
                ⓘ {selectedStrategy?.subtitle}
              </span>
            </div>

            <div className="strat-builder-action-btns">
              <button
                type="button"
                className="strat-btn-action"
                onClick={() => setShowPositionsDrawer(!showPositionsDrawer)}
              >
                Positions ({builderLegs.filter((l) => !l.isClosed).length} open) ☰
              </button>
              <button
                type="button"
                className="strat-btn-action"
                onClick={() => setShowHistoryModal(true)}
                title="View single contract price history over time"
              >
                History 📈
              </button>
              <button type="button" className="strat-btn-action" onClick={sendToFastOrder}>
                Order Ticket ⚡
              </button>
              <button
                type="button"
                className="strat-btn-action eval-llm"
                onClick={() => {
                  setEvaluatingStrategy({
                    symbol: activeSymbol,
                    strategyName: currentStrategyName,
                    sentiment,
                    targetPrice,
                    expirationDate: selectedExpiration.date,
                    dte: selectedExpiration.dte,
                    legsText: builderLegs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
                    netDebit: selectedStrategy?.netDebit,
                    maxLoss: selectedStrategy?.riskOrCollateral ?? null,
                    maxProfit: selectedStrategy?.maxProfit ?? null,
                    chanceOfProfit: selectedStrategy?.chanceOfProfit,
                    breakevenText: (selectedStrategy?.breakevens || []).map((b) => `$${b.toFixed(2)}`).join(" · "),
                    underlyingPrice: spot,
                    legs: builderLegs.map((l) => `${l.side} ${l.quantity} ${activeSymbol} ${selectedExpiration.date} $${l.strike} ${l.optionType}`),
                  });
                }}
              >
                🧠 Evaluate with LLM
              </button>
              <OptionsDataDownloadDropdown
                symbol={activeSymbol}
                activeEnv={activeEnv}
                userLogin={userLogin}
                label="📥 Export Data"
              />
            </div>
          </div>

          {/* Capability 12: Strategy Comparison Banner */}
          {previousStrategyLegs && previousStrategyLegs.length > 0 && (
            <div className="strat-compare-banner">
              <div className="strat-compare-label">
                <span>🔀 Strategy modified</span>
                <span className="strat-compare-hint">Compare payoff against previous configuration</span>
              </div>
              <div className="strat-compare-actions">
                <button
                  type="button"
                  className={`strat-compare-toggle-btn ${isComparingPrevious ? "active" : ""}`}
                  onClick={() => setIsComparingPrevious(!isComparingPrevious)}
                >
                  {isComparingPrevious ? "Hide Comparison" : "Compare with Previous"}
                </button>
                <button
                  type="button"
                  className="strat-compare-revert-btn"
                  onClick={handleRevertToPrevious}
                >
                  ↩ Revert
                </button>
              </div>
            </div>
          )}

          {/* Subheader: Symbol Quote Bar & Quick Stock Search */}
          <div className="strat-symbol-quote-bar">
            <div className="strat-quote-search-inline">
              <span className="strat-symbol-pill">{activeSymbol}</span>
              <button
                type="button"
                className="strat-sym-quick-btn"
                onClick={() => setShowSymbolSearchMenu(!showSymbolSearchMenu)}
                title="Search Stock / ETF / Futures"
              >
                🔍 Search
              </button>
            </div>
            <span className="strat-quote-name">{quote.companyName}</span>
            <span className="strat-quote-price">${quote.price.toFixed(2)}</span>
            <span className={`strat-quote-change ${quote.change >= 0 ? "gain" : "loss"}`}>
              {quote.change >= 0 ? "+" : ""}
              {quote.changePercent.toFixed(2)}% ({quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)})
            </span>
            <span className="strat-delayed-tag">↻ Realtime/Delayed</span>
            <button
              type="button"
              className="strat-mini-refresh-btn"
              onClick={handleRefreshOptions}
              disabled={isQuoteRefreshing}
              title={`Refresh ${activeSymbol} quote & options legs`}
            >
              <span className={isQuoteRefreshing ? "strat-spin" : ""}>↻</span> {isQuoteRefreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {/* Quick Symbol Autocomplete Overlay in Builder */}
          {showSymbolSearchMenu && (
            <div className="strat-symbol-dropdown-overlay" onClick={() => setShowSymbolSearchMenu(false)}>
              <div className="strat-symbol-dropdown" onClick={(e) => e.stopPropagation()}>
                <div className="strat-dropdown-search-wrap">
                  <input
                    type="text"
                    value={symbolInput}
                    onChange={(e) => setSymbolInput(e.target.value)}
                    placeholder="Search symbol (e.g. NVDA, /ES)..."
                    autoFocus
                  />
                </div>
                <div className="strat-dropdown-header">Popular Stocks, ETFs & Futures</div>
                {filteredTickers.map((t) => (
                  <div
                    key={t.symbol}
                    className="strat-dropdown-item"
                    onClick={() => handleSelectSymbol(t.symbol)}
                  >
                    <span className="strat-dropdown-sym">{t.symbol}</span>
                    <span className="strat-dropdown-name">{t.companyName}</span>
                    <span className="strat-dropdown-price">${t.price.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Expiration Timeline Chips in Builder */}
          <div className="strat-builder-exp-bar">
            <div className="strat-builder-exp-title">
              EXPIRATION: <span className="highlight">{selectedExpiration.label}</span> ({selectedExpiration.dte} DTE)
            </div>
            <div className="strat-exp-chips-scroll">
              {expirations.map((exp) => (
                <button
                  key={exp.date}
                  type="button"
                  className={`strat-exp-chip strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                  onClick={() => handleBuilderExpirationChange(exp)}
                  title={`${exp.label} (${exp.dte} DTE)`}
                >
                  <span className="strat-chip-month">{exp.monthGroup}</span>
                  <span className="strat-chip-day">{exp.dayLabel}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Capability 3: Strike Ruler with Volume Bars & Call/Put Badges */}
          <div className="strat-strike-ruler-wrap">
            <div className="strat-strike-ruler-header">
              <span className="strat-strike-ruler-title">STRIKE RULER:</span>
              <div className="strat-ruler-quick-tools">
                <span className="strat-ruler-legend">
                  <span className="dot call"></span> Call (Green)
                  <span className="dot put"></span> Put (Red)
                  <span className="dot vol"></span> Vol Bars
                </span>
                <button
                  type="button"
                  className="strat-ruler-shift-btn"
                  onClick={() => handleMoveAllStrikes(-1)}
                  title="Shift all strikes down 1 step"
                >
                  ◀ Move All
                </button>
                <button
                  type="button"
                  className="strat-ruler-shift-btn"
                  onClick={() => handleMoveAllStrikes(1)}
                  title="Shift all strikes up 1 step"
                >
                  Move All ▶
                </button>
                <button
                  type="button"
                  className="strat-ruler-shift-btn wings"
                  onClick={() => handleSymmetricMove(1)}
                  title="Expand wings symmetrically for condors & butterflies"
                >
                  ↔ Symmetric Wings
                </button>
              </div>
            </div>

            <div className="strat-strike-ruler">
              <div className="strat-ruler-ticks">
                {rulerStrikes.map((k) => {
                  const callBuy = builderLegs.find((l) => l.strike === k && l.optionType === "CALL" && l.side === "BUY" && !l.isClosed);
                  const callSell = builderLegs.find((l) => l.strike === k && l.optionType === "CALL" && l.side === "SELL" && !l.isClosed);
                  const putBuy = builderLegs.find((l) => l.strike === k && l.optionType === "PUT" && l.side === "BUY" && !l.isClosed);
                  const putSell = builderLegs.find((l) => l.strike === k && l.optionType === "PUT" && l.side === "SELL" && !l.isClosed);
                  const isAtm = Math.abs(k - spot) < strikeStep * 0.5;

                  // Simulated volume heights for visual realism
                  const distFromSpot = Math.abs(k - spot) / spot;
                  const callVolHeight = Math.max(3, Math.min(22, Math.round(20 * Math.exp(-distFromSpot * 8))));
                  const putVolHeight = Math.max(3, Math.min(22, Math.round(18 * Math.exp(-distFromSpot * 8))));

                  return (
                    <div
                      key={k}
                      className={`strat-ruler-tick ${isAtm ? "highlight" : ""}`}
                      onClick={(e) => {
                        const firstLeg = builderLegs.find((l) => l.optionType !== "STOCK" && !l.isClosed);
                        if (firstLeg) handleStrikeChange(firstLeg.id, k, e);
                      }}
                      title={`Strike $${k} (Click to set primary leg strike. Shift+Click moves all)`}
                    >
                      {/* Volume Indicator Bar (Call Volume - Green on Top) */}
                      <div className="strat-vol-bar call" style={{ height: `${callVolHeight}px` }} title={`Call Volume at $${k}`} />

                      {/* Long Call (Top) or Short Call (Bottom) */}
                      {callBuy && <div className="strat-ruler-badge call long">+{k}C</div>}
                      {callSell && <div className="strat-ruler-badge call short">-{k}C</div>}

                      <div className="strat-ruler-tick-bar" />
                      <span className="strat-ruler-price-txt">{k}</span>

                      {/* Long Put (Top) or Short Put (Bottom) */}
                      {putBuy && <div className="strat-ruler-badge put long">+{k}P</div>}
                      {putSell && <div className="strat-ruler-badge put short">-{k}P</div>}

                      {/* Volume Indicator Bar (Put Volume - Red on Bottom) */}
                      <div className="strat-vol-bar put" style={{ height: `${putVolHeight}px` }} title={`Put Volume at $${k}`} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Capability 8: Adjusting the Options (Legs Inspector Cards) */}
          <div className="strat-leg-strike-sliders-wrap">
            <div className="strat-leg-strike-sliders-title">
              <div className="strat-legs-title-text">
                <span>Option Legs Inspector ({builderLegs.length})</span>
                <span className="strat-legs-hint">
                  Edit price, quantity, side, cost basis or exclude/close individual legs
                </span>
              </div>
              <div className="strat-add-leg-btns">
                <button
                  type="button"
                  className="strat-add-leg-btn call"
                  onClick={() => handleAddLeg("CALL")}
                >
                  + Add Call
                </button>
                <button
                  type="button"
                  className="strat-add-leg-btn put"
                  onClick={() => handleAddLeg("PUT")}
                >
                  + Add Put
                </button>
              </div>
            </div>

            <div className="strat-legs-grid">
              {builderLegs.map((leg) => {
                const isExcluded = Boolean(leg.isExcluded);
                const isClosed = Boolean(leg.isClosed);
                const hasCustomCost = leg.customCostBasis !== undefined;
                const costBasis = hasCustomCost ? leg.customCostBasis! : leg.entryPrice;

                // Warnings (Capability 8)
                const isLowVol = (leg.volume ?? 120) < 50;
                const isLowOi = (leg.openInterest ?? 250) < 100;
                const spreadPct = leg.bid > 0 ? ((leg.ask - leg.bid) / leg.bid) * 100 : 0;
                const isWideSpread = spreadPct > 10;

                return (
                  <div
                    key={leg.id}
                    className={`strat-leg-card ${isExcluded ? "excluded" : ""} ${isClosed ? "closed" : ""}`}
                  >
                    <div className="strat-leg-header-row">
                      <div className="strat-leg-side-qty">
                        <button
                          type="button"
                          className="strat-qty-btn"
                          onClick={() => handleLegQuantityChange(leg.id, -1)}
                          disabled={isClosed}
                        >
                          -
                        </button>
                        <span className="strat-leg-qty">{leg.quantity}x</span>
                        <button
                          type="button"
                          className="strat-qty-btn"
                          onClick={() => handleLegQuantityChange(leg.id, 1)}
                          disabled={isClosed}
                        >
                          +
                        </button>

                        <button
                          type="button"
                          className={`strat-side-pill ${leg.side.toLowerCase()}`}
                          onClick={() => handleLegSideToggle(leg.id)}
                          disabled={isClosed}
                          title="Toggle BUY / SELL"
                        >
                          {leg.side}
                        </button>

                        <span className={`strat-type-pill ${leg.optionType.toLowerCase()}`}>
                          {leg.optionType}
                        </span>

                        <span className="strat-leg-strike-label">${leg.strike.toFixed(2)}</span>
                      </div>

                      <div className="strat-leg-cost-group">
                        <span className="strat-cost-label">Price:</span>
                        {editingLegCostId === leg.id ? (
                          <div className="strat-inline-edit-cost">
                            <input
                              type="number"
                              step="0.05"
                              value={customCostInputValue}
                              onChange={(e) => setCustomCostInputValue(e.target.value)}
                              placeholder={leg.entryPrice.toFixed(2)}
                              autoFocus
                            />
                            <button
                              type="button"
                              className="strat-cost-save-btn"
                              onClick={() => handleSaveCustomCost(leg.id)}
                            >
                              ✓
                            </button>
                            <button
                              type="button"
                              className="strat-cost-reset-btn"
                              onClick={() => handleResetCustomCost(leg.id)}
                              title="Reset to market price"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={`strat-cost-display-btn ${hasCustomCost ? "custom" : ""}`}
                            onClick={() => {
                              if (!isClosed) {
                                setEditingLegCostId(leg.id);
                                setCustomCostInputValue(costBasis.toFixed(2));
                              }
                            }}
                            title="Click to edit custom cost basis"
                          >
                            ${costBasis.toFixed(2)}
                            {hasCustomCost && <span className="strat-custom-cost-badge" title="Custom cost-basis applied">$</span>}
                          </button>
                        )}
                      </div>

                      {/* Leg Actions: Exclude, Close, Roll */}
                      <div className="strat-leg-actions-group">
                        <button
                          type="button"
                          className={`strat-leg-act-btn exclude ${isExcluded ? "active" : ""}`}
                          onClick={() => handleLegExcludeToggle(leg.id)}
                          title={isExcluded ? "Include in strategy" : "Exclude from calculations"}
                        >
                          {isExcluded ? "👁️ Excluded" : "👁️‍🗨️ Exclude"}
                        </button>

                        {!isClosed && (
                          <button
                            type="button"
                            className="strat-leg-act-btn close"
                            onClick={() => handleCloseLeg(leg.id)}
                            title="Close leg to lock in realized profit/loss"
                          >
                            ✓ Close
                          </button>
                        )}

                        {isClosed && (
                          <span className="strat-closed-tag" title={`Closed @ $${(leg.closingPrice ?? 0).toFixed(2)}`}>
                            ✓ Closed @ ${(leg.closingPrice ?? 0).toFixed(2)}
                          </span>
                        )}

                        <button
                          type="button"
                          className="strat-leg-act-btn roll"
                          onClick={() => setRollingLeg(leg)}
                          title="Roll to new strike or expiration date"
                        >
                          ↻ Roll
                        </button>
                      </div>
                    </div>

                    {/* Greeks & Strike Slider */}
                    <div className="strat-leg-body-row">
                      <div className="strat-leg-greeks-strip">
                        <span>Δ {(leg.delta * (leg.side === "BUY" ? 1 : -1)).toFixed(2)}</span>
                        <span>Γ {leg.gamma.toFixed(3)}</span>
                        <span>Θ {(leg.theta * 100).toFixed(1)}/d</span>
                        <span>ν {(leg.vega * 100).toFixed(1)}/1%</span>
                        <span className="strat-spread-txt">
                          Bid: ${leg.bid.toFixed(2)} · Ask: ${leg.ask.toFixed(2)}
                        </span>
                      </div>

                      {/* Warnings Badges */}
                      {(isLowVol || isLowOi || isWideSpread) && (
                        <div className="strat-leg-warnings-row">
                          {isLowVol && <span className="strat-warn-badge">⚠️ Low Vol</span>}
                          {isLowOi && <span className="strat-warn-badge">⚠️ Low OI</span>}
                          {isWideSpread && <span className="strat-warn-badge">⚠️ Wide Spread</span>}
                        </div>
                      )}

                      {!isClosed && (
                        <div className="strat-leg-slider-row">
                          <button
                            type="button"
                            className="strat-strike-step-btn"
                            onClick={(e) => handleStrikeStep(leg.id, -1, e)}
                            title="Step strike down (Hold shift to move all)"
                          >
                            ◀ -
                          </button>
                          <input
                            type="range"
                            min={minStrike}
                            max={maxStrike}
                            step={strikeStep}
                            value={leg.strike}
                            onChange={(e) => handleStrikeChange(leg.id, Number(e.target.value), e)}
                            className="strat-leg-strike-range"
                          />
                          <button
                            type="button"
                            className="strat-strike-step-btn"
                            onClick={(e) => handleStrikeStep(leg.id, 1, e)}
                            title="Step strike up (Hold shift to move all)"
                          >
                            + ▶
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Capability 4: Simultaneous Side-by-Side Stats & Greeks Display */}
          <div className="strat-stats-card-container">
            <div className="strat-stats-header-tabs">
              <button
                type="button"
                className={`strat-stats-tab ${showKeyStats ? "active" : ""}`}
                onClick={toggleKeyStats}
                title={showKeyStats ? "Key Stats & P&L active (click to toggle)" : "Click to enable Key Stats & P&L"}
              >
                📊 Key Stats & P&L
              </button>
              <button
                type="button"
                className={`strat-stats-tab ${showNetGreeks ? "active" : ""}`}
                onClick={toggleNetGreeks}
                title={showNetGreeks ? "Net Option Greeks active (click to toggle)" : "Click to enable Net Option Greeks"}
              >
                📐 Net Option Greeks (Δ Γ Θ ν ρ)
              </button>
              {(!showKeyStats || !showNetGreeks) && (
                <button
                  type="button"
                  className="strat-stats-tab reset-both"
                  onClick={() => {
                    setShowKeyStats(true);
                    setShowNetGreeks(true);
                  }}
                  title="Enable both side-by-side"
                >
                  ⚡ Show Both Side-by-Side
                </button>
              )}
            </div>

            <div className={`strat-stats-side-by-side-row ${showKeyStats && showNetGreeks ? "dual" : "single"}`}>
              {showKeyStats && (
                <div className={`strat-stats-panel-col key-stats ${!showNetGreeks ? "full" : ""}`}>
                  <div className={`strat-metrics-strip ${showKeyStats && showNetGreeks ? "side-by-side" : ""}`}>
                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">
                        🪙 {selectedStrategy && selectedStrategy.netDebit >= 0 ? "NET DEBIT:" : "NET CREDIT:"}
                      </span>
                      <span className="strat-metric-val">
                        ${Math.abs(selectedStrategy?.netDebit ?? 0).toLocaleString()}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">📊 EST. MARGIN:</span>
                      <span className="strat-metric-val">
                        ${(selectedStrategy?.estMargin ?? 0).toLocaleString()}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">↘ MAX LOSS:</span>
                      <span className="strat-metric-val loss">
                        {selectedStrategy?.maxLoss === null ? "Infinite" : `$${selectedStrategy?.maxLoss?.toLocaleString()}`}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">↗ MAX PROFIT:</span>
                      <span className="strat-metric-val gain">
                        {selectedStrategy?.maxProfit === null ? "Unlimited" : `$${selectedStrategy?.maxProfit?.toLocaleString()}`}
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">🎲 CHANCE OF PROFIT:</span>
                      <span className="strat-metric-val highlight">
                        {selectedStrategy?.chanceOfProfit ?? 50}% 🔒
                      </span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">→ BREAKEVEN:</span>
                      <span className="strat-metric-val breakeven">
                        {selectedStrategy?.breakevenText || `Below $${spot.toFixed(2)}`}
                      </span>
                    </div>

                    {/* Realized & Unrealized P&L Display */}
                    {(pnlBreakdown.hasClosedPositions || pnlBreakdown.hasCustomCostBasis) && (
                      <>
                        <div className="strat-metric-cell">
                          <span className="strat-metric-label">💰 REALIZED P&L:</span>
                          <span className={`strat-metric-val ${pnlBreakdown.realizedPnl >= 0 ? "gain" : "loss"}`}>
                            {pnlBreakdown.realizedPnl >= 0 ? "+" : ""}${pnlBreakdown.realizedPnl.toFixed(2)}
                          </span>
                        </div>
                        <div className="strat-metric-cell">
                          <span className="strat-metric-label">📈 UNREALIZED P&L:</span>
                          <span className={`strat-metric-val ${pnlBreakdown.unrealizedPnl >= 0 ? "gain" : "loss"}`}>
                            {pnlBreakdown.unrealizedPnl >= 0 ? "+" : ""}${pnlBreakdown.unrealizedPnl.toFixed(2)}
                          </span>
                        </div>
                      </>
                    )}

                    {flowTradeBanner && !pnlBreakdown.hasClosedPositions && !pnlBreakdown.hasCustomCostBasis && (
                      <div className="strat-metric-cell">
                        <span className="strat-metric-label">💰 UNREALIZED LOSS:</span>
                        <span className="strat-metric-val loss">
                          {flowTradeBanner.returnText.split(" return")[0]}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {showNetGreeks && (
                <div className={`strat-stats-panel-col net-greeks ${!showKeyStats ? "full" : ""}`}>
                  <div className={`strat-metrics-strip greeks ${showKeyStats && showNetGreeks ? "side-by-side" : ""}`}>
                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">Δ NET DELTA:</span>
                      <span className={`strat-metric-val ${netGreeks.netDelta >= 0 ? "gain" : "loss"}`}>
                        {netGreeks.netDelta >= 0 ? "+" : ""}{netGreeks.netDelta}
                      </span>
                      <span className="strat-greek-sub">Shares equiv</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">Γ NET GAMMA:</span>
                      <span className="strat-metric-val">
                        {netGreeks.netGamma}
                      </span>
                      <span className="strat-greek-sub">Δ change / $1</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">Θ NET THETA:</span>
                      <span className={`strat-metric-val ${netGreeks.netTheta >= 0 ? "gain" : "loss"}`}>
                        {netGreeks.netTheta >= 0 ? "+" : ""}${netGreeks.netTheta}/day
                      </span>
                      <span className="strat-greek-sub">Time decay / day</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">ν NET VEGA:</span>
                      <span className={`strat-metric-val ${netGreeks.netVega >= 0 ? "gain" : "loss"}`}>
                        ${netGreeks.netVega}/1%
                      </span>
                      <span className="strat-greek-sub">PnL / 1% IV</span>
                    </div>

                    <div className="strat-metric-cell">
                      <span className="strat-metric-label">ρ NET RHO:</span>
                      <span className="strat-metric-val">
                        ${netGreeks.netRho}/1%
                      </span>
                      <span className="strat-greek-sub">Rate sensitivity</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Capability 6: Payoff Chart OR Capability 5: 2D Heatmap Matrix Table */}
          {builderDisplayMode === "graph" ? (
            <div className="strat-full-graph-wrap">
              <UniversalChart
                mode="payoff"
                points={builderGraphPoints.map((pt) => ({ x: pt.price, y: pt.pnlExpiry }))}
                secondaryPoints={
                  tRemainingDays > 0
                    ? builderGraphPoints.map((pt) => ({ x: pt.price, y: pt.pnlEvaluated }))
                    : undefined
                }
                comparisonPoints={comparisonGraphPoints}
                probabilityOverlayPoints={probabilityOverlayPoints}
                hoverProbabilities={hoverProbabilities}
                spotPrice={spot}
                targetPrice={targetPrice}
                breakevens={selectedStrategy?.breakevens || []}
                hoverX={graphHoverPrice}
                onHoverXChange={setGraphHoverPrice}
                width={850}
                height={350}
                ariaLabel={`${currentStrategyName} interactive payoff chart`}
              />
            </div>
          ) : (
            /* Capability 5: 2D Profit/Loss Matrix Heatmap Table */
            <div className="strat-table-view-wrap">
              <div className="strat-matrix-toolbar">
                <span className="strat-matrix-title">
                  ⊞ Profit/Loss Heatmap Matrix (Prices vs Calendar Dates)
                </span>
                <span className="strat-matrix-legend">
                  🪙 Ex-Dividend · 📢 Earnings
                </span>
              </div>
              <div className="strat-matrix-scroll-wrap">
                <table className="strat-matrix-table">
                  <thead>
                    <tr>
                      <th className="sticky-col">Price</th>
                      {matrix2dData.columns.map((col) => (
                        <th key={col.dateStr}>
                          <div className="strat-th-content">
                            <span>{col.label}</span>
                            <span className="strat-th-dte">({col.dteRemaining}d)</span>
                            {col.isExDiv && <span title="Estimated Ex-Dividend Date">🪙</span>}
                            {col.isEarnings && <span title="Upcoming Earnings Announcement">📢</span>}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix2dData.rows.map((row) => (
                      <tr key={row.price} className={row.isAtSpot ? "current-price-row" : ""}>
                        <td className="sticky-col price-cell">
                          {row.priceLabel} {row.isAtSpot && <span className="spot-tag">● Spot</span>}
                        </td>
                        {row.cells.map((cell) => {
                          let displayVal = "";
                          if (builderMetricMode === "pnl_dollar") {
                            displayVal = `${cell.pnlDollar >= 0 ? "+" : ""}$${cell.pnlDollar.toLocaleString()}`;
                          } else if (builderMetricMode === "pnl_pct") {
                            displayVal = `${cell.pnlPercent >= 0 ? "+" : ""}${cell.pnlPercent}%`;
                          } else if (builderMetricMode === "collateral_pct") {
                            displayVal = `${cell.riskPercent >= 0 ? "+" : ""}${cell.riskPercent}%`;
                          } else {
                            displayVal = `$${cell.contractValue.toLocaleString()}`;
                          }

                          // Heatmap color shading
                          let cellBg = "rgba(255, 255, 255, 0.03)";
                          if (cell.pnlDollar > 0) {
                            const intensity = Math.min(0.7, 0.12 + (cell.pnlDollar / (matrix2dData.maxPnl || 1)) * 0.58);
                            cellBg = `rgba(16, 185, 129, ${intensity})`;
                          } else if (cell.pnlDollar < 0) {
                            const intensity = Math.min(0.7, 0.12 + (Math.abs(cell.pnlDollar) / (Math.abs(matrix2dData.minPnl) || 1)) * 0.58);
                            cellBg = `rgba(239, 68, 68, ${intensity})`;
                          }

                          return (
                            <td
                              key={cell.dateStr}
                              style={{ background: cellBg }}
                              className={cell.pnlDollar >= 0 ? "matrix-cell gain" : "matrix-cell loss"}
                            >
                              {displayVal}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Controls Below Graph: Date Slider, Range Zoom, IV Slider */}
          <div className="strat-graph-controls-bar">
            {/* Capability 6: Days Until Expiration / Date Slider */}
            <div className="strat-date-slider-row">
              <span className="strat-slider-label">
                DATE:{" "}
                {builderDateSliderPct === 100
                  ? `At Expiration (${selectedExpiration.label})`
                  : builderDateSliderPct === 0
                  ? `Today (${selectedExpiration.dte}d left)`
                  : `In ${Math.round((builderDateSliderPct / 100) * selectedExpiration.dte)}d (${Math.round(tRemainingDays)}d left)`}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={builderDateSliderPct}
                onChange={(e) => setBuilderDateSliderPct(Number(e.target.value))}
                className="strat-date-range-slider"
              />
              <span className="strat-slider-end">(At expiration)</span>
            </div>

            {/* Subrow: Range Zoom & Capability 7: Implied Volatility Slider */}
            <div className="strat-sliders-subrow">
              <div className="strat-range-group">
                <span>RANGE: ±{effectiveRangePct.toFixed(1)}%</span>
                <div className="strat-zoom-btn-group">
                  <button
                    type="button"
                    className={`strat-zoom-btn ${builderZoomLevel === "x1" ? "active" : ""}`}
                    onClick={() => setBuilderZoomLevel("x1")}
                  >
                    ±20%
                  </button>
                  <button
                    type="button"
                    className={`strat-zoom-btn ${builderZoomLevel === "x2" ? "active" : ""}`}
                    onClick={() => setBuilderZoomLevel("x2")}
                  >
                    ±40%
                  </button>
                  <button
                    type="button"
                    className={`strat-zoom-btn ${builderZoomLevel === "x3" ? "active" : ""}`}
                    onClick={() => setBuilderZoomLevel("x3")}
                  >
                    ±70%
                  </button>
                </div>
              </div>

              {/* Capability 7: IV Slider & Presets */}
              <div className="strat-iv-group">
                <div className="strat-iv-label-row">
                  <span>IMPLIED VOLATILITY: {builderIv.toFixed(1)}%</span>
                  <div className="strat-iv-presets">
                    <button
                      type="button"
                      className="strat-iv-btn crush"
                      onClick={() => setBuilderIv(Math.max(10, Number((builderIv * 0.75).toFixed(1))))}
                      title="Simulate IV Crush post-earnings (-25%)"
                    >
                      -25% Crush
                    </button>
                    <button
                      type="button"
                      className="strat-iv-btn surge"
                      onClick={() => setBuilderIv(Math.min(150, Number((builderIv * 1.25).toFixed(1))))}
                      title="Simulate IV Expansion (+25%)"
                    >
                      +25% Surge
                    </button>
                    <button
                      type="button"
                      className="strat-iv-btn reset"
                      onClick={() => setBuilderIv(44.2)}
                      title="Reset IV to default baseline"
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <input
                  type="range"
                  min={10}
                  max={150}
                  step={0.5}
                  value={builderIv}
                  onChange={(e) => setBuilderIv(Number(e.target.value))}
                  className="strat-iv-range-slider"
                />
              </div>
            </div>
          </div>

          {/* Bottom View & Metric Mode Switchers */}
          <div className="strat-bottom-mode-bar">
            <div className="strat-mode-toggle-group">
              <button
                type="button"
                className={`strat-mode-btn ${builderDisplayMode === "graph" ? "active" : ""}`}
                onClick={() => setBuilderDisplayMode("graph")}
              >
                📈 Graph
              </button>
              <button
                type="button"
                className={`strat-mode-btn ${builderDisplayMode === "table" ? "active" : ""}`}
                onClick={() => setBuilderDisplayMode("table")}
              >
                ⊞ Matrix Table
              </button>
            </div>

            <div className="strat-metric-toggle-group">
              {(
                [
                  { id: "pnl_dollar", label: "Profit / Loss $" },
                  { id: "pnl_pct", label: "Profit / Loss %" },
                  { id: "collateral_pct", label: "% of Risk" },
                  { id: "contract_val", label: "Contract Value" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`strat-metric-pill ${builderMetricMode === m.id ? "active" : ""}`}
                  onClick={() => setBuilderMetricMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL 1: CHOOSE A STRATEGY (50+ PRE-MADE STRATEGIES - CAPABILITY 1)
          ==================================================================== */}
      {showStrategyModal && (
        <div className="strat-modal-backdrop" onClick={() => setShowStrategyModal(false)}>
          <div className="strat-strategy-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="strat-modal-header">
              <div className="strat-modal-header-titles">
                <h3>Options Strategy Library ({STRATEGY_LIBRARY.length} Strategies)</h3>
                <span>Choose a pre-made strategy to evaluate profit/loss characteristics</span>
              </div>
              <button
                type="button"
                className="strat-modal-close-btn"
                onClick={() => setShowStrategyModal(false)}
              >
                ✕
              </button>
            </div>

            {/* Filter Tabs & Search Bar */}
            <div className="strat-library-toolbar">
              <div className="strat-library-search">
                <input
                  type="text"
                  placeholder="Search by strategy name or description..."
                  value={strategySearchQuery}
                  onChange={(e) => setStrategySearchQuery(e.target.value)}
                  autoFocus
                />
              </div>

              <div className="strat-library-categories">
                {(
                  [
                    "All",
                    "Bullish",
                    "Bearish",
                    "Neutral",
                    "Volatility",
                    "Synthetics & Spreads",
                  ] as const
                ).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    className={`strat-cat-pill ${strategyCategoryFilter === cat ? "active" : ""}`}
                    onClick={() => setStrategyCategoryFilter(cat)}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Strategy Cards Grid with SVG Mini P&L Thumbnail Shapes */}
            <div className="strat-library-grid">
              {filteredStrategyLibrary.map((stratDef) => {
                return (
                  <div
                    key={stratDef.id}
                    className="strat-library-card"
                    onMouseEnter={() => setHoveredStrategyDef(stratDef)}
                    onClick={() => handleSelectPreMadeStrategy(stratDef)}
                  >
                    <div className="strat-lib-card-top">
                      <div className="strat-lib-card-name-group">
                        <span className="strat-lib-card-name">{stratDef.name}</span>
                        <span className="strat-lib-card-sub">{stratDef.subtitle}</span>
                      </div>
                      <span className={`strat-lib-risk-badge ${stratDef.riskType.toLowerCase()}`}>
                        {stratDef.riskType} Risk
                      </span>
                    </div>

                    {/* SVG Thumbnail Payoff Curve */}
                    <div className="strat-lib-svg-wrap">
                      <svg viewBox="0 0 100 50" className="strat-lib-thumbnail-svg">
                        {/* Zero baseline */}
                        <line x1="0" y1="25" x2="100" y2="25" stroke="rgba(255,255,255,0.25)" strokeWidth="1" strokeDasharray="2 2" />
                        {/* Payoff line */}
                        <path d={stratDef.pnlSvgPath} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>

                    <p className="strat-lib-desc">{stratDef.description}</p>

                    <div className="strat-lib-footer">
                      <span className="strat-lib-legs-tag">{stratDef.legsCount} Leg{stratDef.legsCount > 1 ? "s" : ""}</span>
                      <button type="button" className="strat-lib-select-btn">Select Strategy →</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL 2: ROLL LEG MODAL (CAPABILITY 8 & 11)
          ==================================================================== */}
      {rollingLeg && (
        <div className="strat-modal-backdrop" onClick={() => setRollingLeg(null)}>
          <div className="strat-roll-modal" onClick={(e) => e.stopPropagation()}>
            <div className="strat-modal-header">
              <h3>Roll Option Leg</h3>
              <button type="button" className="strat-modal-close-btn" onClick={() => setRollingLeg(null)}>
                ✕
              </button>
            </div>

            <div className="strat-roll-body">
              <p className="strat-roll-subtitle">
                Rolling {rollingLeg.side} {rollingLeg.quantity}x {rollingLeg.strike}{rollingLeg.optionType[0]} ({rollingLeg.expirationDate})
              </p>

              <div className="strat-roll-field">
                <label>Select New Expiration Date:</label>
                <div className="strat-roll-exp-chips">
                  {expirations.map((exp) => (
                    <button
                      key={exp.date}
                      type="button"
                      className={`strat-roll-exp-chip ${exp.date === selectedExpiration.date ? "active" : ""}`}
                      onClick={() => handleExecuteRoll(exp.dte, exp.date, rollingLeg.strike)}
                    >
                      {exp.label} ({exp.dte}d)
                    </button>
                  ))}
                </div>
              </div>

              <div className="strat-roll-field">
                <label>Select New Strike Price:</label>
                <div className="strat-roll-strikes-grid">
                  {rulerStrikes.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`strat-roll-strike-btn ${k === rollingLeg.strike ? "current" : ""}`}
                      onClick={() => handleExecuteRoll(selectedExpiration.dte, selectedExpiration.date, k)}
                    >
                      ${k}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL 3: PRICE HISTORY MODAL (CAPABILITY 9)
          ==================================================================== */}
      {showHistoryModal && (
        <div className="strat-modal-backdrop" onClick={() => setShowHistoryModal(false)}>
          <div className="strat-history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="strat-modal-header">
              <div>
                <h3>Strategy Price History (Past 30 Days)</h3>
                <span className="strat-modal-sub">
                  Historical contract value of {activeSymbol} {currentStrategyName}
                </span>
              </div>
              <button type="button" className="strat-modal-close-btn" onClick={() => setShowHistoryModal(false)}>
                ✕
              </button>
            </div>

            <div className="strat-history-stats-row">
              <div className="strat-hstat-cell">
                <span className="label">Current Value:</span>
                <span className="val">${Math.abs(selectedStrategy?.netDebit ?? 250).toFixed(2)}</span>
              </div>
              <div className="strat-hstat-cell">
                <span className="label">30d High:</span>
                <span className="val gain">${(Math.abs(selectedStrategy?.netDebit ?? 250) * 1.45).toFixed(2)}</span>
              </div>
              <div className="strat-hstat-cell">
                <span className="label">30d Low:</span>
                <span className="val loss">${(Math.abs(selectedStrategy?.netDebit ?? 250) * 0.65).toFixed(2)}</span>
              </div>
              <div className="strat-hstat-cell">
                <span className="label">Average:</span>
                <span className="val">${(Math.abs(selectedStrategy?.netDebit ?? 250) * 1.05).toFixed(2)}</span>
              </div>
            </div>

            <div style={{ height: "220px", width: "100%", margin: "1rem 0" }}>
              <UniversalChart
                mode="line"
                points={Array.from({ length: 30 }, (_, i) => {
                  const day = i + 1;
                  const base = Math.abs(selectedStrategy?.netDebit ?? 250);
                  const noise = Math.sin(i / 3) * (base * 0.2) + Math.cos(i / 5) * (base * 0.1);
                  return { x: day, y: Number(Math.max(1, base + noise).toFixed(2)) };
                })}
                width={700}
                height={220}
                formatX={(d) => `Day ${d}`}
                formatY={(v) => `$${v}`}
                ariaLabel="Historical Strategy Price Chart"
              />
            </div>

            <p className="strat-history-note">
              Note: Historical price reflects the contract unit price over time, not realized portfolio profit or loss.
            </p>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL 4: SAVE TRADE DIALOG (CAPABILITY 10)
          ==================================================================== */}
      {showSaveModal && (
        <div className="strat-modal-backdrop" onClick={() => setShowSaveModal(false)}>
          <div className="strat-save-modal" onClick={(e) => e.stopPropagation()}>
            <div className="strat-modal-header">
              <h3>Save Trade Strategy</h3>
              <button type="button" className="strat-modal-close-btn" onClick={() => setShowSaveModal(false)}>
                ✕
              </button>
            </div>

            <div className="strat-save-form">
              <label>Strategy / Trade Name:</label>
              <input
                type="text"
                value={saveTradeName}
                onChange={(e) => setSaveTradeName(e.target.value)}
                placeholder="e.g. TSLA Bull Call Spread Earnings"
                autoFocus
              />

              <label>Trading Notes & Rationale (Optional):</label>
              <textarea
                value={saveTradeNotes}
                onChange={(e) => setSaveTradeNotes(e.target.value)}
                placeholder="Targeting $450 breakout after delivery report. Max loss defined at $250."
                rows={3}
              />

              <div className="strat-save-actions">
                <button
                  type="button"
                  className="strat-save-submit-btn"
                  onClick={handleSaveTrade}
                >
                  Save to My Trades 💾
                </button>
                <button
                  type="button"
                  className="strat-save-cancel-btn"
                  onClick={() => setShowSaveModal(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          MODAL 5: SAVED TRADES DRAWER (CAPABILITY 11)
          ==================================================================== */}
      {showSavedTradesModal && (
        <div className="strat-modal-backdrop" onClick={() => setShowSavedTradesModal(false)}>
          <div className="strat-saved-trades-modal" onClick={(e) => e.stopPropagation()}>
            <div className="strat-modal-header">
              <div>
                <h3>My Saved Trades ({savedTrades.length})</h3>
                <span className="strat-modal-sub">Track profit/loss and reopen saved positions</span>
              </div>
              <button type="button" className="strat-modal-close-btn" onClick={() => setShowSavedTradesModal(false)}>
                ✕
              </button>
            </div>

            <div className="strat-saved-trades-list">
              {savedTrades.length === 0 ? (
                <div className="strat-no-saved-trades">
                  <span>No saved trades yet. Use the "Save" button to store a trade!</span>
                </div>
              ) : (
                savedTrades.map((t) => (
                  <div key={t.id} className="strat-saved-trade-card">
                    <div className="strat-saved-trade-header">
                      <div>
                        <span className="strat-saved-name">{t.name}</span>
                        <span className="strat-saved-meta">
                          {t.symbol} · {t.expirationDate} ({t.dte}d) · Saved {t.createdAt}
                        </span>
                      </div>
                      <div className="strat-saved-card-btns">
                        <button
                          type="button"
                          className="strat-saved-load-btn"
                          onClick={() => handleLoadSavedTrade(t)}
                        >
                          Load Trade ↗
                        </button>
                        <button
                          type="button"
                          className="strat-saved-del-btn"
                          onClick={() => handleDeleteSavedTrade(t.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {t.notes && <p className="strat-saved-notes">"{t.notes}"</p>}

                    <div className="strat-saved-legs-chips">
                      {t.legs.map((l) => (
                        <span key={l.id} className="strat-saved-leg-chip">
                          {l.side} {l.quantity}x {l.strike}{l.optionType[0]}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* ====================================================================
          DRAWER: POSITIONS DRAWER (CAPABILITY 11)
          ==================================================================== */}
      {showPositionsDrawer && (
        <div className="strat-positions-drawer">
          <div className="strat-drawer-header">
            <h4>Positions & Leg Status</h4>
            <button type="button" className="strat-drawer-close" onClick={() => setShowPositionsDrawer(false)}>
              ✕
            </button>
          </div>

          <div className="strat-drawer-content">
            <div className="strat-drawer-section">
              <h5>Open Legs ({builderLegs.filter((l) => !l.isClosed).length})</h5>
              {builderLegs.filter((l) => !l.isClosed).map((l) => (
                <div key={l.id} className="strat-pos-item open">
                  <span>{l.side} {l.quantity}x {l.strike}{l.optionType[0]}</span>
                  <span>Cost: ${(l.customCostBasis ?? l.entryPrice).toFixed(2)}</span>
                  <button type="button" onClick={() => handleCloseLeg(l.id)}>Close</button>
                </div>
              ))}
            </div>

            <div className="strat-drawer-section">
              <h5>Closed / Rolled Legs ({builderLegs.filter((l) => l.isClosed).length})</h5>
              {builderLegs.filter((l) => l.isClosed).length === 0 ? (
                <p className="empty-txt">No closed positions</p>
              ) : (
                builderLegs.filter((l) => l.isClosed).map((l) => (
                  <div key={l.id} className="strat-pos-item closed">
                    <span>{l.side} {l.quantity}x {l.strike}{l.optionType[0]}</span>
                    <span className="gain">Closed @ ${(l.closingPrice ?? 0).toFixed(2)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Workers AI LLM Strategy Evaluation & Options Data Export Modal */}
      <LlmStrategyEvalModal
        isOpen={Boolean(evaluatingStrategy)}
        onClose={() => setEvaluatingStrategy(null)}
        strategy={evaluatingStrategy}
        activeEnv={activeEnv}
        userLogin={userLogin}
        onPreviewTrade={onPreviewTrade}
      />
    </div>
  );
}
