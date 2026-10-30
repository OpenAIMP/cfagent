/**
 * Issue #2419 — quotes service reconnect + hidden-pause.
 *
 * The old fallback stranded the tab on REST polling forever after a
 * socket close, with no reconnect attempt and no visibility handling.
 * Tests use the factory with injected socket + fetch + document
 * doubles, mirroring tests/quotes_service_2100.test.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createQuotesService } from "../src/client/quotes/quotesService";

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: string[] = [];
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
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  open() {
    this.onopen?.();
  }
  fail() {
    this.onerror?.();
  }
}

function makeDoc(initial: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as Document["visibilityState"],
    addEventListener: (_event: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_event: string, fn: () => void) => listeners.delete(fn),
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state as Document["visibilityState"];
      for (const fn of listeners) fn();
    },
  };
  return doc;
}

describe("quotes service reconnect + hidden-pause (#2419)", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const doc = makeDoc();
    const fetchQuotes = vi.fn(async (_symbols: string[]) => ({ quotes: [] as never[] }));
    const service = createQuotesService({
      createSocket: (url: string) => new FakeSocket(url) as never,
      fetchQuotes: fetchQuotes as never,
      pollMs: 1000,
      reconnectBaseMs: 100,
      reconnectCapMs: 400,
      doc: doc as never,
    });
    return { service, fetchQuotes, doc };
  }

  it("reconnects after close and stops polling once live again", async () => {
    const { service, fetchQuotes } = setup();
    service.subscribe(["SPY"], () => {});
    const ws1 = FakeSocket.instances[0];
    ws1.open();
    ws1.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchQuotes).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].open();
    const calls = fetchQuotes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchQuotes.mock.calls.length).toBe(calls);
  });

  it("backs off exponentially up to the cap", async () => {
    const { service } = setup();
    service.subscribe(["SPY"], () => {});
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].close();
    await vi.advanceTimersByTimeAsync(150);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2].close();
    await vi.advanceTimersByTimeAsync(399);
    expect(FakeSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("pauses polling while hidden and resumes on visible", async () => {
    const { service, fetchQuotes, doc } = setup();
    service.subscribe(["SPY"], () => {});
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterClose = fetchQuotes.mock.calls.length;
    expect(callsAfterClose).toBeGreaterThan(0);
    doc.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchQuotes.mock.calls.length).toBe(callsAfterClose);
    expect(FakeSocket.instances).toHaveLength(1);
    doc.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(fetchQuotes.mock.calls.length).toBeGreaterThan(callsAfterClose);
  });

  it("stops reconnect attempts when the last subscriber leaves", async () => {
    const { service } = setup();
    const unsub = service.subscribe(["SPY"], () => {});
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].close();
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
