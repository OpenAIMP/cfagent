/**
 * Issue #2419 — landing tape polling migration.
 *
 * The landing HTML is rendered by renderLandingPage() and its inline
 * script runs in a real jsdom window here (runScripts: "dangerously"),
 * with a stubbed WebSocket and fetch, so the tests drive the actual
 * shipped script rather than a re-implementation of it. Tiny injected
 * config values keep real-timer waits short.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { renderLandingPage } from "../src/client/landing";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  readyState = 0;
  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setVisibility(dom: JSDOM, state: "visible" | "hidden") {
  Object.defineProperty(dom.window.document, "visibilityState", {
    value: state,
    configurable: true,
  });
  dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
}

describe("landing tape polling migration (#2419)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let doms: JSDOM[];

  beforeEach(() => {
    FakeSocket.instances = [];
    doms = [];
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ quotes: [] }),
    })) as never;
  });

  afterEach(() => {
    for (const dom of doms) dom.window.close();
    vi.restoreAllMocks();
  });

  function buildDom(polling?: Record<string, number>, autoRefresh = true) {
    const dom = new JSDOM(renderLandingPage("Test App", polling), {
      url: "https://agent.openaimp.com/",
      runScripts: "dangerously",
      beforeParse(window: any) {
        window.WebSocket = FakeSocket;
        window.fetch = fetchMock;
        // Issue #2481: the landing feed is gated by the global
        // switch; the #2419 pins below cover ON, and the new
        // OFF test covers the gated behaviour.
        window.localStorage.setItem(
          "cfagent_global_autorefresh_enabled",
          String(autoRefresh),
        );
      },
    });
    doms.push(dom);
    return dom;
  }

  function openSocket(index = 0) {
    const ws = FakeSocket.instances[index];
    expect(ws).toBeDefined();
    ws.open();
    const sub = JSON.parse(ws.sent[0]);
    expect(sub.type).toBe("subscribe");
    return ws;
  }

  it("opens no socket and polls nothing while auto-refresh is OFF (#2481)", async () => {
    buildDom({ quotesRestFallbackMs: 5_000 }, false);
    await sleep(50);
    expect(FakeSocket.instances.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits the injected config, defaulting when absent", () => {
    const html = renderLandingPage("Test App", { quotesRestFallbackMs: 45_000 });
    expect(html).toContain("POLLING_CFG");
    expect(html).toContain("45000");
    expect(renderLandingPage("Test App")).toContain("60000");
  });

  it("reconnects after close and stops polling once live again", async () => {
    buildDom({ quotesRestFallbackMs: 5_000, quotesWsReconnectBaseMs: 10 });
    const ws = openSocket();
    ws.close();
    await sleep(0);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/market/quotes?symbols="));
    // Reconnect fires on the backoff timer and opens a second socket.
    await sleep(100);
    expect(FakeSocket.instances.length).toBe(2);
    const callsAtReconnect = fetchMock.mock.calls.length;
    openSocket(1);
    await sleep(100);
    // Live again: no further REST polls.
    expect(fetchMock.mock.calls.length).toBe(callsAtReconnect);
  });

  it("pauses polling while hidden and resumes on visible", async () => {
    const dom = buildDom({ quotesRestFallbackMs: 5_000, quotesWsReconnectBaseMs: 10 });
    const ws = openSocket();
    setVisibility(dom, "hidden");
    ws.close();
    await sleep(100);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.instances.length).toBe(1);
    setVisibility(dom, "visible");
    await sleep(0);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/market/quotes?symbols="));
  });

  it("polls at the injected fallback interval, not the old 12s", async () => {
    buildDom({ quotesRestFallbackMs: 50, quotesWsReconnectBaseMs: 10_000 });
    const ws = openSocket();
    ws.close();
    await sleep(160);
    // Immediate fetch + interval ticks at 50ms (reconnect is 10s out,
    // so polling is not cut short by a new socket).
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
