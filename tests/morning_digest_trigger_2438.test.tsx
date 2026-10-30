/** @vitest-environment jsdom */
/**
 * Issue #2438 (ScreenersHub redesign): digest entries gain their trigger
 * (display-only — trigger already exists on ScreenRun) plus a link to
 * the provider dashboard for health. Per-run provider display stays
 * OUT (data gap; the dashboard covers it globally).
 *
 * Harness follows tests/morning_digest.test.tsx: direct component
 * renders with react-dom/client in jsdom.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MorningDigest, type DigestRun } from "../src/client/MorningDigest";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

const RUNS: DigestRun[] = [
  {
    timestamp: "2026-10-30T02:35:00.000Z",
    trigger: "scheduled",
    universe: "NASDAQ100",
    sector: "ALL",
    success: false,
    totalScanned: 0,
    matchedCount: 0,
    error: "Yahoo Finance unavailable: no live quotes returned",
  },
  {
    timestamp: "2026-10-30T02:34:00.000Z",
    trigger: "manual",
    universe: "NASDAQ100",
    sector: "ALL",
    success: true,
    totalScanned: 100,
    matchedCount: 100,
  },
];

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDigest() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.fetch = vi.fn(async () => Response.json({ pending: [] })) as typeof fetch;
  await act(async () => {
    root.render(
      <MorningDigest
        runs={RUNS}
        nowMs={Date.UTC(2026, 9, 30, 12, 0, 0)}
        onSelectRun={() => {}}
        onViewQueue={() => {}}
      />,
    );
  });
  await flush();
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("MorningDigest trigger + dashboard link (#2438)", () => {
  it("shows each entry's trigger", async () => {
    await renderDigest();
    const text = container.textContent || "";
    expect(text).toContain("Scheduled");
    expect(text).toContain("Manual");
  });

  it("links failed entries to the provider dashboard for health", async () => {
    await renderDigest();
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      (a.getAttribute("href") || "").includes("provider-dashboard"),
    );
    expect(link).toBeDefined();
  });

  it("does not invent a per-run provider label", async () => {
    await renderDigest();
    const text = container.textContent || "";
    expect(text).not.toContain("Provider: E*TRADE");
    expect(text).not.toContain("Provider: Yahoo");
  });
});
