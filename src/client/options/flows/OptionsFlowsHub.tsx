import React, { useState, useMemo, useEffect } from "react";
import "./optionsFlows.css";
import {
  LiveFlowItem,
  NewsFlowItem,
  InsiderFlowItem,
  CongressFlowItem,
  FlowSummary,
  FlowFilterConfig,
  SavedFilterPreset,
} from "../../../trading/options/flows/types";
import {
  DEFAULT_SAVED_PRESETS,
  DEFAULT_FILTER_CONFIG,
  filterLiveFlowItems,
  filterNewsFlowItems,
  filterInsiderFlowItems,
  filterCongressFlowItems,
  calculateFlowSummary,
  formatFlowDateTime,
} from "../../../trading/options/flows/flowService";
import { FlowFiltersSidebar } from "./FlowFiltersSidebar";
import { FlowSummaryDualBars } from "./FlowSummaryDualBars";
import { FlowTradeDetailModal } from "./FlowTradeDetailModal";
import { StrategyDiscoveryPanel } from "../StrategyDiscoveryPanel";
import { RiskAnalysisModal } from "../RiskAnalysisModal";
import type { RiskSubject } from "../riskManagementEngine";
import { CapabilityNavBar, CopilotTriggerButton } from "../../components/CapabilityNavBar";

export type FlowSubTab = "summary" | "live" | "historical" | "news" | "congress" | "insider";

interface OptionsFlowsHubProps {
  user?: { name: string; login: string };
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onTradeSymbol?: (symbol: string) => void;
}

function flowTradeToRiskSubject(trade: LiveFlowItem): RiskSubject {
  const isPut = trade.strategy.toLowerCase().includes("put");
  const isCredit = trade.isCredit ?? (trade.side === "SELL" || trade.strategy.toLowerCase().includes("credit"));
  const strike = typeof trade.strike === "number" ? trade.strike : trade.underlyingPrice;
  const fill = trade.fillPrice || 1.5;
  return {
    title: trade.strategyTitle || `${trade.symbol} ${trade.strategy}`,
    underlyingSymbol: trade.symbol,
    underlyingPrice: trade.currentSpot || trade.underlyingPrice,
    strategyType: trade.strategy,
    sentiment: trade.sentiment,
    expirationDate: trade.expiration,
    dte: trade.dte,
    quantity: trade.totalQuantity || trade.volume || 10,
    netDebit: isCredit ? -fill : fill,
    maxProfit: isCredit ? fill * 100 : null,
    maxLoss: isCredit ? null : fill * 100,
    chanceOfProfit: trade.chance || (isCredit ? 65 : 45),
    breakevens: [isPut ? Number((strike - fill).toFixed(2)) : Number((strike + fill).toFixed(2))],
    breakevenText: trade.calculationText,
    legs: (trade.legsDetails || []).map((l) => ({
      side: l.action.toUpperCase().includes("BUY") ? "BUY" : "SELL",
      optionType: l.optionType,
      strike: l.strike,
      quantity: l.quantity,
    })),
  };
}

export function OptionsFlowsHub({
  user,
  onSendPrompt,
  onTradeSymbol,
}: OptionsFlowsHubProps) {
  const [subTab, setSubTab] = useState<FlowSubTab>("live");
  const [filterConfig, setFilterConfig] = useState<FlowFilterConfig>(DEFAULT_FILTER_CONFIG);
  const [activePreset, setActivePreset] = useState<SavedFilterPreset | null>(DEFAULT_SAVED_PRESETS[0]);
  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>(DEFAULT_SAVED_PRESETS);
  const [selectedDetailTrade, setSelectedDetailTrade] = useState<LiveFlowItem | null>(null);
  const [activeBuilderTrade, setActiveBuilderTrade] = useState<LiveFlowItem | null>(null);
  const [riskSubject, setRiskSubject] = useState<RiskSubject | null>(null);
  const [isFiltersOpen, setIsFiltersOpen] = useState<boolean>(true);

  // Live / Historical items: pure real-time data feeds
  const [liveItems, setLiveItems] = useState<LiveFlowItem[]>([]);
  const [marketFlowItems, setMarketFlowItems] = useState<LiveFlowItem[]>([]);
  const [hasLoadedInitial, setHasLoadedInitial] = useState<boolean>(false);
  const [newsItems, setNewsItems] = useState<NewsFlowItem[]>([]);
  const [insiderItems, setInsiderItems] = useState<InsiderFlowItem[]>([]);
  const [congressItems, setCongressItems] = useState<CongressFlowItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(true);
  const [lastSyncTime, setLastSyncTime] = useState<string>("");

  const fetchLiveFlows = (config?: Partial<FlowFilterConfig>) => {
    setIsRefreshing(true);
    const cfg = config || filterConfig;
    const params = new URLSearchParams();
    if (cfg.tickers && cfg.tickers.length > 0) params.set("tickers", cfg.tickers.join(","));
    if (cfg.minPremium && cfg.minPremium > 0) params.set("minPremium", String(cfg.minPremium));
    if (cfg.marketCaps && cfg.marketCaps.length > 0) params.set("marketCaps", cfg.marketCaps.join(","));
    if (cfg.assetTypes && cfg.assetTypes.length > 0) params.set("assetTypes", cfg.assetTypes.join(","));
    const url = `/api/options/flows/live${params.toString() ? `?${params.toString()}` : ""}`;

    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data?.flows && Array.isArray(data.flows)) {
          setLiveItems(data.flows);
          if (!cfg.tickers || cfg.tickers.length === 0) {
            setMarketFlowItems(data.flows);
          }
          setLastSyncTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        } else {
          setLiveItems([]);
        }
      })
      .catch(() => {
        setLiveItems([]);
      })
      .finally(() => {
        setIsRefreshing(false);
        setHasLoadedInitial(true);
      });
  };

  // Fetch initial or server data if available
  useEffect(() => {
    fetchLiveFlows(filterConfig);

    const tickerParam = filterConfig.tickers.length > 0 ? `?tickers=${encodeURIComponent(filterConfig.tickers.join(","))}` : "";

    fetch(`/api/options/flows/news${tickerParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        setNewsItems(Array.isArray(data?.news) ? data.news : []);
      })
      .catch(() => {
        setNewsItems([]);
      });

    fetch(`/api/options/flows/insider${tickerParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        setInsiderItems(Array.isArray(data?.insiders) ? data.insiders : []);
      })
      .catch(() => {
        setInsiderItems([]);
      });

    fetch("/api/options/flows/congress")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        setCongressItems(Array.isArray(data?.congress) ? data.congress : []);
      })
      .catch(() => {
        setCongressItems([]);
      });

    // Auto-refresh dynamic options flow stream every 30 seconds
    const interval = setInterval(() => {
      fetchLiveFlows(filterConfig);
    }, 30000);

    return () => clearInterval(interval);
  }, [filterConfig.tickers, filterConfig.minPremium, filterConfig.marketCaps, filterConfig.assetTypes]);

  // Filtered collections
  const filteredLiveItems = useMemo(() => {
    return filterLiveFlowItems(liveItems, filterConfig);
  }, [liveItems, filterConfig]);

  const filteredNewsItems = useMemo(() => {
    return filterNewsFlowItems(newsItems, filterConfig.tickers);
  }, [newsItems, filterConfig.tickers]);

  const filteredInsiderItems = useMemo(() => {
    return filterInsiderFlowItems(insiderItems, {
      tickers: filterConfig.tickers,
      insiderNames: filterConfig.insiderNames,
      minPremium: filterConfig.minPremium,
      assetTypes: filterConfig.assetTypes,
      marketCaps: filterConfig.marketCaps,
    });
  }, [insiderItems, filterConfig]);

  const filteredCongressItems = useMemo(() => {
    return filterCongressFlowItems(congressItems, {
      tickers: filterConfig.tickers,
      chamber: filterConfig.congressChamber,
      party: filterConfig.congressParty,
    });
  }, [congressItems, filterConfig]);

  const summaryData: FlowSummary = useMemo(() => {
    // Market Summary must ALWAYS represent the market-wide flow across active general filters,
    // NEVER collapsed into a single drilled-down stock!
    const marketItems = marketFlowItems.length > 0 ? marketFlowItems : liveItems;
    const generalMarketConfig: FlowFilterConfig = {
      ...filterConfig,
      tickers: [], // Exclude single-ticker drilldown so Summary always displays all stocks
    };
    const filteredMarket = filterLiveFlowItems(marketItems, generalMarketConfig);
    return calculateFlowSummary(filteredMarket);
  }, [marketFlowItems, liveItems, filterConfig]);

  const handleSwitchSubTab = (tab: FlowSubTab) => {
    setSubTab(tab);
    if (tab === "summary") {
      // When returning to Summary, clear single ticker drilldown so full dynamic market list is displayed
      if (filterConfig.tickers.length > 0) {
        const nextCfg: FlowFilterConfig = {
          ...filterConfig,
          tickers: [],
        };
        setFilterConfig(nextCfg);
        fetchLiveFlows(nextCfg);
      } else if (marketFlowItems.length === 0) {
        fetchLiveFlows(filterConfig);
      }
    }
  };

  const handleClearTickerDrilldown = () => {
    const nextCfg: FlowFilterConfig = {
      ...filterConfig,
      tickers: [],
    };
    setFilterConfig(nextCfg);
    fetchLiveFlows(nextCfg);
  };

  // Handle Preset selection
  const handleSelectPreset = (preset: SavedFilterPreset) => {
    setActivePreset(preset);
    setFilterConfig({
      ...DEFAULT_FILTER_CONFIG,
      ...preset.config,
    });
  };

  const handleClearPreset = () => {
    setActivePreset(null);
    setFilterConfig(DEFAULT_FILTER_CONFIG);
  };

  const handleSaveFilter = (name: string) => {
    const newPreset: SavedFilterPreset = {
      id: `custom_${Date.now()}`,
      name,
      tagline: "Custom User Filter",
      color: "purple",
      tags: [
        filterConfig.tickers.length ? filterConfig.tickers.join(",") : "All Tickers",
        filterConfig.minPremium ? `>${Math.round(filterConfig.minPremium / 1000)}k` : "All Prem",
      ],
      config: { ...filterConfig },
    };
    setSavedPresets((prev) => [newPreset, ...prev]);
    setActivePreset(newPreset);
  };

  const handleResetFilter = () => {
    setActivePreset(null);
    setFilterConfig(DEFAULT_FILTER_CONFIG);
  };

  // Select ticker from dual leaderboard
  const handleSelectTicker = (symbol: string) => {
    setActivePreset(null);
    const nextCfg: FlowFilterConfig = {
      ...DEFAULT_FILTER_CONFIG,
      tickers: [symbol],
    };
    setFilterConfig(nextCfg);
    setSubTab("live");
    fetchLiveFlows(nextCfg);
  };

  // Open trade details modal
  const handleOpenTradeDetail = (trade: LiveFlowItem) => {
    setSelectedDetailTrade(trade);
  };

  // Open in Builder handoff
  const handleOpenInBuilder = (trade: LiveFlowItem) => {
    setSelectedDetailTrade(null);
    setActiveBuilderTrade(trade);
  };

  // Row Action handler
  const handleTradeOrPrompt = (symbol: string, strategyText?: string) => {
    if (onTradeSymbol) {
      onTradeSymbol(symbol);
    } else if (onSendPrompt) {
      onSendPrompt(`Analyze institutional flow for ${symbol}: ${strategyText || "Options sweep"}`);
    }
  };

  // If builder is active for a flow trade (Screenshot 4)
  if (activeBuilderTrade) {
    const legs = activeBuilderTrade.legsDetails && activeBuilderTrade.legsDetails.length > 0
      ? activeBuilderTrade.legsDetails.map((l, idx) => ({
          id: `flow_leg_${idx}_${l.action}_${l.strike || idx}`,
          side: l.action.toUpperCase() as "BUY" | "SELL",
          optionType: l.optionType || (l.option.includes("C") ? "CALL" : "PUT"),
          strike: l.strike || (l.option.includes("135") ? 135 : l.option.includes("97.5") ? 97.5 : 100),
          quantity: l.quantity,
          expirationDate: l.expirationDate || "2027-01-15",
          dte: activeBuilderTrade.dte || 100,
          entryPrice: l.action === "Buy" ? 1.63 : 1.57,
          bid: 1.55,
          ask: 1.65,
          impliedVolatility: 27.5,
          delta: (l.optionType || (l.option.includes("C") ? "CALL" : "PUT")) === "CALL" ? 0.42 : -0.38,
          gamma: 0.015,
          theta: -0.045,
          vega: 0.12,
        }))
      : [
          {
            id: "flow_leg_0_buy_135c",
            side: "BUY" as const,
            optionType: "CALL" as const,
            strike: 135,
            quantity: 2000,
            expirationDate: "2027-01-15",
            dte: 100,
            entryPrice: 1.63,
            bid: 1.60,
            ask: 1.66,
            impliedVolatility: 27.5,
            delta: 0.42,
            gamma: 0.015,
            theta: -0.045,
            vega: 0.12,
          },
          {
            id: "flow_leg_1_sell_97p",
            side: "SELL" as const,
            optionType: "PUT" as const,
            strike: 97.5,
            quantity: 2000,
            expirationDate: "2027-01-15",
            dte: 100,
            entryPrice: 1.57,
            bid: 1.54,
            ask: 1.60,
            impliedVolatility: 27.5,
            delta: -0.38,
            gamma: 0.015,
            theta: -0.045,
            vega: 0.12,
          },
        ];

    return (
      <div className="options-flows-container options-flows-builder-view">
        <StrategyDiscoveryPanel
          initialSymbol={activeBuilderTrade.symbol}
          initialStrategyName={activeBuilderTrade.strategyTitle || activeBuilderTrade.strategy}
          initialExpirationDate={
            activeBuilderTrade.legsDetails?.[0]?.expirationDate || "2027-01-15"
          }
          initialCustomLegs={legs}
          flowTradeBanner={{
            title: `${activeBuilderTrade.symbol} Options Flow`,
            returnText: activeBuilderTrade.returnSinceFillText || "-$5.50 (-3.5%) return since Oct 6, 2026, 3:51 PM",
          }}
          onBackToFlows={() => setActiveBuilderTrade(null)}
          onSendPrompt={onSendPrompt}
        />
      </div>
    );
  }

  return (
    <div className="options-flows-container">
      {/* Universal Capability Navigation Bar */}
      <CapabilityNavBar
        ariaLabel="Institutional Options Flows"
        activeTabId={subTab}
        onTabChange={(id) => handleSwitchSubTab(id as FlowSubTab)}
        className="flows-capability-nav"
        tabs={[
          {
            id: "summary",
            label: "Summary",
            tooltip: {
              eyebrow: "MARKET OVERVIEW",
              title: "Options Flow Market Summary",
              description: "Market-wide institutional options flow, aggregate bullish vs bearish sentiment, and top premium targets.",
            },
          },
          {
            id: "live",
            label: "Live Flow",
            badge: "LIVE",
            badgeType: "live",
            tooltip: {
              eyebrow: "REAL-TIME ALERTS",
              title: "Live Institutional Flow",
              description: "Real-time block trades, sweeps, and multi-leg prints synthesized directly from live market feeds.",
            },
          },
          {
            id: "historical",
            label: "Historical Flow",
            tooltip: {
              eyebrow: "FLOW ARCHIVE",
              title: "Historical Options Flow",
              description: "Aggregated past institutional flow patterns across major equity tickers.",
            },
          },
          {
            id: "news",
            label: "News Flow",
            tooltip: {
              eyebrow: "CATALYST FEED",
              title: "Real-Time News Flow",
              description: "Real-time breaking market news tied directly to options volatility and unusual volume catalysts.",
            },
          },
          {
            id: "congress",
            label: "Congress Flow",
            tooltip: {
              eyebrow: "CAPITOL HILL DISCLOSURES",
              title: "Congressional Trading Flow",
              description: "Capitol Hill financial disclosures and congressional trading disclosures filed under the STOCK Act.",
            },
          },
          {
            id: "insider",
            label: "Insider Flow",
            tooltip: {
              eyebrow: "SEC FORM 4 FILINGS",
              title: "Corporate Insider Flow",
              description: "SEC Form 4 corporate insider purchases, sales, and option exercises by C-suite executives and board directors.",
            },
          },
        ]}
        rightContent={
          <>
            <CopilotTriggerButton label="✨ Ask Copilot" />
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--color-success)", background: "var(--color-success-subtle)", padding: "4px 8px", borderRadius: "var(--radius-full, 12px)", border: "1px solid var(--color-success)", fontWeight: 600 }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--color-success)", boxShadow: "0 0 6px var(--color-success)" }} />
              <span>LIVE</span>
              {lastSyncTime && <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>{lastSyncTime}</span>}
            </div>
            <button
              type="button"
              onClick={() => fetchLiveFlows(filterConfig)}
              disabled={isRefreshing}
              style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "var(--color-text-muted)", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-medium)", borderRadius: "var(--radius-sm)", padding: "4px 8px", cursor: isRefreshing ? "wait" : "pointer" }}
              title="Fetch fresh real-time options flow prints"
            >
              {isRefreshing ? "Refreshing..." : "↻ Refresh"}
            </button>
            <div
              className="flows-gauge-badge-wrap"
              onClick={() => handleSwitchSubTab("summary")}
              title="Overall Options Market Flow Sentiment Dial"
            >
              <svg className="flows-gauge-svg" viewBox="0 0 40 20">
                <path
                  d="M 5 20 A 15 15 0 0 1 35 20"
                  fill="none"
                  stroke="var(--color-surface-raised)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <path
                  d="M 5 20 A 15 15 0 0 1 28 8"
                  fill="none"
                  stroke="var(--color-accent)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <path
                  d="M 28 8 A 15 15 0 0 1 35 20"
                  fill="none"
                  stroke="var(--color-warning)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
              </svg>
              <span className="flows-gauge-text">{summaryData.bullishSentimentRatio}% Bullish</span>
            </div>
          </>
        }
      />

      {/* Live Options Flow Stream Status */}
      <div className="flows-delay-banner">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-success)", display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>Live Real-Time Stream: Dark Pool Sweeps, Unusual Block Trades &amp; Institutional Momentum</span>
        </div>

        <div className="flows-delay-banner-right">
          {activePreset && (
            <div className={`flows-filter-active-pill-header ${activePreset.color}`}>
              <span>Filter: {activePreset.name}</span>
            </div>
          )}
          <button
            type="button"
            className={`flow-toggle-filters-btn ${isFiltersOpen ? "active" : ""}`}
            onClick={() => setIsFiltersOpen(!isFiltersOpen)}
            title={isFiltersOpen ? "Hide filters to expand table" : "Show filters panel"}
          >
            {isFiltersOpen ? "✕ Hide Filters" : "⚙️ Filters"}
          </button>
        </div>
      </div>

      {/* Main Split Layout: Data Tables + Right Sidebar */}
      <div className="flows-main-layout">
        <main className="flows-table-area">
          {/* SUB-TAB 1: SUMMARY VIEW */}
          {subTab === "summary" && (
            !hasLoadedInitial && isRefreshing ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Aggregating Real-Time Options Flow Leaderboard...
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  Calculating net bullish vs bearish institutional dollar volumes directly from live market exchanges
                </div>
              </div>
            ) : summaryData.totalTrades === 0 ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  No live options market prints currently available from exchange streams.
                </div>
              </div>
            ) : (
              <FlowSummaryDualBars
                bullishItems={summaryData.bullishLeaderboard}
                bearishItems={summaryData.bearishLeaderboard}
                onSelectSymbol={handleSelectTicker}
              />
            )
          )}

          {/* SUB-TAB 2: LIVE FLOW & SUB-TAB 3: HISTORICAL FLOW */}
          {(subTab === "live" || subTab === "historical") && (
            <>
              {filterConfig.tickers.length > 0 && (
                <div className="flow-drilldown-banner">
                  <div className="flow-drilldown-info">
                    <span className="flow-drilldown-badge">TICKER DRILLDOWN</span>
                    <span className="flow-drilldown-text">
                      Showing Live Flow for <strong>{filterConfig.tickers.join(", ")}</strong>
                    </span>
                  </div>
                  <div className="flow-drilldown-actions">
                    <button
                      type="button"
                      className="flow-drilldown-back-btn"
                      onClick={() => handleSwitchSubTab("summary")}
                    >
                      ← Return to Market Summary
                    </button>
                    <button
                      type="button"
                      className="flow-drilldown-clear-btn"
                      onClick={handleClearTickerDrilldown}
                    >
                      ✕ Show All Tickers
                    </button>
                  </div>
                </div>
              )}
              {!hasLoadedInitial && isRefreshing ? (
                <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                  <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                    Streaming Real-Time Institutional Options Flow...
                  </div>
                  <div style={{ fontSize: "0.85rem" }}>
                    Fetching authentic market orders, sweeps, and block trades from live exchange feeds
                  </div>
                </div>
              ) : filteredLiveItems.length === 0 ? (
                <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                  <div style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                    No live feed available
                  </div>
                  <div style={{ fontSize: "0.85rem" }}>
                    {filterConfig.tickers.length > 0 || filterConfig.minPremium > 0
                      ? "No live prints matching the current filter criteria."
                      : "No live options flow prints currently available from exchange feeds."}
                  </div>
                </div>
              ) : (
                <table className="flow-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Symbol</th>
                      <th>Strategy</th>
                      <th>Expiration</th>
                      <th>Premium</th>
                      <th>Type</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLiveItems.map((item) => (
                      <tr
                        key={item.id}
                        style={{ cursor: "pointer" }}
                        onClick={() => handleOpenTradeDetail(item)}
                      >
                        <td className="flow-time-cell">
                          {item.timestamp ? formatFlowDateTime(item.timestamp) : item.time}
                        </td>
                        <td className={`flow-symbol-cell ${item.sentiment}`}>{item.symbol}</td>
                        <td className="flow-strategy-cell">
                          {item.strategy}
                          {item.companyName && (
                            <span className="flow-strategy-desc">({item.companyName})</span>
                          )}
                        </td>
                        <td className="flow-exp-cell">{item.expiration}</td>
                        <td className={`flow-premium-cell ${item.sentiment}`}>
                          {item.premiumFormatted}
                          {item.abnormalActivity && <span className="flow-aa-badge">AA</span>}
                        </td>
                        <td>
                          <span className={`flow-type-badge ${item.type.toLowerCase()}`}>
                            {item.type}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="subnav-btn"
                            style={{ padding: "0.2rem 0.45rem", fontSize: "0.72rem", borderColor: "var(--color-warning)", color: "var(--color-warning)" }}
                            title="Analyze institutional trade risk profile"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRiskSubject(flowTradeToRiskSubject(item));
                            }}
                          >
                            🛡️ Risk
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {/* SUB-TAB 4: NEWS FLOW */}
          {subTab === "news" && (
            !hasLoadedInitial && isRefreshing && newsItems.length === 0 ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Fetching Live Market News...
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  Connecting to real-time financial market news feeds
                </div>
              </div>
            ) : filteredNewsItems.length === 0 ? (
              <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  No live financial news prints currently available from market feeds.
                </div>
              </div>
            ) : (
              <table className="flow-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Headline</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNewsItems.map((item) => (
                    <tr
                      key={item.id}
                      style={item.url ? { cursor: "pointer" } : undefined}
                      onClick={item.url ? () => window.open(item.url, "_blank", "noopener,noreferrer") : undefined}
                    >
                      <td className="flow-time-cell">{item.time}</td>
                      <td className="news-headline-cell">
                        <span className="news-symbols-prefix">
                          {item.symbols.join(", ")}:
                        </span>
                        <span>{item.headline}</span>
                        {item.source && (
                          <span style={{ marginLeft: "8px", fontSize: "0.75rem", color: "var(--color-text-muted)", opacity: 0.8 }}>
                            — {item.source}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* SUB-TAB 5: CONGRESS FLOW */}
          {subTab === "congress" && (
            !hasLoadedInitial && isRefreshing && congressItems.length === 0 ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Fetching Congressional Trading Disclosures...
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  Connecting to real-time congressional member stock disclosure feeds
                </div>
              </div>
            ) : filteredCongressItems.length === 0 ? (
              <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  No live congressional trading disclosures feed currently available.
                </div>
              </div>
            ) : (
              <table className="flow-table">
                <thead>
                  <tr>
                    <th>Filing Date</th>
                    <th>Politician</th>
                    <th>Asset / Strategy</th>
                    <th>Transaction</th>
                    <th>Amount</th>
                    <th>Est. Premium</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCongressItems.map((item) => (
                    <tr
                      key={item.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => handleTradeOrPrompt(item.symbol)}
                    >
                      <td className="flow-time-cell">{item.filingDate}</td>
                      <td>
                        <span className="congress-politician">{item.politician}</span>
                        <span className={`congress-meta-tag ${item.party === "Democrat" ? "dem" : "rep"}`}>
                          {item.party[0]} - {item.state}
                        </span>
                      </td>
                      <td className="flow-strategy-cell">
                        <strong>{item.symbol}</strong>: {item.assetDescription}
                      </td>
                      <td>{item.transaction}</td>
                      <td style={{ color: "var(--color-text-muted)" }}>{item.amountRange}</td>
                      <td className="flow-premium-cell bullish">{item.estimatedPremiumFormatted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {/* SUB-TAB 6: INSIDER FLOW */}
          {subTab === "insider" && (
            !hasLoadedInitial && isRefreshing && insiderItems.length === 0 ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  Streaming Live SEC Form 4 Filings...
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  Connecting directly to SEC EDGAR real-time insider trade disclosures
                </div>
              </div>
            ) : filteredInsiderItems.length === 0 ? (
              <div style={{ padding: "3rem 1rem", textAlign: "center", color: "var(--color-text-muted)" }}>
                <div style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.5rem" }}>
                  No live feed available
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  No live SEC Form 4 insider trading feed currently available.
                </div>
              </div>
            ) : (
              <table className="flow-table">
                <thead>
                  <tr>
                    <th>Report Date</th>
                    <th>Trade</th>
                    <th>Member</th>
                    <th>Premium</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredInsiderItems.map((item) => (
                    <tr
                      key={item.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => handleTradeOrPrompt(item.symbol)}
                    >
                      <td className="flow-time-cell">{item.reportDate}</td>
                      <td className="flow-strategy-cell">
                        {item.trade}
                        <span className="flow-strategy-desc">({item.companyName})</span>
                      </td>
                      <td className="insider-member-cell">
                        {item.member}
                        <div className="insider-title-sub">{item.title}</div>
                      </td>
                      <td className="flow-premium-cell bullish">{item.premiumFormatted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </main>

        {/* Right Filters & Alerts Sidebar */}
        {isFiltersOpen && (
          <FlowFiltersSidebar
            currentTab={subTab}
            filterConfig={filterConfig}
            activePreset={activePreset}
            savedPresets={savedPresets}
            totalFlowCount={
              subTab === "news"
                ? newsItems.length
                : subTab === "insider"
                ? insiderItems.length
                : subTab === "congress"
                ? congressItems.length
                : liveItems.length
            }
            filteredFlowCount={
              subTab === "news"
                ? filteredNewsItems.length
                : subTab === "insider"
                ? filteredInsiderItems.length
                : subTab === "congress"
                ? filteredCongressItems.length
                : filteredLiveItems.length
            }
            onFilterChange={setFilterConfig}
            onSelectPreset={handleSelectPreset}
            onClearPreset={handleClearPreset}
            onSaveFilter={handleSaveFilter}
            onResetFilter={handleResetFilter}
            onClose={() => setIsFiltersOpen(false)}
          />
        )}
      </div>

      {/* Trade Detail Modal */}
      {selectedDetailTrade && (
        <FlowTradeDetailModal
          trade={selectedDetailTrade}
          onClose={() => setSelectedDetailTrade(null)}
          onOpenInBuilder={handleOpenInBuilder}
          onRiskAnalysis={(trade) => setRiskSubject(flowTradeToRiskSubject(trade))}
        />
      )}

      {/* Institutional Risk Analysis & Defense Playbook Modal */}
      <RiskAnalysisModal
        isOpen={Boolean(riskSubject)}
        onClose={() => setRiskSubject(null)}
        subject={riskSubject}
        onSendPrompt={onSendPrompt}
      />
    </div>
  );
}
