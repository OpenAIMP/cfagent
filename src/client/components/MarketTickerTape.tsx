import React, { useState, useEffect, useRef } from "react";
import type { NavTabId } from "./NavigationMenu";
import { Button } from "./ui";

export interface TickerTapeQuote {
  symbol: string;
  name?: string;
  price: string;
  change: string;
  isPositive: boolean;
  type?: "stock" | "crypto" | "etf";
  rawPrice?: number;
  source?: "Alpaca" | "Yahoo Finance" | "Reference";
  timestamp?: number;
}

export interface MarketTickerTapeProps {
  onSelectSymbol?: (symbol: string) => void;
  onSelectTab?: (tab: NavTabId) => void;
  className?: string;
}

const DEFAULT_TICKERS: TickerTapeQuote[] = [
  { symbol: "SPY", price: "—", change: "—", isPositive: true, type: "etf" },
  { symbol: "QQQ", price: "—", change: "—", isPositive: true, type: "etf" },
  { symbol: "DIA", price: "—", change: "—", isPositive: true, type: "etf" },
  { symbol: "NVDA", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "AAPL", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "MSFT", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "TSLA", price: "—", change: "—", isPositive: true, type: "stock" },
  { symbol: "BTC/USD", price: "—", change: "—", isPositive: true, type: "crypto" },
  { symbol: "ETH/USD", price: "—", change: "—", isPositive: true, type: "crypto" },
  { symbol: "SOL/USD", price: "—", change: "—", isPositive: true, type: "crypto" },
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
  const [transport, setTransport] = useState<"connecting" | "websocket" | "polling" | "offline">("connecting");
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
    source?: "Alpaca" | "Yahoo Finance" | "Reference";
    timestamp?: number;
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
        source: q.source,
        timestamp: q.timestamp,
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
            for (const item of data.quotes) {
              if (item && item.symbol) {
                handleUpdate(item);
              }
            }
            if (ws?.readyState !== WebSocket.OPEN) {
              setTransport("polling");
              if (!pollInterval) pollInterval = setInterval(fetchLiveQuotes, 12000);
            }
          }
        }
      } catch {
        if (ws?.readyState !== WebSocket.OPEN) setTransport("offline");
      }
    };

    // Immediate initial sync
    fetchLiveQuotes();

    const startPolling = () => {
      if (pollInterval) return;
      setTransport("polling");
      pollInterval = setInterval(fetchLiveQuotes, 12000);
    };

    try {
      const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
      const host = typeof window !== "undefined" && window.location.host ? window.location.host : "localhost";
      const wsUrl = `${isHttps ? "wss:" : "ws:"}//${host}/api/market/quotes/ws`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!isSubscribed) return;
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        setTransport("websocket");
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
          } else if (data.type === "ticks" && Array.isArray(data.ticks)) {
            for (const tick of data.ticks) handleUpdate(tick);
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

  const providerSources = Array.from(new Set(
    Object.values(quotes).flatMap((quote) =>
      (quote.source === "Alpaca" || quote.source === "Yahoo Finance") &&
      quote.timestamp !== undefined && Date.now() - quote.timestamp < 60000
        ? [quote.source]
        : []
    )
  ));
  const hasReferenceQuotes = Object.values(quotes).some((quote) => quote.source === "Reference");
  const sourceLabel = [...providerSources, ...(hasReferenceQuotes ? ["Reference"] : [])].join(" + ") || "Alpaca / Yahoo Finance";
  const liveSourceAvailable = providerSources.length > 0;
  const feedStatus = liveSourceAvailable ? "live" : transport === "offline" ? "offline" : "syncing";

  const renderTicker = (base: TickerTapeQuote, copy: "primary" | "duplicate") => {
    const live = quotes[base.symbol] || base;
    const flash = flashStates[base.symbol];
    return (
      <Button
        key={`${copy}-${base.symbol}`}
        type="button"
        className={`ticker-tape-chip ${flash ? `flash-${flash}` : ""}`}
        onClick={() => handleClickItem(base.symbol)}
        title={`${base.symbol}: ${live.price} (${live.change}) · ${live.source || "waiting for source"} · click to inspect`}
        tabIndex={copy === "duplicate" ? -1 : undefined}
      >
        <span className="chip-symbol">{base.symbol}</span>
        <span className="chip-price">{live.price}</span>
        <span className={`chip-change ${live.isPositive ? "up" : "down"}`}>
          {live.change}
        </span>
      </Button>
    );
  };

  return (
    <div
      className={`market-ticker-tape ${className}`}
      role="region"
      aria-label="Real-Time Market Ticker"
    >
      {/* Feed Status Indicator */}
      <div className={`ticker-tape-feed-badge ${feedStatus}`} title={`Feed: ${sourceLabel}`}>
        <span className={`ticker-live-dot ${feedStatus}`} />
        <span className="ticker-live-text">{liveSourceAvailable ? "LIVE" : transport === "offline" ? "OFFLINE" : "SYNCING"} · {sourceLabel}</span>
      </div>

      {/* Scrolling / Chips Strip */}
      <div className="ticker-tape-chips-viewport" aria-label="Live market quotes" aria-live="off">
        <div className="ticker-tape-marquee">
          <div className="ticker-tape-sequence">
            {DEFAULT_TICKERS.map((base) => renderTicker(base, "primary"))}
          </div>
          <div className="ticker-tape-sequence" aria-hidden="true">
            {DEFAULT_TICKERS.map((base) => renderTicker(base, "duplicate"))}
          </div>
        </div>
      </div>
    </div>
  );
}
