import React, { useEffect, useMemo, useState } from "react";
import {
  discoverStrategies,
  generateExpirations,
  generateStrikeLadder,
  evaluateStrategyPnL,
  type DiscoveredStrategy,
  type ExpirationOption,
  type SentimentType,
  type StrategyLegItem,
} from "./strategyDiscoveryEngine";
import { blackScholes } from "./blackScholes";
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
  const [builderDateSliderPct, setBuilderDateSliderPct] = useState<number>(100); // 0 = now, 100 = expiration
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
    if (discoveredStrategies.length > 0 && !selectedStrategy) {
      setSelectedStrategy(discoveredStrategies[0]);
      setBuilderLegs(discoveredStrategies[0].legs);
    }
  }, [discoveredStrategies, selectedStrategy]);

  // Open any strategy card in the interactive Builder (Image 1)
  const openInBuilder = (strategy: DiscoveredStrategy) => {
    setSelectedStrategy(strategy);
    setBuilderLegs(strategy.legs);
    setActiveView("builder");
  };

  // Target Price Diff %
  const targetPctDiff = useMemo(() => {
    if (!quote.price) return "+0%";
    const diff = ((targetPrice - quote.price) / quote.price) * 100;
    const sign = diff >= 0 ? "+" : "";
    return `(${sign}${diff.toFixed(0)}%)`;
  }, [targetPrice, quote.price]);

  // =========================================================================
  // BUILDER VIEW CALCULATIONS (IMAGE 1)
  // =========================================================================
  const spot = quote.price;
  const currentStrategyName = selectedStrategy?.name || "Options Strategy";

  // Effective DTE and time remaining for the Date slider
  const maxDte = selectedExpiration.dte;
  const currentDte = (builderDateSliderPct / 100) * maxDte;
  const tRemainingYears = Math.max(0, currentDte) / 365;

  // Zoom / Range %
  const effectiveRangePct = useMemo(() => {
    if (builderZoomLevel === "x1") return builderRangePct;
    if (builderZoomLevel === "x2") return builderRangePct * 2.5;
    return builderRangePct * 5;
  }, [builderRangePct, builderZoomLevel]);

  const priceLow = Math.max(0.1, spot * (1 - effectiveRangePct / 100));
  const priceHigh = spot * (1 + effectiveRangePct / 100);

  // Payoff points across the range for the full Builder graph
  const builderGraphPoints = useMemo(() => {
    const steps = 60;
    const stepSize = (priceHigh - priceLow) / (steps - 1);
    const points: Array<{ price: number; pnlExpiry: number; pnlIntermediate: number }> = [];

    for (let i = 0; i < steps; i++) {
      const p = priceLow + i * stepSize;
      const pnlExpiry = evaluateStrategyPnL(builderLegs, p, 0, builderIv / 100);
      const pnlIntermediate = evaluateStrategyPnL(builderLegs, p, tRemainingYears, builderIv / 100);
      points.push({
        price: Number(p.toFixed(2)),
        pnlExpiry: Number(pnlExpiry.toFixed(2)),
        pnlIntermediate: Number(pnlIntermediate.toFixed(2)),
      });
    }
    return points;
  }, [builderLegs, priceLow, priceHigh, tRemainingYears, builderIv]);

  // Find min and max PnL for chart Y scaling
  const { yMin, yMax } = useMemo(() => {
    const pnls = builderGraphPoints.map((pt) => pt.pnlExpiry);
    const min = Math.min(...pnls, 0);
    const max = Math.max(...pnls, 0);
    const pad = Math.max(50, (max - min) * 0.15);
    return { yMin: min - pad, yMax: max + pad };
  }, [builderGraphPoints]);

  // Strike ruler data
  const rulerStrikes = useMemo(() => {
    const all = generateStrikeLadder(spot);
    const centerIdx = all.findIndex((k) => Math.abs(k - spot) < 2);
    const startIdx = Math.max(0, centerIdx - 12);
    return all.slice(startIdx, startIdx + 25);
  }, [spot]);

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
        (leg) => `${leg.side} ${leg.quantity} ${leg.optionType === "STOCK" ? "Shares" : leg.strike + leg.optionType[0]} @ $${leg.entryPrice.toFixed(2)}`
      ),
    };
    onPreviewTrade(ctx);
  };

  // Hover cursor calculations
  const hoveredPoint = useMemo(() => {
    const targetPriceVal = graphHoverPrice ?? spot;
    const pnl = evaluateStrategyPnL(builderLegs, targetPriceVal, tRemainingYears, builderIv / 100);
    const diffPct = ((targetPriceVal - spot) / spot) * 100;
    return {
      price: targetPriceVal,
      pnl: Number(pnl.toFixed(2)),
      diffPct: `${diffPct >= 0 ? "+" : ""}${diffPct.toFixed(1)}%`,
    };
  }, [graphHoverPrice, spot, builderLegs, tRemainingYears, builderIv]);

  return (
    <div className="strat-discovery-container" role="region" aria-label="Strategy Discovery and Payoff Analyzer">
      {/* Top View Switcher Bar */}
      <div className="strat-view-tabs">
        <div className="strat-view-tab-buttons">
          <button
            type="button"
            className={`strat-view-tab-btn ${activeView === "discovery" ? "active" : ""}`}
            onClick={() => setActiveView("discovery")}
          >
            🎯 Strategy Discovery
          </button>
          <button
            type="button"
            className={`strat-view-tab-btn ${activeView === "builder" ? "active" : ""}`}
            onClick={() => setActiveView("builder")}
          >
            📈 Strategy Builder &amp; Payoff Analyzer
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {activeView === "builder" && (
            <button
              type="button"
              className="strat-btn-action secondary"
              onClick={() => setActiveView("discovery")}
            >
              ← Back to Discovery
            </button>
          )}
          {onPreviewTrade && (
            <button
              type="button"
              className="strat-btn-action"
              onClick={sendToFastOrder}
              title="Populate Fast Order Ticket with this structure"
            >
              ⚡ Fast Order Ticket
            </button>
          )}
        </div>
      </div>

      {/* ====================================================================
          VIEW 1: STRATEGY DISCOVERY (IMAGE 2)
          ==================================================================== */}
      {activeView === "discovery" && (
        <div className="strat-discovery-header">
          {/* Header Symbol & Price Bar */}
          <div className="strat-symbol-bar">
            <form onSubmit={handleSymbolSubmit} className="strat-symbol-input-wrap">
              <label htmlFor="strat-sym-input">Symbol:</label>
              <input
                id="strat-sym-input"
                type="text"
                value={symbolInput}
                onChange={(e) => setSymbolInput(e.target.value)}
                maxLength={6}
              />
            </form>
            <span className="strat-price-display">${quote.price.toFixed(2)}</span>
            <span className={`strat-change-pill ${quote.change >= 0 ? "positive" : "negative"}`}>
              {quote.change >= 0 ? "+" : ""}
              {quote.changePercent.toFixed(2)}% ({quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)})
            </span>
            <span className="strat-delayed-badge" title="Market quotes feed">
              ↻ Delayed 🛈
            </span>
          </div>

          {/* Sentiment Selector Group (6 Circular Buttons) */}
          <div className="strat-sentiment-group" role="radiogroup" aria-label="Market sentiment">
            {/* Very Bearish */}
            <div
              className={`strat-sentiment-btn-wrap very_bearish ${sentiment === "very_bearish" ? "active" : ""}`}
              onClick={() => handleSentimentChange("very_bearish")}
              role="radio"
              aria-checked={sentiment === "very_bearish"}
            >
              <div className="strat-sentiment-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 5l-7 7-7-7" />
                  <path d="M19 12l-7 7-7-7" />
                </svg>
              </div>
              <span className="strat-sentiment-label">Very Bearish</span>
            </div>

            {/* Bearish */}
            <div
              className={`strat-sentiment-btn-wrap bearish ${sentiment === "bearish" ? "active" : ""}`}
              onClick={() => handleSentimentChange("bearish")}
              role="radio"
              aria-checked={sentiment === "bearish"}
            >
              <div className="strat-sentiment-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="7" y1="7" x2="17" y2="17" />
                  <polyline points="17 7 17 17 7 17" />
                </svg>
              </div>
              <span className="strat-sentiment-label">Bearish</span>
            </div>

            {/* Neutral */}
            <div
              className={`strat-sentiment-btn-wrap neutral ${sentiment === "neutral" ? "active" : ""}`}
              onClick={() => handleSentimentChange("neutral")}
              role="radio"
              aria-checked={sentiment === "neutral"}
            >
              <div className="strat-sentiment-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </div>
              <span className="strat-sentiment-label">Neutral</span>
            </div>

            {/* Directional (High Volatility) */}
            <div
              className={`strat-sentiment-btn-wrap directional ${sentiment === "directional" ? "active" : ""}`}
              onClick={() => handleSentimentChange("directional")}
              role="radio"
              aria-checked={sentiment === "directional"}
            >
              <div className="strat-sentiment-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 3 21 3 21 8" />
                  <line x1="4" y1="20" x2="21" y2="3" />
                  <polyline points="21 16 21 21 16 21" />
                  <line x1="15" y1="15" x2="21" y2="21" />
                  <line x1="4" y1="4" x2="9" y2="9" />
                </svg>
              </div>
              <span className="strat-sentiment-label">Directional</span>
            </div>

            {/* Bullish */}
            <div
              className={`strat-sentiment-btn-wrap bullish ${sentiment === "bullish" ? "active" : ""}`}
              onClick={() => handleSentimentChange("bullish")}
              role="radio"
              aria-checked={sentiment === "bullish"}
            >
              <div className="strat-sentiment-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="7" y1="17" x2="17" y2="7" />
                  <polyline points="7 7 17 7 17 17" />
                </svg>
              </div>
              <span className="strat-sentiment-label">Bullish</span>
            </div>

            {/* Very Bullish */}
            <div
              className={`strat-sentiment-btn-wrap very_bullish ${sentiment === "very_bullish" ? "active" : ""}`}
              onClick={() => handleSentimentChange("very_bullish")}
              role="radio"
              aria-checked={sentiment === "very_bullish"}
            >
              <div className="strat-sentiment-circle">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 19l7-7 7 7" />
                  <path d="M5 12l7-7 7 7" />
                </svg>
              </div>
              <span className="strat-sentiment-label">Very Bullish</span>
            </div>
          </div>

          {/* Target Price and Budget Controls Bar */}
          <div className="strat-target-bar">
            <div className="strat-input-pill">
              <label htmlFor="strat-target-price">Target Price: $</label>
              <input
                id="strat-target-price"
                type="number"
                step="0.01"
                value={targetPrice}
                onChange={(e) => setTargetPrice(Number(e.target.value))}
              />
              <span className="strat-target-pct">{targetPctDiff}</span>
            </div>

            <div className="strat-input-pill">
              <label htmlFor="strat-budget">Budget: $</label>
              <input
                id="strat-budget"
                type="text"
                placeholder="None"
                value={budget === null ? "" : budget}
                onChange={(e) => {
                  const val = e.target.value.trim();
                  setBudget(val === "" ? null : Number(val));
                }}
              />
            </div>
          </div>

          {/* Expiration Timeline Chips Strip */}
          <div className="strat-timeline-strip" role="tablist" aria-label="Expiration timeline">
            {expirations.map((exp) => (
              <button
                key={exp.date}
                type="button"
                className={`strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                onClick={() => setSelectedExpiration(exp)}
              >
                <span>{exp.label}</span>
              </button>
            ))}
          </div>

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

          {/* Strategy Cards Grid (3 Columns) */}
          <div className="strat-cards-grid">
            {discoveredStrategies.map((strat) => {
              const miniPoints = strat.miniPayoffPoints;
              const w = 320;
              const h = 110;
              const padX = 20;
              const padY = 12;

              const prices = miniPoints.map((p) => p.price);
              const pMin = Math.min(...prices);
              const pMax = Math.max(...prices);

              const pnls = miniPoints.map((p) => p.pnl);
              const pnlMin = Math.min(...pnls, 0);
              const pnlMax = Math.max(...pnls, 0);
              const pnlSpan = pnlMax - pnlMin || 1;

              const toX = (p: number) => padX + ((p - pMin) / (pMax - pMin)) * (w - padX * 2);
              const toY = (val: number) => h - padY - ((val - pnlMin) / pnlSpan) * (h - padY * 2);
              const zeroY = toY(0);

              const lineD = miniPoints
                .map((pt, i) => `${i === 0 ? "M" : "L"}${toX(pt.price).toFixed(1)},${toY(pt.pnl).toFixed(1)}`)
                .join(" ");

              const areaD = `${lineD} L${toX(pMax).toFixed(1)},${zeroY.toFixed(1)} L${toX(pMin).toFixed(1)},${zeroY.toFixed(1)} Z`;
              const gradId = `grad_${strat.id}`;

              return (
                <div key={strat.id} className="strat-card">
                  <div className="strat-card-header">
                    <h3 className="strat-card-title">{strat.name}</h3>
                    <p className="strat-card-subtitle">{strat.subtitle}</p>
                  </div>

                  <div className="strat-card-metrics-row">
                    <div className="strat-card-stat-left">
                      <span className="strat-stat-highlight">
                        {strat.returnOnRiskPct !== null
                          ? `${strat.returnOnRiskPct}% Return on risk`
                          : `${strat.returnOnCollateralPct ?? 0}% Return on collateral`}
                      </span>
                      <span className="strat-stat-profit">${strat.targetProfit.toLocaleString()} Profit</span>
                    </div>

                    <div className="strat-card-stat-right">
                      <span className="strat-stat-chance">{strat.chanceOfProfit}% Chance 🔒</span>
                      <span className="strat-stat-risk">
                        ${strat.riskOrCollateral.toLocaleString()}{" "}
                        {strat.returnOnRiskPct !== null ? "Risk" : "Collateral"}
                      </span>
                    </div>
                  </div>

                  {/* Mini Payoff Chart */}
                  <svg className="strat-card-mini-graph" viewBox={`0 0 ${w} ${h}`}>
                    <defs>
                      <linearGradient id={`${gradId}_gain`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity="0.45" />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
                      </linearGradient>
                      <linearGradient id={`${gradId}_loss`} x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity="0.45" />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
                      </linearGradient>
                      <clipPath id={`${gradId}_above`}>
                        <rect x={0} y={0} width={w} height={zeroY} />
                      </clipPath>
                      <clipPath id={`${gradId}_below`}>
                        <rect x={0} y={zeroY} width={w} height={h - zeroY} />
                      </clipPath>
                    </defs>

                    {/* Zero line */}
                    <line x1={padX} x2={w - padX} y1={zeroY} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />

                    {/* Shaded Gain & Loss Areas */}
                    <path d={areaD} fill={`url(#${gradId}_gain)`} clipPath={`url(#${gradId}_above)`} />
                    <path d={areaD} fill={`url(#${gradId}_loss)`} clipPath={`url(#${gradId}_below)`} />

                    {/* Payoff line */}
                    <path d={lineD} fill="none" stroke="#22c55e" strokeWidth="2.2" clipPath={`url(#${gradId}_above)`} />
                    <path d={lineD} fill="none" stroke="#ef4444" strokeWidth="2.2" clipPath={`url(#${gradId}_below)`} />

                    {/* Spot price line (dotted blue) */}
                    <line x1={toX(spot)} x2={toX(spot)} y1={padY} y2={h - padY} stroke="#38bdf8" strokeDasharray="2 2" strokeWidth="1.5" />

                    {/* Target price line (orange) */}
                    <line x1={toX(targetPrice)} x2={toX(targetPrice)} y1={padY} y2={h - padY} stroke="#f59e0b" strokeWidth="1.5" />

                    {/* Ticks on X axis */}
                    <text x={padX} y={h - 3} fill="#64748b" fontSize="9" fontFamily="monospace">$0</text>
                    <text x={w / 2} y={h - 3} fill="#64748b" fontSize="9" textAnchor="middle" fontFamily="monospace">
                      ${Math.round(spot)}
                    </text>
                    <text x={w - padX} y={h - 3} fill="#64748b" fontSize="9" textAnchor="end" fontFamily="monospace">
                      ${Math.round(targetPrice)}
                    </text>
                  </svg>

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
                🛈
              </span>
            </div>

            <div className="strat-builder-action-btns">
              <button
                type="button"
                className="strat-btn-action"
                onClick={() => setShowPositionsDrawer((prev) => !prev)}
              >
                Add +
              </button>
              <button
                type="button"
                className="strat-btn-action secondary"
                onClick={() => setShowPositionsDrawer((prev) => !prev)}
              >
                Positions ({builderLegs.length}) ☵
              </button>
              <button
                type="button"
                className="strat-btn-action secondary"
                onClick={() => alert("Trade structure saved to watchlist!")}
              >
                Save Trade
              </button>
              <button
                type="button"
                className="strat-btn-action secondary"
                onClick={() => onSendPrompt?.(`Historical backtest for ${currentStrategyName} on ${activeSymbol}`, "Options Strategy Builder")}
              >
                Historical Chart ↻
              </button>
            </div>
          </div>

          {/* Ticker & Price Bar */}
          <div className="strat-symbol-bar">
            <span style={{ background: "#0b1329", border: "1px solid #38bdf8", padding: "0.2rem 0.6rem", borderRadius: "4px", color: "#38bdf8", fontWeight: 800 }}>
              {activeSymbol}
            </span>
            <span className="strat-price-display">${quote.price.toFixed(2)}</span>
            <span className={`strat-change-pill ${quote.change >= 0 ? "positive" : "negative"}`}>
              {quote.change >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}% ${quote.change.toFixed(2)}
            </span>
            <span className="strat-delayed-badge">Delayed 🛈</span>
          </div>

          {/* Expiration Bar (Image 1) */}
          <div className="strat-expiration-bar">
            <div className="strat-expiration-label">EXPIRATION: {selectedExpiration.dte}d</div>
            <div className="strat-timeline-strip">
              {expirations.map((exp) => (
                <button
                  key={exp.date}
                  type="button"
                  className={`strat-timeline-chip ${selectedExpiration.date === exp.date ? "active" : ""}`}
                  onClick={() => setSelectedExpiration(exp)}
                >
                  <span>{exp.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Strike Ruler (Image 1) */}
          <div className="strat-strike-ruler-wrap">
            <div className="strat-strike-ruler-title">STRIKE:</div>
            <div className="strat-strike-ruler">
              <div className="strat-ruler-ticks">
                {rulerStrikes.map((k) => {
                  const isCallLeg = builderLegs.find((l) => l.strike === k && l.optionType === "CALL");
                  const isPutLeg = builderLegs.find((l) => l.strike === k && l.optionType === "PUT");

                  return (
                    <div key={k} className={`strat-ruler-tick ${Math.abs(k - spot) < 2 ? "highlight" : ""}`}>
                      <div className="strat-ruler-tick-bar" />
                      <span>{k}</span>
                      {isCallLeg && (
                        <div className="strat-ruler-badge call" title={`Call Strike: ${k}`}>
                          {k}C
                        </div>
                      )}
                      {isPutLeg && (
                        <div className="strat-ruler-badge put" title={`Put Strike: ${k}`}>
                          {k}P
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

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
              <span className="strat-metric-val" style={{ fontSize: "0.88rem" }}>
                {selectedStrategy?.breakevenText || `Below $${spot.toFixed(2)} (+0%)`}
              </span>
            </div>
          </div>

          {/* Interactive Payoff SVG Graph OR Table Matrix */}
          {builderDisplayMode === "graph" ? (
            <div
              className="strat-full-graph-wrap"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const xRatio = (e.clientX - rect.left) / rect.width;
                const hoveredVal = priceLow + xRatio * (priceHigh - priceLow);
                setGraphHoverPrice(Number(hoveredVal.toFixed(2)));
              }}
              onMouseLeave={() => setGraphHoverPrice(null)}
            >
              {(() => {
                const svgW = 860;
                const svgH = 360;
                const padL = 60;
                const padR = 25;
                const padT = 25;
                const padB = 40;

                const toX = (p: number) => padL + ((p - priceLow) / (priceHigh - priceLow)) * (svgW - padL - padR);
                const toY = (val: number) => padT + ((yMax - val) / (yMax - yMin)) * (svgH - padT - padB);
                const zeroY = toY(0);

                const lineExpiry = builderGraphPoints
                  .map((pt, i) => `${i === 0 ? "M" : "L"}${toX(pt.price).toFixed(1)},${toY(pt.pnlExpiry).toFixed(1)}`)
                  .join(" ");

                const lineInter = builderGraphPoints
                  .map((pt, i) => `${i === 0 ? "M" : "L"}${toX(pt.price).toFixed(1)},${toY(pt.pnlIntermediate).toFixed(1)}`)
                  .join(" ");

                const areaD = `${lineExpiry} L${toX(priceHigh).toFixed(1)},${zeroY.toFixed(1)} L${toX(priceLow).toFixed(1)},${zeroY.toFixed(1)} Z`;

                // Ticks for Y axis
                const yTicks = [yMax, yMax * 0.5, 0, yMin * 0.5, yMin];
                // Ticks for X axis
                const xTicks = [
                  priceLow,
                  priceLow + (priceHigh - priceLow) * 0.25,
                  spot,
                  priceLow + (priceHigh - priceLow) * 0.75,
                  priceHigh,
                ];

                return (
                  <svg className="strat-full-graph-svg" viewBox={`0 0 ${svgW} ${svgH}`}>
                    <defs>
                      <linearGradient id="full_gain_grad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity="0.01" />
                      </linearGradient>
                      <linearGradient id="full_loss_grad" x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity="0.4" />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity="0.01" />
                      </linearGradient>
                      <clipPath id="full_above_zero">
                        <rect x={padL} y={padT} width={svgW - padL - padR} height={Math.max(0, zeroY - padT)} />
                      </clipPath>
                      <clipPath id="full_below_zero">
                        <rect x={padL} y={zeroY} width={svgW - padL - padR} height={Math.max(0, svgH - padB - zeroY)} />
                      </clipPath>
                    </defs>

                    {/* Horizontal Grid lines & Y labels */}
                    {yTicks.map((val, idx) => (
                      <g key={idx}>
                        <line
                          x1={padL}
                          x2={svgW - padR}
                          y1={toY(val)}
                          y2={toY(val)}
                          stroke="rgba(255, 255, 255, 0.08)"
                          strokeDasharray={val === 0 ? "none" : "3 3"}
                        />
                        <text
                          x={padL - 10}
                          y={toY(val) + 4}
                          fill="#94a3b8"
                          fontSize="11"
                          fontFamily="monospace"
                          textAnchor="end"
                        >
                          ${Math.round(val)}
                        </text>
                      </g>
                    ))}

                    {/* Vertical X axis labels */}
                    {xTicks.map((val, idx) => (
                      <text
                        key={idx}
                        x={toX(val)}
                        y={svgH - 12}
                        fill="#94a3b8"
                        fontSize="11"
                        fontFamily="monospace"
                        textAnchor="middle"
                      >
                        ${val.toFixed(2)}
                      </text>
                    ))}

                    {/* Shaded Gain Area (Green) */}
                    <path d={areaD} fill="url(#full_gain_grad)" clipPath="url(#full_above_zero)" />
                    {/* Shaded Loss Area (Red) */}
                    <path d={areaD} fill="url(#full_loss_grad)" clipPath="url(#full_below_zero)" />

                    {/* Intermediate Date Theoretical Curve (Smooth) */}
                    {builderDateSliderPct < 100 && (
                      <path
                        d={lineInter}
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth="2.5"
                        strokeDasharray="4 2"
                      />
                    )}

                    {/* Expiration Payoff Line (Solid green above zero, red below) */}
                    <path
                      d={lineExpiry}
                      fill="none"
                      stroke="#22c55e"
                      strokeWidth="3"
                      clipPath="url(#full_above_zero)"
                    />
                    <path
                      d={lineExpiry}
                      fill="none"
                      stroke="#ef4444"
                      strokeWidth="3"
                      clipPath="url(#full_below_zero)"
                    />

                    {/* Spot Price Line (Cyan / Blue vertical) */}
                    <line
                      x1={toX(spot)}
                      x2={toX(spot)}
                      y1={padT}
                      y2={svgH - padB}
                      stroke="#38bdf8"
                      strokeDasharray="3 3"
                      strokeWidth="1.5"
                    />
                    <text
                      x={toX(spot)}
                      y={padT - 6}
                      fill="#38bdf8"
                      fontSize="11"
                      fontWeight="bold"
                      fontFamily="monospace"
                      textAnchor="middle"
                    >
                      ${spot.toFixed(2)}
                    </text>

                    {/* Hover Crosshair & Tooltip Bubble */}
                    {graphHoverPrice !== null && (
                      <g>
                        <line
                          x1={toX(hoveredPoint.price)}
                          x2={toX(hoveredPoint.price)}
                          y1={padT}
                          y2={svgH - padB}
                          stroke="#ffffff"
                          strokeDasharray="2 2"
                          strokeWidth="1"
                        />
                        <circle
                          cx={toX(hoveredPoint.price)}
                          cy={toY(hoveredPoint.pnl)}
                          r="5"
                          fill="#ffffff"
                          stroke="#0284c7"
                          strokeWidth="2"
                        />
                        {/* Tooltip Pill */}
                        <g transform={`translate(${Math.min(svgW - 140, Math.max(padL + 20, toX(hoveredPoint.price)))}, ${Math.max(padT + 20, toY(hoveredPoint.pnl) - 15)})`}>
                          <rect
                            x="-60"
                            y="-24"
                            width="120"
                            height="24"
                            rx="4"
                            fill="#0b1329"
                            stroke={hoveredPoint.pnl >= 0 ? "#22c55e" : "#ef4444"}
                            strokeWidth="1.5"
                          />
                          <text
                            x="0"
                            y="-8"
                            fill="#ffffff"
                            fontSize="10"
                            fontWeight="bold"
                            textAnchor="middle"
                            fontFamily="monospace"
                          >
                            ${hoveredPoint.price.toFixed(2)}: {hoveredPoint.pnl >= 0 ? "+" : ""}${hoveredPoint.pnl}
                          </text>
                        </g>
                      </g>
                    )}
                  </svg>
                );
              })()}
            </div>
          ) : (
            /* Data Matrix Table Mode */
            <div className="strat-table-view-wrap">
              <table className="strat-matrix-table">
                <thead>
                  <tr>
                    <th>Underlying Price</th>
                    <th>Expiration P/L ($)</th>
                    <th>Date T P/L ($)</th>
                    <th>ROI (%)</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {builderGraphPoints.map((pt, i) => {
                    const isNearSpot = Math.abs(pt.price - spot) < (priceHigh - priceLow) / 30;
                    return (
                      <tr key={i} className={isNearSpot ? "current-price-row" : ""}>
                        <td>${pt.price.toFixed(2)}</td>
                        <td style={{ color: pt.pnlExpiry >= 0 ? "#22c55e" : "#ef4444", fontWeight: "bold" }}>
                          {pt.pnlExpiry >= 0 ? "+" : ""}${pt.pnlExpiry}
                        </td>
                        <td style={{ color: pt.pnlIntermediate >= 0 ? "#38bdf8" : "#f87171" }}>
                          {pt.pnlIntermediate >= 0 ? "+" : ""}${pt.pnlIntermediate}
                        </td>
                        <td>
                          {selectedStrategy?.riskOrCollateral
                            ? `${((pt.pnlExpiry / selectedStrategy.riskOrCollateral) * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                        <td>{pt.pnlExpiry >= 0 ? "PROFIT" : "LOSS"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Controls Below Graph: Date Slider, Range Slider, IV Slider (Image 1) */}
          <div className="strat-graph-controls-bar">
            {/* Date Slider */}
            <div className="strat-date-slider-row">
              <span>DATE: Today ({currentDte.toFixed(0)}d remaining)</span>
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
                <button
                  type="button"
                  className="strat-zoom-btn"
                  onClick={() => setBuilderIv(44.2)}
                  title="Reset IV"
                >
                  ↻
                </button>
              </div>
            </div>
          </div>

          {/* Bottom View Mode & Metric Toggles Bar (Image 1) */}
          <div className="strat-bottom-toggles-bar">
            <div className="strat-bottom-mode-btns">
              <button
                type="button"
                className={`strat-bottom-btn ${builderDisplayMode === "table" ? "active" : ""}`}
                onClick={() => setBuilderDisplayMode("table")}
              >
                ☵ Table
              </button>
              <button
                type="button"
                className={`strat-bottom-btn ${builderDisplayMode === "graph" ? "active" : ""}`}
                onClick={() => setBuilderDisplayMode("graph")}
              >
                📈 Graph
              </button>
            </div>

            <div className="strat-bottom-metric-btns">
              <button
                type="button"
                className={`strat-bottom-btn ${builderMetricMode === "pnl_dollar" ? "active" : ""}`}
                onClick={() => setBuilderMetricMode("pnl_dollar")}
              >
                Profit / Loss $
              </button>
              <button
                type="button"
                className={`strat-bottom-btn ${builderMetricMode === "pnl_pct" ? "active" : ""}`}
                onClick={() => setBuilderMetricMode("pnl_pct")}
              >
                Profit / Loss %
              </button>
              <button
                type="button"
                className={`strat-bottom-btn ${builderMetricMode === "contract_val" ? "active" : ""}`}
                onClick={() => setBuilderMetricMode("contract_val")}
              >
                Contract Value
              </button>
              <button
                type="button"
                className={`strat-bottom-btn ${builderMetricMode === "collateral_pct" ? "active" : ""}`}
                onClick={() => setBuilderMetricMode("collateral_pct")}
              >
                % of Collateral
              </button>
              <button
                type="button"
                className="strat-bottom-btn"
                onClick={() => setShowPositionsDrawer((prev) => !prev)}
              >
                ▾ More
              </button>
            </div>
          </div>

          {/* Expandable Positions Drawer to inspect and edit legs */}
          {showPositionsDrawer && (
            <div className="strat-positions-panel">
              <div className="strat-positions-title">
                <span>Active Strategy Legs ({builderLegs.length})</span>
                <button
                  type="button"
                  style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "1rem" }}
                  onClick={() => setShowPositionsDrawer(false)}
                >
                  ✕
                </button>
              </div>

              {builderLegs.map((leg, index) => (
                <div key={leg.id || index} className="strat-position-row">
                  <span style={{ fontWeight: "bold", color: leg.side === "BUY" ? "#22c55e" : "#ef4444" }}>
                    {leg.side}
                  </span>
                  <span>{leg.quantity} {leg.optionType}</span>
                  <span>
                    Strike: <strong>${leg.strike}</strong>
                  </span>
                  <span>Entry: ${leg.entryPrice.toFixed(2)}</span>
                  <span>Delta: {leg.delta.toFixed(2)}</span>
                  <button
                    type="button"
                    style={{ background: "rgba(239, 68, 68, 0.2)", border: "1px solid #ef4444", color: "#f87171", borderRadius: "3px", cursor: "pointer" }}
                    onClick={() => {
                      setBuilderLegs((prev) => prev.filter((_, i) => i !== index));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
