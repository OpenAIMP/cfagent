import React, { useState, useEffect, useRef } from "react";
import type { NavTabId } from "./NavigationMenu";

export interface TickerTapeQuote {
  symbol: string;
  name?: string;
  price: string;
  change: string;
  isPositive: boolean;
  type?: "stock" | "crypto" | "etf";
  rawPrice?: number;
}

export interface MarketTickerTapeProps {
  onSelectSymbol?: (symbol: string) => void;
  onSelectTab?: (tab: NavTabId) => void;
  className?: string;
}

const DEFAULT_TICKERS: TickerTapeQuote[] = [
  { symbol: "SPY", price: "$582.40", change: "+0.52%", isPositive: true, type: "etf" },
  { symbol: "QQQ", price: "$492.15", change: "+0.94%", isPositive: true, type: "etf" },
  { symbol: "DIA", price: "$428.10", change: "+0.26%", isPositive: true, type: "etf" },
  { symbol: "NVDA", price: "$138.25", change: "+3.42%", isPositive: true, type: "stock" },
  { symbol: "AAPL", price: "$232.10", change: "+0.84%", isPositive: true, type: "stock" },
  { symbol: "MSFT", price: "$428.90", change: "+1.15%", isPositive: true, type: "stock" },
  { symbol: "TSLA", price: "$220.50", change: "-1.24%", isPositive: false, type: "stock" },
  { symbol: "BTC/USD", price: "$67,450.00", change: "+2.14%", isPositive: true, type: "crypto" },
  { symbol: "ETH/USD", price: "$2,642.50", change: "+1.52%", isPositive: true, type: "crypto" },
  { symbol: "SOL/USD", price: "$154.20", change: "+3.91%", isPositive: true, type: "crypto" },
];

export function MarketTickerTape({ onSelectSymbol, onSelectTab, className = "" }: MarketTickerTapeProps) {
  const [quotes, setQuotes] = useState<Record<string, TickerTapeQuote>>(() => {
    const init: Record<string, TickerTapeQuote> = {};
    for (const t of DEFAULT_TICKERS) {
      init[t.symbol] = t;
    }
    return init;
  });

  const [flashStates, setFlashStates] = useState<Record<string, "up" | "down">>({});
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const rawPricesRef = useRef<Record<string, number>>({});
  const flashTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handleUpdate = (q: {
    symbol: string;
    price: number;
    formattedPrice: string;
    formattedChange: string;
    changePercent: number;
    isPositive: boolean;
    type?: "stock" | "crypto" | "etf";
  }) => {
    const sym = q.symbol;
    const prev = rawPricesRef.current[sym];
    let flash: "up" | "down" | null = null;
    if (prev !== undefined && prev !== q.price) {
      flash = q.price > prev ? "up" : "down";
    }
    rawPricesRef.current[sym] = q.price;

    if (flash) {
      setFlashStates((f) => ({ ...f, [sym]: flash! }));
      if (flashTimersRef.current[sym]) clearTimeout(flashTimersRef.current[sym]);
      flashTimersRef.current[sym] = setTimeout(() => {
        setFlashStates((f) => {
          const next = { ...f };
          delete next[sym];
          return next;
        });
      }, 800);
    }

    setQuotes((prevMap) => ({
      ...prevMap,
      [sym]: {
        symbol: sym,
        price: q.formattedPrice,
        change: q.formattedChange,
        isPositive: q.isPositive,
        type: q.type,
        rawPrice: q.price,
      },
    }));
  };

  useEffect(() => {
    let ws: WebSocket | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let isSubscribed = true;

    const fetchLiveQuotes = async () => {
      if (!isSubscribed) return;
      try {
        const syms = DEFAULT_TICKERS.map((t) => t.symbol).join(",");
        const res = await fetch(`/api/market/quotes?symbols=${encodeURIComponent(syms)}`);
        if (res.ok) {
          const data = (await res.json()) as any;
          if (Array.isArray(data?.quotes)) {
            setIsLiveConnected(true);
            for (const item of data.quotes) {
              if (item && item.symbol) {
                handleUpdate(item);
              }
            }
          }
        }
      } catch {
        // Retain baseline
      }
    };

    // Immediate initial sync
    fetchLiveQuotes();

    const startPolling = () => {
      if (pollInterval) return;
      setIsLiveConnected(true);
      pollInterval = setInterval(fetchLiveQuotes, 12000);
    };

    try {
      const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
      const host = typeof window !== "undefined" && window.location.host ? window.location.host : "localhost";
      const wsUrl = `${isHttps ? "wss:" : "ws:"}//${host}/api/market/quotes/ws`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!isSubscribed) return;
        setIsLiveConnected(true);
        const symbols = DEFAULT_TICKERS.map((t) => t.symbol);
        ws?.send(JSON.stringify({ type: "subscribe", symbols }));
      };

      ws.onmessage = (evt) => {
        if (!isSubscribed) return;
        try {
          const data = JSON.parse(evt.data);
          if (data.type === "snapshot" && Array.isArray(data.quotes)) {
            for (const q of data.quotes) {
              handleUpdate(q);
            }
          } else if (data.type === "tick" && data.tick) {
            handleUpdate(data.tick);
          }
        } catch {
          // Ignore
        }
      };

      ws.onerror = () => {
        startPolling();
      };

      ws.onclose = () => {
        if (isSubscribed) {
          startPolling();
        }
      };
    } catch {
      startPolling();
    }

    return () => {
      isSubscribed = false;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      if (pollInterval) clearInterval(pollInterval);
      Object.values(flashTimersRef.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  const handleClickItem = (sym: string) => {
    if (onSelectSymbol) {
      onSelectSymbol(sym);
    } else if (onSelectTab) {
      onSelectTab("autopilot");
    }
  };

  return (
    <div
      className={`market-ticker-tape ${className}`}
      role="region"
      aria-label="Real-Time Market Ticker"
    >
      {/* Feed Status Indicator */}
      <div className="ticker-tape-feed-badge" title="Live Level 1 streaming quotes from Yahoo Finance & Alpaca APIs">
        <span className={`ticker-live-dot ${isLiveConnected ? "live" : "syncing"}`} />
        <span className="ticker-live-text">REAL-TIME TICKER</span>
      </div>

      {/* Scrolling / Chips Strip */}
      <div className="ticker-tape-chips-track">
        {DEFAULT_TICKERS.map((base) => {
          const live = quotes[base.symbol] || base;
          const flash = flashStates[base.symbol];
          return (
            <button
              key={base.symbol}
              type="button"
              className={`ticker-tape-chip ${flash ? `flash-${flash}` : ""}`}
              onClick={() => handleClickItem(base.symbol)}
              title={`${base.symbol}: ${live.price} (${live.change}) — click to inspect or trade`}
            >
              <span className="chip-symbol">{base.symbol}</span>
              <span className="chip-price">{live.price}</span>
              <span className={`chip-change ${live.isPositive ? "up" : "down"}`}>
                {live.change}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
