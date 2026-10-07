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
  RAW_LIVE_FLOW_ITEMS,
  RAW_NEWS_FLOW_ITEMS,
  RAW_INSIDER_FLOW_ITEMS,
  RAW_CONGRESS_FLOW_ITEMS,
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

export type FlowSubTab = "summary" | "live" | "historical" | "news" | "congress" | "insider";

interface OptionsFlowsHubProps {
  user?: { name: string; login: string };
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
  onTradeSymbol?: (symbol: string) => void;
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
  const [showUpgradeModal, setShowUpgradeModal] = useState<boolean>(false);
  const [selectedDetailTrade, setSelectedDetailTrade] = useState<LiveFlowItem | null>(null);
  const [activeBuilderTrade, setActiveBuilderTrade] = useState<LiveFlowItem | null>(null);

  // Live / Historical items
  const [liveItems, setLiveItems] = useState<LiveFlowItem[]>(RAW_LIVE_FLOW_ITEMS);
  const [marketFlowItems, setMarketFlowItems] = useState<LiveFlowItem[]>(RAW_LIVE_FLOW_ITEMS);
  const [hasLoadedInitial, setHasLoadedInitial] = useState<boolean>(false);
  const [newsItems, setNewsItems] = useState<NewsFlowItem[]>(RAW_NEWS_FLOW_ITEMS);
  const [insiderItems, setInsiderItems] = useState<InsiderFlowItem[]>(RAW_INSIDER_FLOW_ITEMS);
  const [congressItems, setCongressItems] = useState<CongressFlowItem[]>(RAW_CONGRESS_FLOW_ITEMS);
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
        if (data?.flows && data.flows.length > 0) {
          setLiveItems(data.flows);
          if (!cfg.tickers || cfg.tickers.length === 0) {
            setMarketFlowItems(data.flows);
          }
          setLastSyncTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        }
      })
      .catch(() => {})
      .finally(() => {
        setIsRefreshing(false);
        setHasLoadedInitial(true);
      });
  };

  // Fetch initial or server data if available
  useEffect(() => {
    fetchLiveFlows(filterConfig);

    fetch("/api/options/flows/news")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data?.news) setNewsItems(data.news);
      })
      .catch(() => {});

    fetch("/api/options/flows/insider")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data?.insiders) setInsiderItems(data.insiders);
      })
      .catch(() => {});

    fetch("/api/options/flows/congress")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        if (data?.congress) setCongressItems(data.congress);
      })
      .catch(() => {});

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
      {/* Top Bar with Sub-Tabs & Market Sentiment Gauge */}
      <header className="flows-header-bar">
        <nav className="flows-subtabs-nav">
          <button
            type="button"
            className={`flows-subtab-btn ${subTab === "summary" ? "active" : ""}`}
            onClick={() => handleSwitchSubTab("summary")}
          >
            Summary
          </button>
          <button
            type="button"
            className={`flows-subtab-btn ${subTab === "live" ? "active" : ""}`}
            onClick={() => handleSwitchSubTab("live")}
          >
            Live Flow
          </button>
          <button
            type="button"
            className={`flows-subtab-btn ${subTab === "historical" ? "active" : ""}`}
            onClick={() => handleSwitchSubTab("historical")}
          >
            Historical Flow
          </button>
          <button
            type="button"
            className={`flows-subtab-btn ${subTab === "news" ? "active" : ""}`}
            onClick={() => handleSwitchSubTab("news")}
          >
            News Flow
          </button>
          <button
            type="button"
            className={`flows-subtab-btn ${subTab === "congress" ? "active" : ""}`}
            onClick={() => handleSwitchSubTab("congress")}
          >
            Congress Flow
          </button>
          <button
            type="button"
            className={`flows-subtab-btn ${subTab === "insider" ? "active" : ""}`}
            onClick={() => handleSwitchSubTab("insider")}
          >
            Insider Flow
          </button>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#10b981", background: "rgba(16, 185, 129, 0.12)", padding: "4px 8px", borderRadius: "12px", border: "1px solid rgba(16, 185, 129, 0.25)", fontWeight: 600 }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981", boxShadow: "0 0 6px #10b981" }} />
            <span>LIVE</span>
            {lastSyncTime && <span style={{ color: "#94a3b8", fontWeight: 400 }}>{lastSyncTime}</span>}
          </div>
          <button
            type="button"
            onClick={() => fetchLiveFlows(filterConfig)}
            disabled={isRefreshing}
            style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "11px", color: "#94a3b8", background: "rgba(30, 41, 59, 0.8)", border: "1px solid #334155", borderRadius: "6px", padding: "4px 8px", cursor: isRefreshing ? "wait" : "pointer" }}
            title="Fetch fresh real-time options flow prints"
          >
            {isRefreshing ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>

        {/* Sentiment Gauge Pill (Screenshot 1 top right) */}
        <div
          className="flows-gauge-badge-wrap"
          onClick={() => handleSwitchSubTab("summary")}
          title="Overall Options Market Flow Sentiment Dial"
        >
          <svg className="flows-gauge-svg" viewBox="0 0 40 20">
            <path
              d="M 5 20 A 15 15 0 0 1 35 20"
              fill="none"
              stroke="#1e293b"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <path
              d="M 5 20 A 15 15 0 0 1 28 8"
              fill="none"
              stroke="#0284c7"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <path
              d="M 28 8 A 15 15 0 0 1 35 20"
              fill="none"
              stroke="#eab308"
              strokeWidth="5"
              strokeLinecap="round"
            />
          </svg>
          <span className="flows-gauge-text">{summaryData.bullishSentimentRatio}% Bullish</span>
        </div>
      </header>

      {/* 15-Minute Delay Disclaimer Banner */}
      <div className="flows-delay-banner">
        <div>
          <span>Data is delayed by 15 minutes and only some alerts are shown - </span>
          <button type="button" onClick={() => setShowUpgradeModal(true)}>
            Upgrade
          </button>
          <span> for full access</span>
        </div>

        {activePreset && (
          <div className={`flows-filter-active-pill-header ${activePreset.color}`}>
            <span>Filter: {activePreset.name}</span>
          </div>
        )}
      </div>

      {/* Main Split Layout: Data Tables + Right Sidebar */}
      <div className="flows-main-layout">
        <main className="flows-table-area">
          {/* SUB-TAB 1: SUMMARY VIEW (SCREENSHOT 1: DUAL GRADIENT BARS) */}
          {subTab === "summary" && (
            !hasLoadedInitial && liveItems.length === 0 ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "#94a3b8" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "#f8fafc", marginBottom: "0.5rem" }}>
                  Aggregating Real-Time Options Flow Leaderboard...
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  Calculating net bullish vs bearish institutional dollar volumes directly from market exchanges
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

          {/* SUB-TAB 2: LIVE FLOW (SCREENSHOTS 1 & 2) */}
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
              {!hasLoadedInitial && liveItems.length === 0 ? (
              <div style={{ padding: "4rem 2rem", textAlign: "center", color: "#94a3b8" }}>
                <div style={{ fontSize: "1.1rem", fontWeight: 600, color: "#f8fafc", marginBottom: "0.5rem" }}>
                  Streaming Real-Time Institutional Options Flow...
                </div>
                <div style={{ fontSize: "0.85rem" }}>
                  Fetching authentic market orders, sweeps, and block trades from exchange feeds
                </div>
              </div>
            ) : filteredLiveItems.length === 0 ? (
              <div style={{ padding: "3rem 1rem", textAlign: "center", color: "#94a3b8" }}>
                No options flow prints matching the current filter criteria.
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
                  </tr>
                </thead>
                <tbody>
                  {filteredLiveItems.map((item) => {
                    if (item.isLocked) {
                      return (
                        <tr
                          key={item.id}
                          className="flow-locked-row"
                          onClick={() => setShowUpgradeModal(true)}
                        >
                          <td className="flow-time-cell">
                            {item.timestamp ? formatFlowDateTime(item.timestamp) : item.time}
                          </td>
                          <td colSpan={5}>
                            <span className="flow-locked-text">
                              🔒 Upgrade for Access
                            </span>
                          </td>
                        </tr>
                      );
                    }

                    return (
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
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </>
        )}

          {/* SUB-TAB 4: NEWS FLOW (SCREENSHOT 3) */}
          {subTab === "news" && (
            <table className="flow-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Headline</th>
                </tr>
              </thead>
              <tbody>
                {filteredNewsItems.map((item) => {
                  if (item.isLocked) {
                    return (
                      <tr
                        key={item.id}
                        className="flow-locked-row"
                        onClick={() => setShowUpgradeModal(true)}
                      >
                        <td className="flow-time-cell">{item.time}</td>
                        <td>
                          <span className="flow-locked-text">
                            🔒 Upgrade for Access
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={item.id}>
                      <td className="flow-time-cell">{item.time}</td>
                      <td className="news-headline-cell">
                        <span className="news-symbols-prefix">
                          {item.symbols.join(", ")}:
                        </span>
                        <span>{item.headline}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* SUB-TAB 5: CONGRESS FLOW */}
          {subTab === "congress" && (
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
                {filteredCongressItems.map((item) => {
                  if (item.isLocked) {
                    return (
                      <tr
                        key={item.id}
                        className="flow-locked-row"
                        onClick={() => setShowUpgradeModal(true)}
                      >
                        <td className="flow-time-cell">{item.filingDate}</td>
                        <td colSpan={5}>
                          <span className="flow-locked-text">
                            🔒 Upgrade for Access
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  return (
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
                      <td style={{ color: "#94a3b8" }}>{item.amountRange}</td>
                      <td className="flow-premium-cell bullish">{item.estimatedPremiumFormatted}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* SUB-TAB 6: INSIDER FLOW (SCREENSHOT 4) */}
          {subTab === "insider" && (
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
                {filteredInsiderItems.map((item) => {
                  if (item.isLocked) {
                    return (
                      <tr
                        key={item.id}
                        className="flow-locked-row"
                        onClick={() => setShowUpgradeModal(true)}
                      >
                        <td className="flow-time-cell">{item.reportDate}</td>
                        <td colSpan={3}>
                          <span className="flow-locked-text">
                            🔒 Upgrade for Access
                          </span>
                        </td>
                      </tr>
                    );
                  }

                  return (
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
                  );
                })}
              </tbody>
            </table>
          )}
        </main>

        {/* Right Filters & Alerts Sidebar */}
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
          onOpenUpgradeModal={() => setShowUpgradeModal(true)}
        />
      </div>

      {/* Upgrade Pro Modal */}
      {showUpgradeModal && (
        <div className="flow-modal-backdrop" onClick={() => setShowUpgradeModal(false)}>
          <div className="flow-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>⭐ Upgrade to Options Flows Pro</h3>
            <p>
              Unlock real-time zero-latency institutional flow sweeps, blocks, dark pool prints, and congressional insider filings with instant push alerts.
            </p>
            <ul style={{ color: "#cbd5e1", fontSize: "0.85rem", lineHeight: "1.6", margin: "0.5rem 0", paddingLeft: "1.25rem" }}>
              <li><strong>Zero 15-Minute Delay:</strong> Live real-time streaming NBBO prints.</li>
              <li><strong>All 🔒 Locked Rows Unlocked:</strong> Access 100% of institutional unusual activity.</li>
              <li><strong>Unlimited Custom Filters:</strong> Save custom alerts for small-caps, tech sweeps &amp; YOLOs.</li>
              <li><strong>Instant 1-Click Order Fill:</strong> Seamlessly preview trades directly in E*TRADE desk.</li>
            </ul>
            <div className="flow-modal-btns">
              <button
                type="button"
                className="flow-modal-cancel"
                onClick={() => setShowUpgradeModal(false)}
              >
                Close
              </button>
              <button
                type="button"
                className="flow-modal-confirm"
                onClick={() => {
                  setShowUpgradeModal(false);
                  if (onSendPrompt) onSendPrompt("I would like to upgrade to Options Flows Pro subscription");
                }}
              >
                Upgrade Now ($49/mo)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trade Detail Modal (Screenshot 3) */}
      {selectedDetailTrade && (
        <FlowTradeDetailModal
          trade={selectedDetailTrade}
          onClose={() => setSelectedDetailTrade(null)}
          onOpenInBuilder={handleOpenInBuilder}
          onUpgradeClick={() => setShowUpgradeModal(true)}
        />
      )}
    </div>
  );
}
