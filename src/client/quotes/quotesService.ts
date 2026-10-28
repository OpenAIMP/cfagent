/**
 * Issue #2100 — the single quotes feed implementation.
 *
 * One WebSocket to /api/market/quotes/ws, ref-counted symbol
 * subscriptions (the server supports subscribe + unsubscribe deltas),
 * immediate REST fetch on subscribe, REST polling fallback via apiFetch
 * when the socket errors or closes, a quote cache, transport state, and
 * centralized price-direction flash. Every presentation (tape, search
 * bar, later the landing page) consumes this service through
 * useMarketQuotes; none of them owns a socket, a poller, or a fetch.
 */
import { apiFetch } from "../apiFetch";

export type QuoteTransport = "connecting" | "websocket" | "polling" | "offline";

export type FlashDirection = "up" | "down";

export interface ServiceQuote {
  symbol: string;
  price: number;
  formattedPrice: string;
  formattedChange: string;
  changePercent?: number;
  isPositive: boolean;
  type?: "stock" | "crypto" | "etf";
  source?: string;
  timestamp?: number;
  formattedBid?: string;
  formattedAsk?: string;
  volume?: string;
}

export interface QuotesSnapshot {
  quotes: Record<string, ServiceQuote>;
  transport: QuoteTransport;
  flash: Record<string, FlashDirection>;
}

type Listener = (snapshot: QuotesSnapshot) => void;

interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((evt: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export interface QuotesServiceDeps {
  createSocket?: (url: string) => SocketLike;
  fetchQuotes?: (symbols: string[]) => Promise<{ quotes: ServiceQuote[] }>;
  flashMs?: number;
  pollMs?: number;
}

function normalize(symbols: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    const upper = s.toUpperCase().trim();
    if (upper && !seen.has(upper)) {
      seen.add(upper);
      out.push(upper);
    }
  }
  return out;
}

function quotesUrl(): string {
  const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
  const host =
    typeof window !== "undefined" && window.location.host ? window.location.host : "localhost";
  return `${isHttps ? "wss:" : "ws:"}//${host}/api/market/quotes/ws`;
}

async function apiFetchQuotes(symbols: string[]): Promise<{ quotes: ServiceQuote[] }> {
  const res = await apiFetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!res.ok) throw new Error(`Quotes request failed: ${res.status}`);
  const data = (await res.json()) as { quotes?: unknown };
  return { quotes: Array.isArray(data?.quotes) ? (data.quotes as ServiceQuote[]) : [] };
}

export interface QuotesService {
  subscribe(symbols: string[], listener: Listener): () => void;
  getSnapshot(): QuotesSnapshot;
}

export function createQuotesService(deps: QuotesServiceDeps = {}): QuotesService {
  const createSocket = deps.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const fetchQuotes = deps.fetchQuotes ?? apiFetchQuotes;
  const flashMs = deps.flashMs ?? 800;
  const pollMs = deps.pollMs ?? 12000;

  const refCounts = new Map<string, number>();
  const listeners = new Set<Listener>();
  let quotes: Record<string, ServiceQuote> = {};
  let flash: Record<string, FlashDirection> = {};
  const flashTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let transport: QuoteTransport = "offline";
  let socket: SocketLike | null = null;
  let socketOpen = false;
  let fallbackInterval: ReturnType<typeof setInterval> | null = null;
  let fetchInFlight = false;

  function snapshot(): QuotesSnapshot {
    return { quotes: { ...quotes }, transport, flash: { ...flash } };
  }

  function notify() {
    const snap = snapshot();
    for (const listener of listeners) listener(snap);
  }

  function applyQuote(raw: ServiceQuote) {
    if (!raw || !raw.symbol) return;
    const symbol = raw.symbol.toUpperCase().trim();
    const next: ServiceQuote = { ...raw, symbol };
    const prev = quotes[symbol];
    quotes = { ...quotes, [symbol]: next };
    if (prev !== undefined && prev.price !== next.price) {
      const direction: FlashDirection = next.price > prev.price ? "up" : "down";
      flash = { ...flash, [symbol]: direction };
      if (flashTimers[symbol]) clearTimeout(flashTimers[symbol]);
      flashTimers[symbol] = setTimeout(() => {
        const rest = { ...flash };
        delete rest[symbol];
        flash = rest;
        notify();
      }, flashMs);
    }
  }

  async function fetchUnion() {
    const union = Array.from(refCounts.keys());
    if (union.length === 0 || fetchInFlight) return;
    fetchInFlight = true;
    try {
      const data = await fetchQuotes(union);
      if (Array.isArray(data?.quotes)) {
        for (const q of data.quotes) applyQuote(q);
      }
      if (!socketOpen) transport = "polling";
      notify();
    } catch {
      if (!socketOpen) {
        transport = "offline";
        notify();
      }
    } finally {
      fetchInFlight = false;
    }
  }

  function stopFallback() {
    if (fallbackInterval) {
      clearInterval(fallbackInterval);
      fallbackInterval = null;
    }
  }

  function startFallback() {
    if (fallbackInterval || refCounts.size === 0) return;
    void fetchUnion();
    fallbackInterval = setInterval(() => {
      void fetchUnion();
    }, pollMs);
  }

  function sendSubscribe(symbols: string[]) {
    if (socket && socketOpen && symbols.length > 0) {
      socket.send(JSON.stringify({ type: "subscribe", symbols }));
    }
  }

  function ensureSocket() {
    if (socket) return;
    transport = "connecting";
    const ws = createSocket(quotesUrl());
    socket = ws;
    ws.onopen = () => {
      socketOpen = true;
      transport = "websocket";
      stopFallback();
      sendSubscribe(Array.from(refCounts.keys()));
      notify();
    };
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as {
          type?: string;
          quotes?: ServiceQuote[];
          tick?: ServiceQuote;
          ticks?: ServiceQuote[];
        };
        if (data.type === "snapshot" && Array.isArray(data.quotes)) {
          for (const q of data.quotes) applyQuote(q);
        } else if (data.type === "tick" && data.tick) {
          applyQuote(data.tick);
        } else if (data.type === "ticks" && Array.isArray(data.ticks)) {
          for (const q of data.ticks) applyQuote(q);
        }
        notify();
      } catch {
        // Ignore malformed frames, as the components did before.
      }
    };
    ws.onerror = () => {
      // An errored socket never recovers (close follows in browsers, but
      // is not guaranteed); detach so the next subscribe opens a fresh
      // one, and fall back to polling for the current subscribers.
      socketOpen = false;
      socket = null;
      startFallback();
    };
    ws.onclose = () => {
      socketOpen = false;
      socket = null;
      if (refCounts.size > 0) startFallback();
    };
  }

  function subscribe(symbols: string[], listener: Listener): () => void {
    const list = normalize(symbols);
    listeners.add(listener);
    const added: string[] = [];
    for (const symbol of list) {
      const count = (refCounts.get(symbol) ?? 0) + 1;
      refCounts.set(symbol, count);
      if (count === 1) added.push(symbol);
    }
    if (added.length > 0) {
      if (socketOpen) sendSubscribe(added);
      else ensureSocket();
      void fetchUnion();
    }
    listener(snapshot());
    let done = false;
    return () => {
      if (done) return;
      done = true;
      listeners.delete(listener);
      const removed: string[] = [];
      for (const symbol of list) {
        const count = (refCounts.get(symbol) ?? 0) - 1;
        if (count <= 0) {
          refCounts.delete(symbol);
          removed.push(symbol);
        } else {
          refCounts.set(symbol, count);
        }
      }
      if (removed.length > 0 && socket && socketOpen) {
        socket.send(JSON.stringify({ type: "unsubscribe", symbols: removed }));
      }
      if (refCounts.size === 0) {
        stopFallback();
        const ws = socket;
        socket = null;
        socketOpen = false;
        if (ws) ws.close();
        for (const timer of Object.values(flashTimers)) clearTimeout(timer);
        flash = {};
      }
    };
  }

  return {
    subscribe,
    getSnapshot: snapshot,
  };
}

/** The app-wide singleton. Tests use createQuotesService with doubles. */
export const quotesService = createQuotesService();
