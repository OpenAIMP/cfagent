/** @vitest-environment jsdom */
/**
 * Issue #1205 — the Recommendation Bundle (Best Trade v2) section of
 * PortfolioRiskPanel shipped (#1135) as a silent dead end: the candidate
 * textarea's placeholder is a JSON skeleton with literal "…" characters
 * (looks like pre-filled input; is not), and Build bundle was disabled
 * while the box was empty with no hint anywhere. An owner hit exactly
 * this: beta filled, "JSON" visibly in the box, click → nothing.
 *
 * Harness follows tests/discovery_runs_panel.test.tsx: the REAL panel
 * rendered with react-dom/client in jsdom against a stubbed global
 * fetch. Every backend call fails in the stub (the live book is not
 * reachable from a test) — the pins here are about the panel's own
 * states, not the server:
 *  - empty box → Build disabled AND a visible hint that says why,
 *    names the grey skeleton as a placeholder (not input), and offers
 *    the next step;
 *  - "Insert example candidate" loads real, parseable JSON, clears the
 *    hint, and enables Build;
 *  - invalid JSON → the parse problem is visible adjacent to the
 *    textarea and Build stays disabled (no silent dead click, and no
 *    need to submit to learn the text is broken);
 *  - a valid submit still goes through the unchanged POST path, and a
 *    server error (e.g. the E*TRADE session state) surfaces in the
 *    panel instead of vanishing.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PortfolioRiskPanel } from "../src/client/PortfolioRiskPanel";
import { exampleBundleCandidateJson } from "../src/client/portfolioRiskApi";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;

interface RecordedCall { url: string; method: string; body?: string }
let calls: RecordedCall[] = [];
let container: HTMLDivElement;
let root: Root | null = null;

const SESSION_ERROR = "E*TRADE OAuth Token Missing: No active session for user in [PROD] mode";

function installFetchStub() {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.includes("/etrade/portfolio-risk/bundle")) {
      return Response.json({ error: SESSION_ERROR }, { status: 500 });
    }
    return Response.json({ error: "stubbed backend" }, { status: 500 });
  }) as typeof fetch;
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PortfolioRiskPanel activeEnv="PROD" onPreviewHedge={() => {}} />);
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

function bundleTextarea(): HTMLTextAreaElement {
  const el = container.querySelector("textarea.prp-bundle-json");
  if (!el) throw new Error("bundle textarea not found");
  return el as HTMLTextAreaElement;
}

function setTextareaValue(value: string) {
  const el = bundleTextarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  installFetchStub();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("PortfolioRiskPanel bundle section (issue #1205)", () => {
  it("empty box: Build is disabled AND the panel says why — the skeleton is a placeholder, not input", async () => {
    await renderPanel();
    expect(bundleTextarea().value).toBe("");
    expect(buttonByText("Build bundle").disabled).toBe(true);
    const text = container.textContent || "";
    expect(text).toMatch(/placeholder/i);
    expect(text).toMatch(/not input/i);
    expect(text).toContain("Insert example candidate");
  });

  it("Insert example candidate loads real parseable JSON, clears the hint, enables Build", async () => {
    await renderPanel();
    await click(buttonByText("Insert example candidate"));
    const value = bundleTextarea().value;
    expect(value).toBe(exampleBundleCandidateJson());
    const parsed = JSON.parse(value);
    expect(parsed.symbol).toBe("XYZ");
    expect(Array.isArray(parsed.legs) && parsed.legs.length).toBeTruthy();
    expect(buttonByText("Build bundle").disabled).toBe(false);
    expect(container.textContent || "").not.toMatch(/Build bundle is disabled/i);
  });

  it("invalid JSON: the parse problem is visible next to the box and Build stays disabled", async () => {
    await renderPanel();
    await act(async () => {
      setTextareaValue('{"id": "…", "legs": [ … ]}');
    });
    await flush();
    expect(container.textContent || "").toMatch(/not valid JSON/i);
    expect(buttonByText("Build bundle").disabled).toBe(true);
  });

  it("valid submit still POSTs to the bundle route and a server error surfaces in the panel", async () => {
    await renderPanel();
    await click(buttonByText("Insert example candidate"));
    await click(buttonByText("Build bundle"));
    const post = calls.find((c) => c.url.includes("/etrade/portfolio-risk/bundle") && c.method === "POST");
    expect(post).toBeTruthy();
    expect(JSON.parse(post!.body!).candidate.symbol).toBe("XYZ");
    expect(container.textContent || "").toContain(SESSION_ERROR);
  });
});
