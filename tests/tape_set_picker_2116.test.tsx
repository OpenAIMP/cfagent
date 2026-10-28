/**
 * @vitest-environment jsdom
 *
 * Issue #2116 — the tape renders the resolved set, not the hardcoded
 * default, and the set picker drives it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MarketTickerTape } from "../src/client/components/MarketTickerTape";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) {}
  send() {}
  close() {
    this.onclose?.();
  }
}

function primarySymbols(container: HTMLElement): string[] {
  const seq = container.querySelectorAll(".ticker-tape-sequence")[0];
  if (!seq) return [];
  return Array.from(seq.querySelectorAll(".chip-symbol")).map((el) => el.textContent ?? "");
}

describe("tape set picker (#2116)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const origWebSocket = (globalThis as any).WebSocket;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as any).WebSocket = FakeSocket;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/market/quotes/source")) {
        return { ok: true, status: 200, json: async () => ({ source: "auto" }) };
      }
      if (url.includes("/api/etrade/watchlist/details")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ watchlistId: 7, name: "Core", symbols: ["NVDA"] }),
        };
      }
      if (url.includes("/api/etrade/watchlists")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            count: 1,
            watchlists: [{ watchlistId: 7, name: "Core", symbols: ["NVDA"] }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ quotes: [] }) };
    }) as never;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    (globalThis as any).WebSocket = origWebSocket;
    globalThis.fetch = origFetch;
    localStorage.clear();
  });

  async function mount() {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(MarketTickerTape));
    });
  }

  function setSelect(label: string, value: string) {
    const select = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    expect(select).not.toBeNull();
    return act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("renders the default set and switches to a preset", async () => {
    await mount();
    expect(primarySymbols(container)).toEqual([
      "SPY",
      "QQQ",
      "DIA",
      "NVDA",
      "AAPL",
      "MSFT",
      "TSLA",
      "BTC/USD",
      "ETH/USD",
      "SOL/USD",
    ]);
    await setSelect("Tape set", "preset:indices");
    expect(primarySymbols(container)).toEqual(["SPY", "QQQ", "DIA"]);
  });

  it("applies a custom list and persists the selection across remount", async () => {
    await mount();
    await setSelect("Tape set", "custom");
    const input = container.querySelector('input[aria-label="Custom symbols"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      // React tracks input values: set through the native setter so
      // onChange fires (a plain .value assignment is swallowed).
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "nvda, aapl");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const apply = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Apply",
    ) as HTMLButtonElement;
    expect(apply).not.toBeUndefined();
    await act(async () => {
      apply.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(primarySymbols(container)).toEqual(["NVDA", "AAPL"]);
    expect(localStorage.getItem("cfagent_tape_symbol_set")).toContain("custom");
    act(() => {
      root!.unmount();
    });
    root = null;
    await mount();
    expect(primarySymbols(container)).toEqual(["NVDA", "AAPL"]);
  });

  it("resolves a watchlist to its symbols", async () => {
    await mount();
    await setSelect("Tape set", "watchlist:7");
    expect(primarySymbols(container)).toEqual(["NVDA"]);
  });
});
