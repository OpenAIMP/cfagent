/**
 * Issue #2130 (slice E) — the landing tape goes live on the same feed.
 *
 * The landing HTML is rendered by renderLandingPage() and its inline
 * script runs in a real jsdom window here (runScripts: "dangerously"),
 * with a stubbed WebSocket and fetch, so the tests drive the actual
 * shipped script rather than a re-implementation of it.
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
  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

function itemTexts(dom: JSDOM, label: string): { val: string; chg: string; chgClass: string }[] {
  const doc = dom.window.document;
  const out: { val: string; chg: string; chgClass: string }[] = [];
  doc.querySelectorAll(".ticker-item").forEach((item) => {
    const sym = item.querySelector(".ticker-sym")?.textContent?.trim();
    if (sym !== label) return;
    out.push({
      val: item.querySelector(".ticker-val")?.textContent?.trim() ?? "",
      chg: item.querySelector(".ticker-chg")?.textContent?.trim() ?? "",
      chgClass: item.querySelector(".ticker-chg")?.className ?? "",
    });
  });
  return out;
}

describe("landing tape live (#2130)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeSocket.instances = [];
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ quotes: [] }),
    })) as never;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function buildDom() {
    return new JSDOM(renderLandingPage(), {
      url: "https://agent.openaimp.com/",
      runScripts: "dangerously",
      beforeParse(window: any) {
        window.WebSocket = FakeSocket;
        window.fetch = fetchMock;
        // Issue #2481: the landing feed is gated by the global
        // auto-refresh switch; this #2130 pin covers ON, and OFF
        // gating is pinned in polling_landing_2419.
        window.localStorage.setItem(
          "cfagent_global_autorefresh_enabled",
          "true",
        );
      },
    });
  }

  function socket(): FakeSocket {
    expect(FakeSocket.instances.length).toBe(1);
    return FakeSocket.instances[0];
  }

  function openSocket() {
    const ws = socket();
    ws.onopen?.();
    const sub = JSON.parse(ws.sent[0]);
    expect(sub.type).toBe("subscribe");
    expect(sub.symbols).toEqual(
      expect.arrayContaining(["SPY", "QQQ", "DIA", "IWM", "^VIX", "^TNX", "BTC/USD", "ETH/USD"]),
    );
    return ws;
  }

  it("updates both copies of a symbol on a WS tick", () => {
    const dom = buildDom();
    const ws = openSocket();
    expect(itemTexts(dom, "S&P 500")).toHaveLength(2);
    ws.onmessage?.({
      data: JSON.stringify({
        type: "tick",
        tick: { symbol: "SPY", formattedPrice: "5,900.12", formattedChange: "+0.61%", isPositive: true },
      }),
    });
    const after = itemTexts(dom, "S&P 500");
    expect(after).toHaveLength(2);
    for (const item of after) {
      expect(item.val).toBe("5,900.12");
      expect(item.chg).toBe("+0.61%");
      expect(item.chgClass).toContain("gain");
    }
    // Untouched symbols keep their static baseline.
    expect(itemTexts(dom, "NASDAQ 100")[0].val).toBe("18,518.61");
  });

  it("leaves unavailable symbols on their static baseline", () => {
    const dom = buildDom();
    const ws = openSocket();
    ws.onmessage?.({
      data: JSON.stringify({
        type: "snapshot",
        quotes: [
          { symbol: "SPY", formattedPrice: "5,900.12", formattedChange: "+0.61%", isPositive: true },
        ],
        unavailable: ["^VIX"],
      }),
    });
    expect(itemTexts(dom, "S&P 500")[0].val).toBe("5,900.12");
    expect(itemTexts(dom, "CBOE VIX")[0].val).toBe("18.24");
    expect(itemTexts(dom, "CBOE VIX")[0].chg).toBe("-4.10%");
  });

  it("maps all 8 landing labels to feed symbols", () => {
    const dom = buildDom();
    const ws = openSocket();
    ws.onmessage?.({
      data: JSON.stringify({
        type: "ticks",
        ticks: [
          { symbol: "SPY", formattedPrice: "1", formattedChange: "+0.01%", isPositive: true },
          { symbol: "QQQ", formattedPrice: "2", formattedChange: "+0.01%", isPositive: true },
          { symbol: "DIA", formattedPrice: "3", formattedChange: "+0.01%", isPositive: true },
          { symbol: "IWM", formattedPrice: "4", formattedChange: "+0.01%", isPositive: true },
          { symbol: "^VIX", formattedPrice: "5", formattedChange: "+0.01%", isPositive: true },
          { symbol: "^TNX", formattedPrice: "6", formattedChange: "+0.01%", isPositive: true },
          { symbol: "BTC/USD", formattedPrice: "7", formattedChange: "+0.01%", isPositive: true },
          { symbol: "ETH/USD", formattedPrice: "8", formattedChange: "+0.01%", isPositive: true },
        ],
      }),
    });
    expect(itemTexts(dom, "S&P 500")[0].val).toBe("1");
    expect(itemTexts(dom, "NASDAQ 100")[0].val).toBe("2");
    expect(itemTexts(dom, "DOW JONES")[0].val).toBe("3");
    expect(itemTexts(dom, "RUSSELL 2000")[0].val).toBe("4");
    expect(itemTexts(dom, "CBOE VIX")[0].val).toBe("5");
    // The 10Y baseline carries a % sign; the live value keeps it.
    expect(itemTexts(dom, "US 10Y YIELD")[0].val).toBe("6%");
    expect(itemTexts(dom, "BTC / USD")[0].val).toBe("7");
    expect(itemTexts(dom, "ETH / USD")[0].val).toBe("8");
  });

  it("falls back to REST polling when the socket closes", async () => {
    const dom = buildDom();
    const ws = openSocket();
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        quotes: [
          { symbol: "SPY", formattedPrice: "5,901.00", formattedChange: "+0.62%", isPositive: true },
        ],
      }),
    }));
    ws.close();
    // The fallback fetch fires immediately on close; flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/market/quotes?symbols="));
    expect(itemTexts(dom, "S&P 500")[0].val).toBe("5,901.00");
  });
});
