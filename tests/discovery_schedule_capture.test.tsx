/** @vitest-environment jsdom */
/**
 * Issue #126 (PR-G): "Schedule this discovery" in StrategyDiscoveryPanel.
 *
 * The capture snapshots the panel's CURRENT view through the very same
 * builder the interactive run uses (buildStrategyRequest over
 * currentDiscoveryInputs), shows the user exactly what will be
 * scheduled (symbol, thesis, target), and creates a
 * autonomousStrategyDiscovery schedule whose payload is
 * { requests: [that request], environment }.
 *
 * Harness follows tests/scheduled_options_manager.test.ts: the REAL
 * apiFetch driven against a stubbed global fetch. The pin that matters:
 * the created schedule's requests[0] must deep-equal the request body
 * the panel's own interactive discovery call sent on the same inputs —
 * field for field, no re-derivation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StrategyDiscoveryPanel } from "../src/client/options/StrategyDiscoveryPanel";
import { etToUtcCron } from "../src/client/options/cronTime";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no canvas implementation; the Builder chart only needs a
// benign no-op 2d context while this suite exercises the Discovery tab.
const canvasCtxStub = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === "measureText") return () => ({ width: 0 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => ({ addColorStop: () => undefined });
      }
      if (prop === "canvas") return null;
      return () => undefined;
    },
    set: () => true,
  }
);
HTMLCanvasElement.prototype.getContext = (() => canvasCtxStub) as any;

// jsdom does not implement scrollIntoView; the panel centers the active
// expiration chip through it on a timer.
Element.prototype.scrollIntoView = () => undefined;

interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

interface PanelStubState {
  createError?: string;
}

function installFetch(state: PanelStubState = {}) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.startsWith("/api/market-data/quote")) {
      // Issue #924 (pin-rule update in the same PR): the panel no longer
      // falls back to a hardcoded preset when the quote fetch carries no
      // price — an empty quote payload now means "Quote unavailable" and
      // no discovery run. This harness pins schedule capture, not quote
      // failure, so it stubs a realistic LIVE quote; the unavailable path
      // is pinned by tests/strategy_discovery_default_quotes_924.test.tsx.
      return Response.json({
        lastPrice: 180.0,
        change: 1.5,
        changePercent: 0.84,
        companyName: "NVIDIA Corporation",
      });
    }
    if (url.startsWith("/api/trading/options/config")) {
      return Response.json({});
    }
    if (url.startsWith("/api/trading/options/catalog")) {
      return Response.json({
        count: 74,
        total: 74,
        strategies: [],
        aliases: [],
        demoCalibratedChainsEnabled: false,
      });
    }
    if (url.startsWith("/api/trading/options/strategies") && method === "POST") {
      return Response.json({ status: "ok", ranked: [], dataSource: "live" });
    }
    if (url === "/api/schedules/create" && method === "POST") {
      if (state.createError) {
        return Response.json({ success: false, error: state.createError }, { status: 400 });
      }
      return Response.json({ success: true, schedule: { id: "sched-cap-1", ...body } });
    }
    return Response.json({ error: `unstubbed ${method} ${url}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

function callsTo(calls: RecordedCall[], urlPart: string, method?: string) {
  return calls.filter(
    (c) => c.url.includes(urlPart) && (method === undefined || c.method === method)
  );
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 800)}`);
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(StrategyDiscoveryPanel, {
        initialSymbol: "NVDA",
        activeEnv: "PROD",
        userLogin: "tester",
      })
    );
  });
  await flush(80);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Open the Discovery tab and the capture confirm strip; returns the
 *  request body the panel's interactive discovery call last sent. */
async function openCapture(calls: RecordedCall[]) {
  await click(buttonByText(container, "Discovery Scanner"));
  await waitForText("Schedule this discovery");
  const interactive = callsTo(calls, "/api/trading/options/strategies", "POST").at(-1)?.body;
  if (!interactive) throw new Error("the panel never sent an interactive discovery request");
  await click(buttonByText(container, "Schedule this discovery"));
  await waitForText("Schedule THIS view:");
  return interactive;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

describe("StrategyDiscoveryPanel — schedule capture (#126 PR-G)", () => {
  it("creates a schedule whose saved request equals the interactive request, field for field", async () => {
    const calls = installFetch();
    await renderPanel();
    const interactive = await openCapture(calls);

    // The confirm strip names the exact view being scheduled.
    expect(container.textContent).toContain(interactive.symbol);
    expect(container.textContent).toContain(interactive.thesis);
    expect(container.textContent).toContain(`$${Number(interactive.targetPrice).toFixed(2)}`);
    expect(container.textContent).toContain(interactive.targetDate);

    await click(buttonByText(container, "Create schedule"));

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0].body;
    expect(body.callback).toBe("autonomousStrategyDiscovery");
    expect(body.scheduleType).toBe("interval");
    expect(body.intervalSeconds).toBe(3600);
    expect(body.payload.environment).toBe("PROD");
    expect(body.payload.requests).toHaveLength(1);
    expect(body.payload.requests[0]).toEqual(interactive);
    await waitForText("Scheduled this discovery view (NVDA");
  });

  it("posts the picked cadence: a cron choice sends cron and no interval", async () => {
    const calls = installFetch();
    await renderPanel();
    await openCapture(calls);

    const cadence = container.querySelector(
      'select[aria-label="Schedule cadence type"]'
    ) as HTMLSelectElement;
    expect(cadence).not.toBeNull();
    setValue(cadence, "cron");
    await flush(30);

    await click(buttonByText(container, "Create schedule"));

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.scheduleType).toBe("cron");
    expect(createCalls[0].body.cron).toBe(etToUtcCron({ hour: 9, minute: 30, daysOfWeek: "1-5" }));
    expect(createCalls[0].body).not.toHaveProperty("intervalSeconds");
  });

  it("surfaces a create-route rejection and keeps the confirm strip open", async () => {
    const calls = installFetch({
      createError: "Saved discovery request 1 (NVDA) is invalid: Invalid strategy request.",
    });
    await renderPanel();
    await openCapture(calls);

    await click(buttonByText(container, "Create schedule"));

    await waitForText("Saved discovery request 1 (NVDA) is invalid");
    expect(container.textContent).toContain("Schedule THIS view:");
    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(1);
  });
});
