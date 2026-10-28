/**
 * Issue #2100 (slice A) — the singleton quotes service.
 *
 * One WebSocket, ref-counted symbol subscriptions, REST fallback via
 * apiFetch. Tests use the factory with injected socket + fetch doubles;
 * the hook and components use the default singleton.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createQuotesService } from "../src/client/quotes/quotesService";

type SentMsg = { type: string; symbols?: string[] };

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: SentMsg[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fail() {
    this.onerror?.();
  }
}

function tick(symbol: string, price: number, extra: Record<string, unknown> = {}) {
  return {
    symbol,
    price,
    formattedPrice: `$${price}`,
    formattedChange: "+0.00%",
    changePercent: 0,
    isPositive: true,
    source: "Yahoo Finance",
    timestamp: Date.now(),
    ...extra,
  };
}

describe("quotes service (#2100)", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const fetchQuotes = vi.fn(async (_symbols: string[]) => ({ quotes: [] as unknown[] }));
    const service = createQuotesService({
      createSocket: (url: string) => new FakeSocket(url) as never,
      fetchQuotes: fetchQuotes as never,
      flashMs: 800,
      pollMs: 12000,
    });
    return { service, fetchQuotes };
  }

  it("opens one socket and subscribes on open", () => {
    const { service } = setup();
    const seen: unknown[] = [];
    service.subscribe(["SPY"], (s) => seen.push(s));
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toContain("/api/market/quotes/ws");
    FakeSocket.instances[0].open();
    expect(FakeSocket.instances[0].sent).toEqual([{ type: "subscribe", symbols: ["SPY"] }]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("delivers snapshot quotes and tracks flash direction on ticks", () => {
    const { service } = setup();
    let latest: ReturnType<typeof service.getSnapshot> | undefined;
    service.subscribe(["NVDA"], (s) => {
      latest = s;
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.message({ type: "snapshot", quotes: [tick("NVDA", 100)] });
    expect(latest!.quotes["NVDA"].price).toBe(100);
    expect(latest!.flash).toEqual({});
    ws.message({ type: "tick", tick: tick("NVDA", 105) });
    expect(latest!.quotes["NVDA"].price).toBe(105);
    expect(latest!.flash).toEqual({ NVDA: "up" });
    ws.message({ type: "tick", tick: tick("NVDA", 102) });
    expect(latest!.flash).toEqual({ NVDA: "down" });
    vi.advanceTimersByTime(800);
    expect(latest!.flash).toEqual({});
  });

  it("ref-counts overlapping subscriptions and closes on last unsubscribe", () => {
    const { service } = setup();
    const unsub1 = service.subscribe(["SPY"], () => {});
    const unsub2 = service.subscribe(["SPY", "NVDA"], () => {});
    const ws = FakeSocket.instances[0];
    ws.open();
    // The socket was still connecting at the second subscribe, so open
    // sends the full union in one message rather than per-subscribe deltas.
    expect(ws.sent).toEqual([{ type: "subscribe", symbols: ["SPY", "NVDA"] }]);
    unsub2();
    expect(ws.sent).toContainEqual({ type: "unsubscribe", symbols: ["NVDA"] });
    expect(ws.closed).toBe(false);
    unsub1();
    expect(ws.sent).toContainEqual({ type: "unsubscribe", symbols: ["SPY"] });
    expect(ws.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("falls back to REST polling when the socket fails", async () => {
    const { service, fetchQuotes } = setup();
    fetchQuotes.mockResolvedValue({ quotes: [tick("SPY", 500)] });
    let latest: ReturnType<typeof service.getSnapshot> | undefined;
    service.subscribe(["SPY"], (s) => {
      latest = s;
    });
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.fail();
    // Flush the immediate REST fetch on fallback entry (no runAllTimers:
    // the polling interval would loop forever under it).
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchQuotes).toHaveBeenCalled();
    expect(latest!.quotes["SPY"].price).toBe(500);
    expect(latest!.transport).toBe("polling");
    const calls = fetchQuotes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12000);
    expect(fetchQuotes.mock.calls.length).toBeGreaterThan(calls);
  });

  it("immediately fetches REST quotes on first subscribe", async () => {
    const { service, fetchQuotes } = setup();
    fetchQuotes.mockResolvedValue({ quotes: [tick("QQQ", 400)] });
    let latest: ReturnType<typeof service.getSnapshot> | undefined;
    service.subscribe(["QQQ"], (s) => {
      latest = s;
    });
    await vi.runAllTimersAsync();
    expect(fetchQuotes).toHaveBeenCalledWith(["QQQ"]);
    expect(latest!.quotes["QQQ"].price).toBe(400);
  });
});
