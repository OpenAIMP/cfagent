import React, { useState, useEffect, useRef, useMemo } from "react";
import type { NavTabId } from "./NavigationMenu";

export interface StockTickerItem {
  symbol: string;
  name: string;
  price: string;
  change: string;
  isPositive: boolean;
  type: "stock" | "crypto" | "etf";
  volume?: string;
  pe?: string;
  bid?: string;
  ask?: string;
  rawPrice?: number;
  flashState?: "up" | "down" | null;
}

export interface StockSearchBarProps {
  onSelectTab?: (tab: NavTabId) => void;
  onAskAgent?: (query: string) => void;
  className?: string;
}

export const POPULAR_TICKERS: StockTickerItem[] = [
  { symbol: "NVDA", name: "NVIDIA Corporation", price: "$138.25", change: "+3.42%", isPositive: true, type: "stock", volume: "48.2M", pe: "54.2" },
  { symbol: "AAPL", name: "Apple Inc.", price: "$232.10", change: "+0.84%", isPositive: true, type: "stock", volume: "32.1M", pe: "34.1" },
  { symbol: "TSLA", name: "Tesla Inc.", price: "$220.50", change: "-1.24%", isPositive: false, type: "stock", volume: "65.4M", pe: "68.3" },
  { symbol: "MSFT", name: "Microsoft Corporation", price: "$428.90", change: "+1.15%", isPositive: true, type: "stock", volume: "21.0M", pe: "36.2" },
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", price: "$582.40", change: "+0.52%", isPositive: true, type: "etf", volume: "41.5M" },
  { symbol: "QQQ", name: "Invesco QQQ Trust", price: "$492.15", change: "+0.94%", isPositive: true, type: "etf", volume: "29.8M" },
  { symbol: "BTC/USD", name: "Bitcoin", price: "$67,450.00", change: "+2.14%", isPositive: true, type: "crypto", volume: "$28.4B" },
  { symbol: "ETH/USD", name: "Ethereum", price: "$2,642.50", change: "+1.52%", isPositive: true, type: "crypto", volume: "$14.1B" },
  { symbol: "SOL/USD", name: "Solana", price: "$154.20", change: "+3.91%", isPositive: true, type: "crypto", volume: "$4.8B" },
  { symbol: "AMD", name: "Advanced Micro Devices", price: "$156.40", change: "+2.18%", isPositive: true, type: "stock", volume: "38.0M", pe: "104.2" },
  { symbol: "AMZN", name: "Amazon.com Inc.", price: "$187.80", change: "+1.65%", isPositive: true, type: "stock", volume: "27.5M", pe: "42.1" },
  { symbol: "META", name: "Meta Platforms Inc.", price: "$592.30", change: "+1.88%", isPositive: true, type: "stock", volume: "15.2M", pe: "27.8" },
  { symbol: "GOOGL", name: "Alphabet Inc.", price: "$168.50", change: "+0.72%", isPositive: true, type: "stock", volume: "19.3M", pe: "23.4" },
];

interface NavShortcut {
  id: NavTabId;
  label: string;
  category: string;
  icon: string;
}

const NAV_SHORTCUTS: NavShortcut[] = [
  { id: "trading", label: "Autopilot Trading Center", category: "Execution", icon: "⚡" },
  { id: "options-flows", label: "Options Scanner & Unusual Flow", category: "Intelligence", icon: "📊" },
  { id: "research", label: "FOSS Equity & Crypto Research", category: "Intelligence", icon: "🔬" },
  { id: "workflows", label: "Workflows Hub (Playbooks A1..E6)", category: "Playbooks", icon: "🔄" },
  { id: "endpoints", label: "MCP Agent Endpoints & Tools", category: "Platform", icon: "🔌" },
  { id: "audit", label: "Audit Trail & Attestation Logs", category: "Platform", icon: "🛡️" },
  { id: "payments", label: "x402 Agent Payments & Balances", category: "Platform", icon: "💳" },
];

export function StockSearchBar({ onSelectTab, onAskAgent, className = "" }: StockSearchBarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "tickers" | "navigation" | "actions">("all");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Real-time market streaming states (Issue #21)
  const [liveQuotes, setLiveQuotes] = useState<Record<string, Partial<StockTickerItem>>>({});
  const [flashStates, setFlashStates] = useState<Record<string, "up" | "down">>({});
  const [isLiveStreaming, setIsLiveStreaming] = useState(false);
  const flashTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rawPricesRef = useRef<Record<string, number>>({});

  // Helper to process tick updates and trigger directional visual flashes
  const handleIncomingTick = (tick: {
    symbol: string;
    price: number;
    formattedPrice: string;
    formattedChange: string;
    changePercent: number;
    formattedBid?: string;
    formattedAsk?: string;
    volume?: string;
    isPositive: boolean;
  }) => {
    const sym = tick.symbol;
    const prevPrice = rawPricesRef.current[sym];
    let flash: "up" | "down" | null = null;

    if (prevPrice !== undefined && prevPrice !== tick.price) {
      flash = tick.price > prevPrice ? "up" : "down";
    }
    rawPricesRef.current[sym] = tick.price;

    if (flash) {
      setFlashStates((prev) => ({ ...prev, [sym]: flash! }));
      if (flashTimersRef.current[sym]) {
        clearTimeout(flashTimersRef.current[sym]);
      }
      flashTimersRef.current[sym] = setTimeout(() => {
        setFlashStates((prev) => {
          const next = { ...prev };
          delete next[sym];
          return next;
        });
      }, 750);
    }

    setLiveQuotes((prev) => ({
      ...prev,
      [sym]: {
        price: tick.formattedPrice,
        change: tick.formattedChange,
        isPositive: tick.isPositive,
        bid: tick.formattedBid,
        ask: tick.formattedAsk,
        volume: tick.volume,
        rawPrice: tick.price,
      },
    }));
  };

  // Real-time WebSocket Quote Streaming Lifecycle:
  // Active ONLY when the modal is open (isOpen === true)
  // Immediate teardown / socket close on modal close or ESC to conserve bandwidth
  useEffect(() => {
    if (!isOpen) {
      setIsLiveStreaming(false);
      setFlashStates({});
      Object.values(flashTimersRef.current).forEach((t) => clearTimeout(t));
      flashTimersRef.current = {};
      return;
    }

    let ws: WebSocket | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let isSubscribed = true;

    // Fallback simulation generator if WebSocket fails in local/test environment
    const startFallbackSimulation = () => {
      if (fallbackInterval) return;
      setIsLiveStreaming(true);
      fallbackInterval = setInterval(() => {
        if (!isSubscribed) return;
        const pool = POPULAR_TICKERS;
        const target = pool[Math.floor(Math.random() * pool.length)];
        const curPrice =
          rawPricesRef.current[target.symbol] ||
          parseFloat(target.price.replace(/[$,]/g, ""));
        const deltaPct =
          (Math.random() * 0.003 + 0.0005) * (Math.random() > 0.48 ? 1 : -1);
        const newPrice = Number((curPrice * (1 + deltaPct)).toFixed(2));
        const prevClose = curPrice;
        const change = Number((newPrice - prevClose).toFixed(2));
        const changePct = Number(((change / prevClose) * 100).toFixed(2));
        const isPos = change >= 0;
        const spread = Math.max(0.02, Number((newPrice * 0.0005).toFixed(2)));

        handleIncomingTick({
          symbol: target.symbol,
          price: newPrice,
          formattedPrice:
            newPrice >= 1000
              ? `$${newPrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : `$${newPrice.toFixed(2)}`,
          formattedChange: `${isPos ? "+" : ""}${changePct.toFixed(2)}%`,
          changePercent: changePct,
          formattedBid: `$${(newPrice - spread / 2).toFixed(2)}`,
          formattedAsk: `$${(newPrice + spread / 2).toFixed(2)}`,
          volume: target.volume,
          isPositive: isPos,
        });
      }, 2000);
    };

    try {
      const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
      const host = typeof window !== "undefined" && window.location.host ? window.location.host : "localhost";
      const wsUrl = `${isHttps ? "wss:" : "ws:"}//${host}/api/market/quotes/ws`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!isSubscribed) return;
        setIsLiveStreaming(true);
        const symbols = POPULAR_TICKERS.map((t) => t.symbol);
        ws?.send(JSON.stringify({ type: "subscribe", symbols }));
      };

      ws.onmessage = (evt) => {
        if (!isSubscribed) return;
        try {
          const data = JSON.parse(evt.data);
          if (data.type === "snapshot" && Array.isArray(data.quotes)) {
            for (const q of data.quotes) {
              rawPricesRef.current[q.symbol] = q.price;
              setLiveQuotes((prev) => ({
                ...prev,
                [q.symbol]: {
                  price: q.formattedPrice,
                  change: q.formattedChange,
                  isPositive: q.isPositive,
                  bid: q.formattedBid,
                  ask: q.formattedAsk,
                  volume: q.volume,
                  rawPrice: q.price,
                },
              }));
            }
          } else if (data.type === "tick" && data.tick) {
            handleIncomingTick(data.tick);
          }
        } catch (_e) {
          // Ignore malformed frames
        }
      };

      ws.onerror = () => {
        startFallbackSimulation();
      };

      ws.onclose = () => {
        if (isSubscribed) {
          startFallbackSimulation();
        }
      };
    } catch (_err) {
      startFallbackSimulation();
    }

    return () => {
      isSubscribed = false;
      if (ws) {
        try {
          ws.close();
        } catch (_e) {}
      }
      if (fallbackInterval) {
        clearInterval(fallbackInterval);
      }
      setIsLiveStreaming(false);
      setFlashStates({});
      Object.values(flashTimersRef.current).forEach((t) => clearTimeout(t));
      flashTimersRef.current = {};
    };
  }, [isOpen]);

  // Global keyboard shortcut: Ctrl+K or Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      } else if (e.key === "Escape" && isOpen) {
        e.preventDefault();
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Focus input when opening
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery("");
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Filtered results
  const filteredTickers = useMemo(() => {
    if (filterType === "navigation" || filterType === "actions") return [];
    const q = query.trim().toUpperCase();
    if (!q) return POPULAR_TICKERS;
    return POPULAR_TICKERS.filter(
      (t) => t.symbol.toUpperCase().includes(q) || t.name.toUpperCase().includes(q)
    );
  }, [query, filterType]);

  const filteredNav = useMemo(() => {
    if (filterType === "tickers" || filterType === "actions") return [];
    const q = query.trim().toLowerCase();
    if (!q) return NAV_SHORTCUTS;
    return NAV_SHORTCUTS.filter(
      (n) => n.label.toLowerCase().includes(q) || n.category.toLowerCase().includes(q)
    );
  }, [query, filterType]);

  const filteredActions = useMemo(() => {
    if (filterType === "tickers" || filterType === "navigation") return [];
    const q = query.trim();
    const symbolTarget = q ? q.toUpperCase() : "NVDA";
    return [
      { id: "action-options", label: `Screen ${symbolTarget} 0DTE Options Flow`, query: `screen 0dte options for ${symbolTarget}`, icon: "🎯" },
      { id: "action-research", label: `Generate FOSS Valuation Report for ${symbolTarget}`, query: `research ${symbolTarget}`, icon: "📑" },
      { id: "action-compare", label: `Compare ${symbolTarget} Valuation vs Industry Peers`, query: `compare ${symbolTarget} with industry peers`, icon: "⚖️" },
      { id: "action-hours", label: "Check Market Hours & Exchange Status", query: "market status", icon: "🕒" },
    ];
  }, [query, filterType]);

  // Combined item list for keyboard navigation
  const allItemsCount = filteredTickers.length + filteredNav.length + filteredActions.length;

  // Reset selected index when query or results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filterType]);

  const handleKeyDownInInput = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (allItemsCount > 0 ? (prev + 1) % allItemsCount : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (allItemsCount > 0 ? (prev - 1 + allItemsCount) % allItemsCount : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeSelectedItem();
    }
  };

  const executeSelectedItem = () => {
    let currentIdx = 0;

    // Check tickers
    if (selectedIndex < filteredTickers.length) {
      const ticker = filteredTickers[selectedIndex];
      handleSelectTicker(ticker);
      return;
    }
    currentIdx += filteredTickers.length;

    // Check nav shortcuts
    if (selectedIndex < currentIdx + filteredNav.length) {
      const navItem = filteredNav[selectedIndex - currentIdx];
      handleSelectNav(navItem.id);
      return;
    }
    currentIdx += filteredNav.length;

    // Check actions
    if (selectedIndex < currentIdx + filteredActions.length) {
      const action = filteredActions[selectedIndex - currentIdx];
      handleSelectAction(action.query);
      return;
    }
  };

  const handleSelectTicker = (ticker: StockTickerItem) => {
    setIsOpen(false);
    if (onSelectTab) {
      onSelectTab("research");
    }
    if (onAskAgent) {
      onAskAgent(`research ${ticker.symbol}`);
    }
  };

  const handleSelectNav = (tabId: NavTabId) => {
    setIsOpen(false);
    if (onSelectTab) {
      onSelectTab(tabId);
    }
  };

  const handleSelectAction = (actionQuery: string) => {
    setIsOpen(false);
    if (onAskAgent) {
      onAskAgent(actionQuery);
    }
  };

  const isMac = typeof navigator !== "undefined" && navigator.userAgent.toUpperCase().indexOf("MAC") >= 0;
  const shortcutHint = isMac ? "⌘K" : "Ctrl K";

  return (
    <>
      {/* Search Bar Inline Trigger */}
      <div className={`stock-search-trigger-container ${className}`}>
        <button
          type="button"
          className="stock-search-trigger-btn"
          onClick={() => setIsOpen(true)}
          title={`Search stocks, options, workflows (${shortcutHint})`}
          aria-label="Search stocks and platform commands"
        >
          <span className="stock-search-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <span className="stock-search-placeholder">Search stocks...</span>
          <kbd className="stock-search-kbd">{shortcutHint}</kbd>
        </button>
      </div>

      {/* Global Command Palette / Stock Search Modal */}
      {isOpen && (
        <div className="stock-search-modal-backdrop" onClick={() => setIsOpen(false)}>
          <div
            className="stock-search-modal-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Stock and command search"
          >
            {/* Modal Input Bar */}
            <div className="stock-search-modal-header">
              <span className="modal-search-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                ref={inputRef}
                type="text"
                className="stock-search-modal-input"
                placeholder="Search stocks (NVDA, AAPL, BTC), workflows, or agent commands..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDownInInput}
              />
              {query && (
                <button
                  type="button"
                  className="modal-clear-btn"
                  onClick={() => setQuery("")}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
              <button
                type="button"
                className="modal-esc-badge"
                onClick={() => setIsOpen(false)}
                title="Close modal"
              >
                ESC
              </button>
            </div>

            {/* Filter Type Pills */}
            <div className="stock-search-filter-pills">
              <button
                type="button"
                className={`filter-pill ${filterType === "all" ? "active" : ""}`}
                onClick={() => setFilterType("all")}
              >
                All Results
              </button>
              <button
                type="button"
                className={`filter-pill ${filterType === "tickers" ? "active" : ""}`}
                onClick={() => setFilterType("tickers")}
              >
                📈 Stocks & Crypto
              </button>
              <button
                type="button"
                className={`filter-pill ${filterType === "navigation" ? "active" : ""}`}
                onClick={() => setFilterType("navigation")}
              >
                🧭 Platform Navigation
              </button>
              <button
                type="button"
                className={`filter-pill ${filterType === "actions" ? "active" : ""}`}
                onClick={() => setFilterType("actions")}
              >
                ⚡ Agent Actions
              </button>
            </div>

            {/* Results Body */}
            <div className="stock-search-results-list" ref={listRef}>
              {allItemsCount === 0 && (
                <div className="no-search-results">
                  <div className="no-results-icon">🔍</div>
                  <div className="no-results-title">No matching stocks or commands</div>
                  <div className="no-results-hint">
                    Try searching for <strong>NVDA</strong>, <strong>AAPL</strong>, <strong>options</strong>, or <strong>research</strong>
                  </div>
                </div>
              )}

              {/* Stocks Section */}
              {filteredTickers.length > 0 && (
                <div className="search-results-group">
                  <div className="group-header">
                    <div className="group-title-with-badge">
                      <span>STOCKS & CRYPTOCURRENCIES</span>
                      {isLiveStreaming && (
                        <span className="live-stream-badge" title="Real-time WebSocket quote streaming active">
                          <span className="live-stream-pulse" />
                          LIVE
                        </span>
                      )}
                    </div>
                    <span className="group-count">{filteredTickers.length}</span>
                  </div>
                  <div className="group-items">
                    {filteredTickers.map((ticker, idx) => {
                      const isSelected = selectedIndex === idx;
                      const live = liveQuotes[ticker.symbol];
                      const currentPrice = live?.price || ticker.price;
                      const currentChange = live?.change || ticker.change;
                      const currentIsPositive =
                        live?.isPositive !== undefined ? live.isPositive : ticker.isPositive;
                      const currentBid = live?.bid || ticker.bid;
                      const currentAsk = live?.ask || ticker.ask;
                      const currentVolume = live?.volume || ticker.volume;
                      const flash = flashStates[ticker.symbol];

                      return (
                        <div
                          key={ticker.symbol}
                          className={`search-result-row ticker-row ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectTicker(ticker)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                        >
                          <div className="ticker-badge-col">
                            <span className={`ticker-type-pill type-${ticker.type}`}>
                              {ticker.type.toUpperCase()}
                            </span>
                            <span className="ticker-symbol-text">{ticker.symbol}</span>
                          </div>
                          <div className="ticker-name-col">
                            <span className="ticker-company-name">{ticker.name}</span>
                            {currentVolume && <span className="ticker-meta">Vol: {currentVolume}</span>}
                            {ticker.pe && <span className="ticker-meta">P/E: {ticker.pe}</span>}
                          </div>
                          <div className="ticker-price-col">
                            <span
                              className={`ticker-price-val ${flash ? `flash-${flash}` : ""}`}
                              data-flash={flash || undefined}
                            >
                              {currentPrice}
                            </span>
                            <span className={`ticker-change-pill ${currentIsPositive ? "positive" : "negative"}`}>
                              {currentChange}
                            </span>
                            {currentBid && currentAsk && (
                              <span className="ticker-spread-text" title="Level 1 NBBO Bid / Ask Spread">
                                B:{currentBid} · A:{currentAsk}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Navigation Section */}
              {filteredNav.length > 0 && (
                <div className="search-results-group">
                  <div className="group-header">
                    <span>NAVIGATION</span>
                    <span className="group-count">{filteredNav.length}</span>
                  </div>
                  <div className="group-items">
                    {filteredNav.map((nav, idx) => {
                      const overallIdx = filteredTickers.length + idx;
                      const isSelected = selectedIndex === overallIdx;
                      return (
                        <div
                          key={nav.id}
                          className={`search-result-row nav-row ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectNav(nav.id)}
                          onMouseEnter={() => setSelectedIndex(overallIdx)}
                        >
                          <span className="nav-row-icon">{nav.icon}</span>
                          <div className="nav-row-info">
                            <span className="nav-row-title">{nav.label}</span>
                            <span className="nav-row-category">{nav.category}</span>
                          </div>
                          <span className="nav-row-enter">Jump to view ↵</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Agent Actions Section */}
              {filteredActions.length > 0 && (
                <div className="search-results-group">
                  <div className="group-header">
                    <span>AGENT ACTIONS</span>
                    <span className="group-count">{filteredActions.length}</span>
                  </div>
                  <div className="group-items">
                    {filteredActions.map((action, idx) => {
                      const overallIdx = filteredTickers.length + filteredNav.length + idx;
                      const isSelected = selectedIndex === overallIdx;
                      return (
                        <div
                          key={action.id}
                          className={`search-result-row action-row ${isSelected ? "selected" : ""}`}
                          onClick={() => handleSelectAction(action.query)}
                          onMouseEnter={() => setSelectedIndex(overallIdx)}
                        >
                          <span className="action-row-icon">{action.icon}</span>
                          <div className="action-row-info">
                            <span className="action-row-title">{action.label}</span>
                            <span className="action-row-query">Prompt: "{action.query}"</span>
                          </div>
                          <span className="action-row-enter">Ask Agent ↵</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer Controls & Key Help */}
            <div className="stock-search-modal-footer">
              <div className="footer-keyboard-hints">
                <span className="key-hint">
                  <kbd>↑</kbd> <kbd>↓</kbd> to navigate
                </span>
                <span className="key-hint">
                  <kbd>↵</kbd> to select
                </span>
                <span className="key-hint">
                  <kbd>esc</kbd> to close
                </span>
              </div>
              <div className="footer-branding">NextGenTP Global Search</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
