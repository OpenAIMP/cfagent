import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
import { useMarketQuotes } from "../quotes/useMarketQuotes";
import { TAPE_SYMBOLS, type QuoteSymbolMeta } from "../quotes/symbolSets";
import type { NavTabId } from "./NavigationMenu";
import { Button, Select } from "./ui";

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

export function MarketTickerTape({ onSelectSymbol, onSelectTab, className = "" }: MarketTickerTapeProps) {
  // Issue #2100: the feed lifecycle (socket, fallback, flash) lives in
  // the quotes service; the tape only renders what the hook returns.
  const {
    quotes: liveQuotes,
    transport,
    flash: flashStates,
  } = useMarketQuotes(TAPE_SYMBOLS.map((t) => t.symbol));

  const quotes: Record<string, TickerTapeQuote> = {};
  for (const base of TAPE_SYMBOLS) {
    const live = liveQuotes[base.symbol];
    quotes[base.symbol] = live
      ? {
          symbol: base.symbol,
          price: live.formattedPrice,
          change: live.formattedChange,
          isPositive: live.isPositive,
          type: live.type ?? base.type,
          rawPrice: live.price,
          source: live.source as TickerTapeQuote["source"],
          timestamp: live.timestamp,
        }
      : {
          symbol: base.symbol,
          price: base.price ?? "—",
          change: base.change ?? "—",
          isPositive: base.isPositive ?? true,
          type: base.type,
        };
  }

  // Issue #2108: deployment-wide quote source pick. The server decides
  // the source; this control only reads and writes the setting, and the
  // stream reflects the pick on next refresh.
  const [quoteSource, setQuoteSource] = useState<"auto" | "alpaca" | "yahoo">("auto");
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/market/quotes/source")
      .then((res) =>
        res.ok ? (res.json() as Promise<{ source?: unknown }>) : Promise.reject(new Error("source read failed")),
      )
      .then((data) => {
        if (!cancelled && (data?.source === "alpaca" || data?.source === "yahoo")) {
          setQuoteSource(data.source);
        }
      })
      .catch(() => {
        // Unavailable setting surface: keep "auto" (legacy behavior).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleQuoteSourceChange = (next: "auto" | "alpaca" | "yahoo") => {
    const previous = quoteSource;
    setQuoteSource(next);
    apiFetch("/api/market/quotes/source", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: next }),
    })
      .then((res) => {
        if (!res.ok) throw new Error("source write failed");
        return res.json() as Promise<{ source?: unknown }>;
      })
      .then((data) => {
        if (data?.source === "auto" || data?.source === "alpaca" || data?.source === "yahoo") {
          setQuoteSource(data.source);
        }
      })
      .catch(() => {
        // Server-confirmed state only: revert on failure.
        setQuoteSource(previous);
      });
  };

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

  const renderTicker = (base: QuoteSymbolMeta, copy: "primary" | "duplicate") => {
    const live = quotes[base.symbol] ?? {
      symbol: base.symbol,
      price: "—",
      change: "—",
      isPositive: true,
    };
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
        <Select
          aria-label="Quote source"
          size="sm"
          value={quoteSource}
          onChange={(e) => handleQuoteSourceChange(e.target.value as "auto" | "alpaca" | "yahoo")}
        >
          <option value="auto">Auto</option>
          <option value="alpaca">Alpaca</option>
          <option value="yahoo">Yahoo</option>
        </Select>
      </div>

      {/* Scrolling / Chips Strip */}
      <div className="ticker-tape-chips-viewport" aria-label="Live market quotes" aria-live="off">
        <div className="ticker-tape-marquee">
          <div className="ticker-tape-sequence">
            {TAPE_SYMBOLS.map((base) => renderTicker(base, "primary"))}
          </div>
          <div className="ticker-tape-sequence" aria-hidden="true">
            {TAPE_SYMBOLS.map((base) => renderTicker(base, "duplicate"))}
          </div>
        </div>
      </div>
    </div>
  );
}
