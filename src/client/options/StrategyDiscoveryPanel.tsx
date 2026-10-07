import React, { useEffect, useMemo, useState } from "react";
import {
  discoverStrategies,
  generateExpirations,
  generateStrikeLadder,
  evaluateStrategyPnL,
  getOptimizationFactors,
  updateLegStrike,
  updateLegsExpiration,
  analyzeStrategy,
  type DiscoveredStrategy,
  type ExpirationOption,
  type SentimentType,
  type StrategyLegItem,
} from "./strategyDiscoveryEngine";
import { UniversalChart } from "../components/UniversalChart";
import type { OptionsTradeContext } from "../OptionsResearchPanel";
import "./strategyDiscovery.css";

interface StrategyDiscoveryPanelProps {
  initialSymbol?: string;
  activeEnv?: "TEST" | "PROD";
  userLogin?: string;
  onPreviewTrade?: (ctx: OptionsTradeContext) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

interface StockQuoteState {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  companyName: string;
  delayed: boolean;
}

// Well-known defaults for instant zero-latency experience
const DEFAULT_QUOTES: Record<string, StockQuoteState> = {
  TSLA: { symbol: "TSLA", price: 380.68, change: 1.95, changePercent: 0.51, companyName: "Tesla, Inc.", delayed: true },
  NVDA: { symbol: "NVDA", price: 233.95, change: 0.0, changePercent: 0.0, companyName: "NVIDIA Corporation", delayed: true },
  AAPL: { symbol: "AAPL", price: 232.50, change: 1.25, changePercent: 0.54, companyName: "Apple Inc.", delayed: true },
  SPY: { symbol: "SPY", price: 586.20, change: 2.10, changePercent: 0.36, companyName: "SPDR S&P 500 ETF Trust", delayed: true },
  MSFT: { symbol: "MSFT", price: 428.15, change: -0.85, changePercent: -0.20, companyName: "Microsoft Corporation", delayed: true },
  AMD: { symbol: "AMD", price: 172.40, change: 3.10, changePercent: 1.83, companyName: "Advanced Micro Devices", delayed: true },
};

export function StrategyDiscoveryPanel({
  initialSymbol = "TSLA",
  activeEnv = "TEST",
  userLogin,
  onPreviewTrade,
  onSendPrompt,
}: StrategyDiscoveryPanelProps) {
  // Navigation View: "discovery" (Image 2) or "builder" (Image 1)
  const [activeView, setActiveView] = useState<"discovery" | "builder">("discovery");

  // Core ticker state
  const [symbolInput, setSymbolInput] = useState(initialSymbol);
  const [activeSymbol, setActiveSymbol] = useState(initialSymbol.toUpperCase());
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

  // Optimization Slider (0 = Max Return, 100 = Max Chance)
  const [optimizationBias, setOptimizationBias] = useState<number>(50);

  // Builder View State (Image 1)
  const [selectedStrategy, setSelectedStrategy] = useState<DiscoveredStrategy | null>(null);
  const [builderLegs, setBuilderLegs] = useState<StrategyLegItem[]>([]);
  const [builderIv, setBuilderIv] = useState<number>(44.2);
  const [builderRangePct, setBuilderRangePct] = useState<number>(1.7);
  const [builderZoomLevel, setBuilderZoomLevel] = useState<"x1" | "x2" | "x3">("x1");
  // Date Slider: 0 = Today, 100 = At Expiration
  const [builderDateSliderPct, setBuilderDateSliderPct] = useState<number>(100);
  const [builderDisplayMode, setBuilderDisplayMode] = useState<"graph" | "table">("graph");
  const [builderMetricMode, setBuilderMetricMode] = useState<"pnl_dollar" | "pnl_pct" | "contract_val" | "collateral_pct">("pnl_dollar");
  const [showPositionsDrawer, setShowPositionsDrawer] = useState<boolean>(false);
  const [graphHoverPrice, setGraphHoverPrice] = useState<number | null>(null);

  // Fetch live or FOSS quote when symbol changes
  useEffect(() => {
    let isCurrent = true;
    const fetchQuote = async () => {
      try {
        const resp = await fetch(`/api/foss/quote?symbol=${encodeURIComponent(activeSymbol)}`);
        if (resp.ok) {
          const data = (await resp.json()) as any;
          if (isCurrent && data && data.lastPrice) {
            setQuote({
              symbol: activeSymbol,
              price: Number(data.lastPrice || data.price),
              change: Number(data.change || 0),
              changePercent: Number(data.changePercent || 0),
              companyName: data.companyName || activeSymbol,
              delayed: true,
            });
            return;
          }
        }
      } catch {
        // Fallback to defaults
      }
      if (isCurrent && DEFAULT_QUOTES[activeSymbol]) {
        setQuote(DEFAULT_QUOTES[activeSymbol]);
      }
    };
    void fetchQuote();
    return () => {
      isCurrent = false;
    };
  }, [activeSymbol]);

  // Adjust target price default when sentiment or quote price changes
  const handleSentimentChange = (nextSentiment: SentimentType) => {
    setSentiment(nextSentiment);
    const p = quote.price;
    let factor = 1.15;
    if (nextSentiment === "very_bullish") factor = 1.43;
    else if (nextSentiment === "bullish") factor = 1.15;
    else if (nextSentiment === "neutral") factor = 1.0;
    else if (nextSentiment === "directional") factor = 1.15;
    else if (nextSentiment === "bearish") factor = 0.85;
    else if (nextSentiment === "very_bearish") factor = 0.65;
    setTargetPrice(Number((p * factor).toFixed(2)));
  };

  const handleSymbolSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = symbolInput.trim().toUpperCase();
    if (clean && clean !== activeSymbol) {
      setActiveSymbol(clean);
      const fallback = DEFAULT_QUOTES[clean] || {
        symbol: clean,
        price: 150.0,
        change: 0.5,
        changePercent: 0.33,
        companyName: clean,
        delayed: true,
      };
      setQuote(fallback);
      setTargetPrice(Number((fallback.price * 1.25).toFixed(2)));
    }
  };

  // Generate strategy candidates based on criteria
  const discoveredStrategies = useMemo(() => {
    return discoverStrategies({
      symbol: activeSymbol,
      currentPrice: quote.price,
      sentiment,
      targetPrice,
      budget,
      expiration: selectedExpiration,
      optimizationBias,
      baseIv: builderIv / 100,
    });
  }, [activeSymbol, quote.price, sentiment, targetPrice, budget, selectedExpiration, optimizationBias, builderIv]);

  // When discovering strategies, initialize selectedStrategy with the first match if empty
  useEffect(() => {
    if (discoveredStrategies.length > 0 && (!selectedStrategy || activeView === "discovery")) {
      const top = discoveredStrategies[0];
      setSelectedStrategy(top);
      setBuilderLegs([...top.legs]);
    }
  }, [discoveredStrategies, activeView]);

  // Transition from Discovery card to Builder view
  const openInBuilder = (strat: DiscoveredStrategy) => {
    setSelectedStrategy(strat);
    setBuilderLegs([...strat.legs]);
    setActiveView("builder");
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
  // BUILDER VIEW CALCULATIONS & INTERACTIVE STRIKE / DATE CONTROLS
  // =========================================================================
  const spot = quote.price;
  const currentStrategyName = selectedStrategy?.name || "Options Strategy";

  // Effective DTE and time remaining for the Date slider
  // Date Slider: 0 = Today (max DTE), 100 = Expiration (0 DTE)
  const maxDte = selectedExpiration.dte;
  const tRemainingDays = maxDte * (1 - builderDateSliderPct / 100);
  const tRemainingYears = Math.max(0, tRemainingDays) / 365;

  // Zoom / Range %
  const effectiveRangePct = useMemo(() => {
    if (builderZoomLevel === "x1") return builderRangePct;
    if (builderZoomLevel === "x2") return builderRangePct * 2.5;
    return builderRangePct * 5;
  }, [builderRangePct, builderZoomLevel]);

  const priceLow = Math.max(0.1, spot * (1 - effectiveRangePct / 100));
  const priceHigh = spot * (1 + effectiveRangePct / 100);

  // Full Payoff points across the range for the full Builder graph
  const builderGraphPoints = useMemo(() => {
    const steps = 60;
    const stepSize = (priceHigh - priceLow) / (steps - 1);
    const points: Array<{ price: number; pnlEvaluated: number; pnlExpiry: number }> = [];

    for (let i = 0; i < steps; i++) {
      const p = priceLow + i * stepSize;
      const pnlEvaluated = evaluateStrategyPnL(builderLegs, p, tRemainingYears, builderIv / 100);
      const pnlExpiry = evaluateStrategyPnL(builderLegs, p, 0, builderIv / 100);
      points.push({
        price: Number(p.toFixed(2)),
        pnlEvaluated: Number(pnlEvaluated.toFixed(2)),
        pnlExpiry: Number(pnlExpiry.toFixed(2)),
      });
    }
    return points;
  }, [builderLegs, priceLow, priceHigh, tRemainingYears, builderIv]);

  // Strike ladder for ruler and sliders
  const strikeLadder = useMemo(() => generateStrikeLadder(spot), [spot]);
  const minStrike = strikeLadder[0] || spot * 0.5;
  const maxStrike = strikeLadder[strikeLadder.length - 1] || spot * 1.5;
  const strikeStep = strikeLadder.length > 1 ? Number((strikeLadder[1] - strikeLadder[0]).toFixed(2)) : 1;

  // Visible ruler strikes centered around spot
  const rulerStrikes = useMemo(() => {
    const centerIdx = strikeLadder.findIndex((k) => Math.abs(k - spot) < strikeStep * 1.5);
    const startIdx = Math.max(0, (centerIdx >= 0 ? centerIdx : 15) - 12);
    return strikeLadder.slice(startIdx, startIdx + 25);
  }, [strikeLadder, spot, strikeStep]);

  // Handle changing an option leg strike slider or steppers
  const handleStrikeChange = (legId: string, newStrike: number) => {
    const updatedLegs = builderLegs.map((l) => {
      if (l.id === legId) {
        return updateLegStrike(l, newStrike, spot, selectedExpiration.dte, builderIv / 100);
      }
      return l;
    });
    setBuilderLegs(updatedLegs);

    if (selectedStrategy) {
      const reanalyzed = analyzeStrategy(
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
        optimizationBias
      );
      setSelectedStrategy(reanalyzed);
    }
  };

  // Step strike up or down by 1 notch
  const handleStrikeStep = (legId: string, stepDirection: number) => {
    const leg = builderLegs.find((l) => l.id === legId);
    if (!leg) return;
    const currIdx = strikeLadder.findIndex((k) => Math.abs(k - leg.strike) < strikeStep * 0.5);
    const nextIdx = Math.max(0, Math.min(strikeLadder.length - 1, (currIdx >= 0 ? currIdx : 0) + stepDirection));
    handleStrikeChange(legId, strikeLadder[nextIdx]);
  };

  // Handle selecting different expiration in builder (re-prices legs with Black-Scholes)
  const handleBuilderExpirationChange = (exp: ExpirationOption) => {
    setSelectedExpiration(exp);
    if (builderLegs.length > 0) {
      const updatedLegs = updateLegsExpiration(builderLegs, exp.dte, exp.date, spot, builderIv / 100);
      setBuilderLegs(updatedLegs);

      if (selectedStrategy) {
        const reanalyzed = analyzeStrategy(
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
          optimizationBias
        );
        setSelectedStrategy(reanalyzed);
      }
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

  return (
    <div className="strat-discovery-container">
      {/* Top View Mode Switcher */}
      <div className="strat-view-tabs">
        <div className="strat-view-tab-buttons">
          <button
            type="button"
            className={`strat-view-tab-btn ${activeView === "discovery" ? "active" : ""}`}
            onClick={() => setActiveView("discovery")}
          >
            🔍 Discovery Mode
          </button>
          <button
            type="button"
            className={`strat-view-tab-btn ${activeView === "builder" ? "active" : ""}`}
            onClick={() => setActiveView("builder")}
          >
            📊 Builder / Payoff Analyzer
          </button>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          {activeView === "builder" && (
            <button
              type="button"
              className="strat-view-tab-btn"
              onClick={() => setActiveView("discovery")}
              style={{ color: "#38bdf8" }}
            >
              ← Back to Discovery Grid
            </button>
          )}
          <span style={{ fontSize: "0.78rem", color: "#64748b" }}>
            Real-time Black-Scholes Engine · {activeEnv}
          </span>
        </div>
      </div>

      {/* ====================================================================
          VIEW 1: STRATEGY DISCOVERY MODE (IMAGE 2)
          ==================================================================== */}
      {activeView === "discovery" && (
        <div className="strat-discovery-view">
          {/* Header Bar */}
          <div className="strat-discovery-header">
            <form onSubmit={handleSymbolSubmit} className="strat-symbol-bar">
              <div className="strat-symbol-input-wrap">
                <label>Symbol:</label>
                <input
                  type="text"
                  value={symbolInput}
                  onChange={(e) => setSymbolInput(e.target.value)}
                  placeholder="TSLA"
                />
              </div>

              <div className="strat-price-badge">
                ${quote.price.toFixed(2)}
                <span className={`strat-change-pill ${quote.change >= 0 ? "gain" : "loss"}`}>
                  {quote.change >= 0 ? "+" : ""}
                  {quote.changePercent.toFixed(2)}% (+${quote.change.toFixed(2)})
                </span>
                <span className="strat-delayed-tag">↻ Delayed</span>
              </div>
            </form>

            {/* 6 Circular Sentiment Selectors */}
            <div className="strat-sentiment-grid">
              {(
                [
                  { id: "very_bearish", label: "Very Bearish", icon: "↘↘", color: "#dc2626" },
                  { id: "bearish", label: "Bearish", icon: "↘", color: "#ef4444" },
                  { id: "neutral", label: "Neutral", icon: "➔", color: "#94a3b8" },
                  { id: "directional", label: "Directional", icon: "🔀", color: "#a855f7" },
                  { id: "bullish", label: "Bullish", icon: "↗", color: "#22c55e" },
                  { id: "very_bullish", label: "Very Bullish", icon: "↗↗", color: "#16a34a" },
                ] as const
              ).map((item) => (
                <div
                  key={item.id}
                  className={`strat-sentiment-btn-wrap ${item.id} ${sentiment === item.id ? "active" : ""}`}
                  onClick={() => handleSentimentChange(item.id)}
                >
                  <div className="strat-sentiment-circle" title={item.label}>
                    {item.id === "very_bearish" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="7" y1="7" x2="17" y2="17" />
                        <polyline points="17 7 17 17 7 17" />
                      </svg>
                    )}
                    {item.id === "bearish" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
                        <polyline points="17 18 23 18 23 12" />
                      </svg>
                    )}
                    {item.id === "neutral" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" />
                        <polyline points="12 5 19 12 12 19" />
                      </svg>
                    )}
                    {item.id === "directional" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="18" cy="5" r="3" />
                        <circle cx="6" cy="12" r="3" />
                        <circle cx="18" cy="19" r="3" />
                        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                      </svg>
                    )}
                    {item.id === "bullish" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                        <polyline points="17 6 23 6 23 12" />
                      </svg>
                    )}
                    {item.id === "very_bullish" && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="7" y1="17" x2="17" y2="7" />
                        <polyline points="7 7 17 7 17 17" />
                      </svg>
                    )}
                  </div>
                  <span className="strat-sentiment-label">{item.label}</span>
                </div>
              ))}
            </div>

            {/* Target Price & Budget Bar */}
            <div className="strat-target-bar">
              <div className="strat-input-pill">
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
            </div>

            {/* Expiration Timeline Chips */}
            <div className="strat-timeline-row">
              {expirations.map((exp) => (
                <button
                  key={exp.date}
                  type="button"
                  className={`strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                  onClick={() => setSelectedExpiration(exp)}
                >
                  <span className="strat-chip-month">{exp.monthGroup}</span>
                  <span className="strat-chip-day">{exp.dayLabel}</span>
                </button>
              ))}
            </div>

            {/* Optimization Slider (Max Return vs Max Chance) */}
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
                <div className="strat-factor-card">
                  <div className="strat-factor-header">
                    <span className="strat-factor-title">Target Return & Leverage</span>
                    <span className="strat-factor-weight">{optFactors.returnWeight}% wt</span>
                  </div>
                  <div className="strat-factor-bar-bg">
                    <div className="strat-factor-bar-fill return" style={{ width: `${optFactors.returnWeight}%` }} />
                  </div>
                  <span className="strat-factor-hint">Maximizes RoR% multiple & upside leverage at target price</span>
                </div>

                <div className="strat-factor-card">
                  <div className="strat-factor-header">
                    <span className="strat-factor-title">Win Probability (POP)</span>
                    <span className="strat-factor-weight">{optFactors.chanceWeight}% wt</span>
                  </div>
                  <div className="strat-factor-bar-bg">
                    <div className="strat-factor-bar-fill chance" style={{ width: `${optFactors.chanceWeight}%` }} />
                  </div>
                  <span className="strat-factor-hint">Maximizes probability that trade finishes profitable</span>
                </div>

                <div className="strat-factor-card">
                  <div className="strat-factor-header">
                    <span className="strat-factor-title">Breakeven Buffer</span>
                    <span className="strat-factor-weight">{optFactors.safetyWeight}% wt</span>
                  </div>
                  <div className="strat-factor-bar-bg">
                    <div className="strat-factor-bar-fill safety" style={{ width: `${optFactors.safetyWeight * 3.5}%` }} />
                  </div>
                  <span className="strat-factor-hint">Distance between current spot and nearest breakeven</span>
                </div>

                <div className="strat-factor-card">
                  <div className="strat-factor-header">
                    <span className="strat-factor-title">Capital Efficiency</span>
                    <span className="strat-factor-weight">{optFactors.capitalWeight}% wt</span>
                  </div>
                  <div className="strat-factor-bar-bg">
                    <div className="strat-factor-bar-fill capital" style={{ width: `${optFactors.capitalWeight * 4.5}%` }} />
                  </div>
                  <span className="strat-factor-hint">Required collateral relative to maximum dollar potential</span>
                </div>
              </div>
            </div>
          </div>

          {/* 3-Column Responsive Strategy Cards Grid */}
          <div className="strat-cards-grid">
            {discoveredStrategies.map((strat) => {
              const returnLabel =
                strat.returnOnRiskPct !== null
                  ? `${strat.returnOnRiskPct}% Return on risk`
                  : `${strat.returnOnCollateralPct}% Return on collateral`;

              return (
                <div key={strat.id} className="strat-discovery-card">
                  <div className="strat-card-title-row">
                    <span className="strat-card-name">{strat.name}</span>
                    <span className="strat-card-subtitle">{strat.subtitle}</span>
                  </div>

                  <div className="strat-card-stats-row">
                    <div className="strat-card-stat-left">
                      <span className="strat-stat-return">{returnLabel}</span>
                      <span className="strat-stat-profit">
                        ${strat.targetProfit.toLocaleString()} Profit
                      </span>
                    </div>

                    <div className="strat-card-stat-right">
                      <span className="strat-stat-chance">{strat.chanceOfProfit}% Chance 🔒</span>
                      <span className="strat-stat-risk">
                        ${strat.riskOrCollateral.toLocaleString()}{" "}
                        {strat.returnOnRiskPct !== null ? "Risk" : "Collateral"}
                      </span>
                    </div>
                  </div>

                  {/* Factor Evaluation Badges */}
                  {strat.factors && (
                    <div className="strat-card-factors-row">
                      <span className="strat-factor-pill pop">
                        🎯 {strat.chanceOfProfit}% POP
                      </span>
                      <span className="strat-factor-pill return">
                        📈 {strat.returnOnRiskPct !== null ? `+${strat.returnOnRiskPct}% RoR` : `+${strat.returnOnCollateralPct}% RoC`}
                      </span>
                      <span className="strat-factor-pill safety">
                        🛡️ {strat.factors.cushionPct}% Buffer
                      </span>
                      <span className="strat-factor-pill score">
                        ⭐ {strat.factors.compositeScore}/100 Match
                      </span>
                    </div>
                  )}

                  {/* Single Unified Chart Capability: Mini Payoff Sparkline */}
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

                  <button
                    type="button"
                    className="strat-card-btn-builder"
                    onClick={() => openInBuilder(strat)}
                  >
                    Open in Builder
                  </button>
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
          {/* Header Bar */}
          <div className="strat-builder-header-bar">
            <div className="strat-builder-title-group">
              <h2>{currentStrategyName}</h2>
              <span title={selectedStrategy?.description} style={{ cursor: "pointer", color: "#94a3b8" }}>
                ⓘ
              </span>
            </div>

            <div className="strat-builder-action-btns">
              <button
                type="button"
                className="strat-btn-action"
                onClick={() => setShowPositionsDrawer(!showPositionsDrawer)}
              >
                Positions ({builderLegs.length}) ☰
              </button>
              <button type="button" className="strat-btn-action" onClick={sendToFastOrder}>
                Save / Order Ticket ⚡
              </button>
              <button
                type="button"
                className="strat-btn-action"
                onClick={() => onSendPrompt && onSendPrompt(`Analyze option strategy ${currentStrategyName} on ${activeSymbol}`)}
              >
                Historical Chart ↻
              </button>
            </div>
          </div>

          {/* Subheader: Symbol Quote Bar & Expiration indicator */}
          <div className="strat-symbol-quote-bar">
            <span className="strat-symbol-pill">{activeSymbol}</span>
            <span className="strat-quote-price">${quote.price.toFixed(2)}</span>
            <span className={`strat-quote-change ${quote.change >= 0 ? "gain" : "loss"}`}>
              {quote.change >= 0 ? "+" : ""}
              {quote.changePercent.toFixed(2)}% (+${quote.change.toFixed(2)})
            </span>
            <span className="strat-delayed-tag">↻ Delayed ⓘ</span>
          </div>

          {/* Expiration Timeline Chips in Builder (Image 1) */}
          <div className="strat-builder-exp-bar">
            <div className="strat-builder-exp-title">EXPIRATION: {selectedExpiration.label} ({selectedExpiration.dte}d)</div>
            <div className="strat-exp-chips-scroll">
              {expirations.map((exp) => (
                <button
                  key={exp.date}
                  type="button"
                  className={`strat-exp-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                  onClick={() => handleBuilderExpirationChange(exp)}
                >
                  <span className="strat-chip-month">{exp.monthGroup}</span>
                  <span className="strat-chip-day">{exp.dayLabel}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Strike Ruler with Call/Put Badges (Image 1) */}
          <div className="strat-strike-ruler-wrap">
            <div className="strat-strike-ruler-title">STRIKE RULER:</div>
            <div className="strat-strike-ruler">
              <div className="strat-ruler-ticks">
                {rulerStrikes.map((k) => {
                  const callLeg = builderLegs.find((l) => l.strike === k && l.optionType === "CALL");
                  const putLeg = builderLegs.find((l) => l.strike === k && l.optionType === "PUT");

                  return (
                    <div
                      key={k}
                      className={`strat-ruler-tick ${Math.abs(k - spot) < strikeStep * 0.5 ? "highlight" : ""}`}
                      onClick={() => {
                        const firstLeg = builderLegs.find((l) => l.optionType !== "STOCK");
                        if (firstLeg) handleStrikeChange(firstLeg.id, k);
                      }}
                      title={`Strike $${k} (Click to set primary leg strike)`}
                      style={{ cursor: "pointer" }}
                    >
                      <div className="strat-ruler-tick-bar" />
                      <span>{k}</span>
                      {callLeg && (
                        <div className="strat-ruler-badge call" title={`Call Strike: $${k}`}>
                          {k}C
                        </div>
                      )}
                      {putLeg && (
                        <div className="strat-ruler-badge put" title={`Put Strike: $${k}`}>
                          {k}P
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Interactive Moveable Strike Price Sliders for Each Leg */}
          {builderLegs.filter((l) => l.optionType !== "STOCK").length > 0 && (
            <div className="strat-leg-strike-sliders-wrap">
              <div className="strat-leg-strike-sliders-title">
                <span>Interactive Strike Controls</span>
                <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                  Slide or click [-]/[+] to recompute payoff and Greeks in real-time
                </span>
              </div>
              {builderLegs
                .filter((l) => l.optionType !== "STOCK")
                .map((leg) => (
                  <div key={leg.id} className="strat-leg-strike-slider-card">
                    <div className="strat-leg-strike-header">
                      <span className={`strat-leg-pill ${leg.optionType.toLowerCase()} ${leg.side.toLowerCase()}`}>
                        {leg.side} {leg.quantity}x {leg.optionType}
                      </span>
                      <span className="strat-leg-strike-display">${leg.strike.toFixed(2)}</span>
                      <span className="strat-leg-delta">Δ {(leg.delta * (leg.side === "BUY" ? 1 : -1)).toFixed(2)}</span>
                    </div>

                    <div className="strat-leg-slider-controls">
                      <button
                        type="button"
                        className="strat-strike-step-btn"
                        onClick={() => handleStrikeStep(leg.id, -1)}
                        title="Step strike down"
                      >
                        ◀ -
                      </button>
                      <input
                        type="range"
                        min={minStrike}
                        max={maxStrike}
                        step={strikeStep}
                        value={leg.strike}
                        onChange={(e) => handleStrikeChange(leg.id, Number(e.target.value))}
                        className="strat-leg-strike-range"
                      />
                      <button
                        type="button"
                        className="strat-strike-step-btn"
                        onClick={() => handleStrikeStep(leg.id, 1)}
                        title="Step strike up"
                      >
                        + ▶
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}

          {/* Key Metrics Strip (Image 1) */}
          <div className="strat-metrics-strip">
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
              <span className="strat-metric-val">
                {selectedStrategy?.chanceOfProfit ?? 50}% 🔒
              </span>
            </div>

            <div className="strat-metric-cell">
              <span className="strat-metric-label">→ BREAKEVEN:</span>
              <span className="strat-metric-val" style={{ fontSize: "0.85rem" }}>
                {selectedStrategy?.breakevenText || `Below $${spot.toFixed(2)} (+0%)`}
              </span>
            </div>
          </div>

          {/* Single Unified Chart Capability: Full Payoff Chart OR Table Matrix */}
          {builderDisplayMode === "graph" ? (
            <div className="strat-full-graph-wrap">
              <UniversalChart
                mode="payoff"
                points={builderGraphPoints.map((pt) => ({ x: pt.price, y: pt.pnlEvaluated }))}
                secondaryPoints={
                  tRemainingDays > 0
                    ? builderGraphPoints.map((pt) => ({ x: pt.price, y: pt.pnlExpiry }))
                    : undefined
                }
                spotPrice={spot}
                targetPrice={targetPrice}
                breakevens={selectedStrategy?.breakevens || []}
                hoverX={graphHoverPrice}
                onHoverXChange={setGraphHoverPrice}
                width={850}
                height={340}
                ariaLabel={`${currentStrategyName} interactive payoff chart`}
              />
            </div>
          ) : (
            /* Data Matrix Table Mode */
            <div className="strat-table-view-wrap">
              <table className="strat-matrix-table">
                <thead>
                  <tr>
                    <th>Underlying Price</th>
                    <th>Evaluated P/L ($)</th>
                    <th>Expiration P/L ($)</th>
                    <th>ROI (%)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {builderGraphPoints.map((pt) => {
                    const isAtSpot = Math.abs(pt.price - spot) < strikeStep * 0.5;
                    return (
                      <tr key={pt.price} className={isAtSpot ? "current-price-row" : ""}>
                        <td>
                          ${pt.price.toFixed(2)} {isAtSpot && "(Spot)"}
                        </td>
                        <td style={{ color: pt.pnlEvaluated >= 0 ? "#22c55e" : "#ef4444" }}>
                          {pt.pnlEvaluated >= 0 ? "+" : ""}${pt.pnlEvaluated}
                        </td>
                        <td style={{ color: pt.pnlExpiry >= 0 ? "#38bdf8" : "#f87171" }}>
                          {pt.pnlExpiry >= 0 ? "+" : ""}${pt.pnlExpiry}
                        </td>
                        <td>
                          {selectedStrategy?.riskOrCollateral
                            ? `${((pt.pnlEvaluated / selectedStrategy.riskOrCollateral) * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                        <td>{pt.pnlEvaluated >= 0 ? "PROFIT" : "LOSS"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Controls Below Graph: Date Slider, Range Zoom, IV Slider (Image 1) */}
          <div className="strat-graph-controls-bar">
            {/* Date Slider modeling Time Decay */}
            <div className="strat-date-slider-row">
              <span>
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
              />
              <span>(At expiration)</span>
            </div>

            {/* Subrow: Range Zoom & Implied Volatility */}
            <div className="strat-sliders-subrow">
              <div className="strat-range-group">
                <span>RANGE: ±{effectiveRangePct.toFixed(1)}%</span>
                <div className="strat-zoom-btn-group">
                  <button
                    type="button"
                    className={`strat-zoom-btn ${builderZoomLevel === "x1" ? "active" : ""}`}
                    onClick={() => setBuilderZoomLevel("x1")}
                  >
                    ×1
                  </button>
                  <button
                    type="button"
                    className={`strat-zoom-btn ${builderZoomLevel === "x2" ? "active" : ""}`}
                    onClick={() => setBuilderZoomLevel("x2")}
                  >
                    ×2
                  </button>
                  <button
                    type="button"
                    className={`strat-zoom-btn ${builderZoomLevel === "x3" ? "active" : ""}`}
                    onClick={() => setBuilderZoomLevel("x3")}
                  >
                    ×3
                  </button>
                </div>
              </div>

              <div className="strat-iv-group">
                <span>IMPLIED VOLATILITY: {builderIv.toFixed(1)}%</span>
                <input
                  type="range"
                  min={10}
                  max={150}
                  step={0.5}
                  value={builderIv}
                  onChange={(e) => setBuilderIv(Number(e.target.value))}
                />
              </div>
            </div>
          </div>

          {/* Bottom View & Metric Mode Switchers */}
          <div className="strat-bottom-mode-bar">
            <div className="strat-mode-toggle-group">
              <button
                type="button"
                className={`strat-mode-btn ${builderDisplayMode === "table" ? "active" : ""}`}
                onClick={() => setBuilderDisplayMode("table")}
              >
                ⊞ Table
              </button>
              <button
                type="button"
                className={`strat-mode-btn ${builderDisplayMode === "graph" ? "active" : ""}`}
                onClick={() => setBuilderDisplayMode("graph")}
              >
                📈 Graph
              </button>
            </div>

            <div className="strat-metric-toggle-group">
              {(
                [
                  { id: "pnl_dollar", label: "Profit / Loss $" },
                  { id: "pnl_pct", label: "Profit / Loss %" },
                  { id: "contract_val", label: "Contract Value" },
                  { id: "collateral_pct", label: "% of Collateral" },
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
    </div>
  );
}
