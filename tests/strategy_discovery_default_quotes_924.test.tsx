/** @vitest-environment jsdom */
/**
 * Issue #924 ([#913 S6]): Client DEFAULT_QUOTES — remove hardcoded prices
 * and invented unknown-symbol values.
 *
 * Pins (all must hold on the fixed tree):
 *  - Source: StrategyDiscoveryPanel carries no DEFAULT_QUOTES table, no
 *    POPULAR_TICKERS price table, and none of the hardcoded/invented
 *    price literals (14 preset prices, the 250.0 unknown-symbol price,
 *    the 5000.0/150.0 futures/equity invented prices).
 *  - Source: the panel renders an explicit "Quote unavailable" state.
 *  - Behaviour, quote fetch failing: the panel shows "Quote unavailable"
 *    and NO dollar price for the symbol — never a plausible substitute
 *    price (no $586.20 preset, no $250.00 invented, no $150.00 invented).
 *  - Behaviour, unknown symbol with a failing fetch: same — unavailable,
 *    no invented price.
 *  - Control, quote fetch succeeding: the LIVE price renders and no
 *    unavailable state shows, so the fix removes fakes without breaking
 *    real quotes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StrategyDiscoveryPanel } from "../src/client/options/StrategyDiscoveryPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no Element.scrollIntoView; the panel calls it from centering
// timers. Shim it in the harness (test-only, never product code).
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const PANEL_SRC = readFileSync(
  "src/client/options/StrategyDiscoveryPanel.tsx",
  "utf8"
);

const flush = async (ms = 100) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

const renderPanel = async (initialSymbol: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider><StrategyDiscoveryPanel initialSymbol={initialSymbol} /></ToastProvider>);
  });
  // Effects fire the quote fetch; let every fetch + state update settle.
  await flush();
  await flush();
  await flush();
  return { container, root };
};

const cleanup = (ctx: { container: HTMLDivElement; root: Root }) => {
  act(() => {
    ctx.root.unmount();
  });
  ctx.container.remove();
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const failingFetch = vi.fn(async () =>
  Response.json({ error: "quote unavailable" }, { status: 500 })
);

const liveFetch = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url.includes("/api/market-data/quote")) {
    return Response.json(
      {
        lastPrice: 123.45,
        change: 1.0,
        changePercent: 0.81,
        companyName: "Test Co",
      },
      { status: 200 }
    );
  }
  return Response.json({}, { status: 500 });
});

describe("issue #924 source pins", () => {
  it("carries no DEFAULT_QUOTES table", () => {
    expect(PANEL_SRC).not.toContain("DEFAULT_QUOTES");
  });

  it("carries no hardcoded preset-price table", () => {
    expect(PANEL_SRC).not.toContain("POPULAR_TICKERS");
    // Sample of the 14 preset prices that used to ship as initial state.
    for (const price of ["586.20", "368.44", "138.50", "20420.00", "5875.50"]) {
      expect(PANEL_SRC).not.toContain(price);
    }
  });

  it("carries no invented unknown-symbol prices", () => {
    expect(PANEL_SRC).not.toContain("price: 250.0");
    expect(PANEL_SRC).not.toContain("5000.0");
    expect(PANEL_SRC).not.toContain("price: clean.startsWith");
  });

  it("renders an explicit unavailable state for missing quotes", () => {
    expect(PANEL_SRC).toContain("Quote unavailable");
  });
});

describe("issue #924 behaviour pins", () => {
  it("quote fetch failing: unavailable, never a substitute price", async () => {
    vi.stubGlobal("fetch", failingFetch);
    const ctx = await renderPanel("TSLA");
    try {
      const text = document.body.textContent || "";
      expect(text).toContain("Quote unavailable");
      for (const fake of ["$586.20", "$250.00", "$150.00", "$5,000.00", "$368.44"]) {
        expect(text).not.toContain(fake);
      }
    } finally {
      cleanup(ctx);
    }
  });

  it("unknown symbol with failing fetch: unavailable, never an invented price", async () => {
    vi.stubGlobal("fetch", failingFetch);
    const ctx = await renderPanel("ZZZUNKNOWN");
    try {
      const text = document.body.textContent || "";
      expect(text).toContain("Quote unavailable");
      for (const fake of ["$150.00", "$5,000.00", "$250.00"]) {
        expect(text).not.toContain(fake);
      }
    } finally {
      cleanup(ctx);
    }
  });

  it("control: live quote renders, no unavailable state", async () => {
    vi.stubGlobal("fetch", liveFetch);
    const ctx = await renderPanel("TSLA");
    try {
      const text = document.body.textContent || "";
      expect(text).toContain("$123.45");
      expect(text).not.toContain("Quote unavailable");
    } finally {
      cleanup(ctx);
    }
  });
});
