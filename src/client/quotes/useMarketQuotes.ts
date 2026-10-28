/**
 * Issue #2100 — the single quotes hook.
 *
 * Presentations call useMarketQuotes(symbols, enabled) and render what
 * it returns. They own no socket, no poller, no fetch, no flash timers.
 */
import { useEffect, useMemo, useState } from "react";
import {
  quotesService,
  type FlashDirection,
  type QuoteTransport,
  type ServiceQuote,
} from "./quotesService";

export type { FlashDirection, QuoteTransport, ServiceQuote };

export interface MarketQuotes {
  quotes: Record<string, ServiceQuote>;
  transport: QuoteTransport;
  isLive: boolean;
  flash: Record<string, FlashDirection>;
}

export function useMarketQuotes(symbols: string[], enabled = true): MarketQuotes {
  const key = useMemo(
    () =>
      symbols
        .map((s) => s.toUpperCase().trim())
        .filter(Boolean)
        .join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbols.join(",")],
  );
  const [snapshot, setSnapshot] = useState(() => quotesService.getSnapshot());

  useEffect(() => {
    if (!enabled) return;
    const list = key.split(",").filter(Boolean);
    if (list.length === 0) return;
    return quotesService.subscribe(list, setSnapshot);
  }, [key, enabled]);

  const list = key.split(",").filter(Boolean);
  const filteredQuotes: Record<string, ServiceQuote> = {};
  const filteredFlash: Record<string, FlashDirection> = {};
  for (const symbol of list) {
    if (snapshot.quotes[symbol]) filteredQuotes[symbol] = snapshot.quotes[symbol];
    if (snapshot.flash[symbol]) filteredFlash[symbol] = snapshot.flash[symbol];
  }
  return {
    quotes: filteredQuotes,
    transport: snapshot.transport,
    isLive: enabled && (snapshot.transport === "websocket" || snapshot.transport === "polling"),
    flash: filteredFlash,
  };
}
