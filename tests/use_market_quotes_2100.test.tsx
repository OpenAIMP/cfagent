/**
 * @vitest-environment jsdom
 *
 * Issue #2100 — the hook wires a component to the singleton service:
 * subscribe on symbols + enabled, render quotes + transport, unsubscribe
 * on unmount. Service logic itself is covered by quotes_service_2100.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useMarketQuotes } from "../src/client/quotes/useMarketQuotes";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  sent: unknown[] = [];
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
}

function Probe({ symbols, enabled }: { symbols: string[]; enabled?: boolean }) {
  const { quotes, transport } = useMarketQuotes(symbols, enabled);
  const quote = quotes["SPY"];
  return React.createElement(
    "div",
    null,
    React.createElement("span", { id: "transport" }, transport),
    React.createElement("span", { id: "price" }, quote ? quote.formattedPrice : "none"),
  );
}

describe("useMarketQuotes (#2100)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const origWebSocket = (globalThis as any).WebSocket;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    FakeSocket.instances = [];
    (globalThis as any).WebSocket = FakeSocket;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ quotes: [] }),
    })) as never;
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
  });

  function renderProbe(props: { symbols: string[]; enabled?: boolean }) {
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(Probe, props));
    });
  }

  it("renders snapshot quotes and closes the socket on unmount", async () => {
    renderProbe({ symbols: ["SPY"] });
    expect(FakeSocket.instances).toHaveLength(1);
    const ws = FakeSocket.instances[0];
    act(() => {
      ws.open();
    });
    expect(container.querySelector("#transport")!.textContent).toBe("websocket");
    act(() => {
      ws.message({
        type: "snapshot",
        quotes: [
          {
            symbol: "SPY",
            price: 500,
            formattedPrice: "$500.00",
            formattedChange: "+0.50%",
            isPositive: true,
          },
        ],
      });
    });
    expect(container.querySelector("#price")!.textContent).toBe("$500.00");
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(ws.closed).toBe(true);
  });

  it("subscribes nothing while disabled", () => {
    renderProbe({ symbols: ["SPY"], enabled: false });
    expect(FakeSocket.instances).toHaveLength(0);
  });
});
