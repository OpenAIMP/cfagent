/** @vitest-environment jsdom */
/**
 * Issue #341: Watchlist & rejected-ideas browser — renders flattened §8
 * entries from the browse endpoint, filters by kind/gate via refetch,
 * and links each row back to its run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ResearchIdeasBrowser } from "../src/client/chat/tabs/ResearchIdeasBrowser";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ALL = [
  {
    kind: "watchlist", symbol: "NVDA", outlook: "bullish", structure: "call",
    thesis: "t", reason: "IV too rich", gate: "", triggerCondition: "IV rank < 40",
    reportId: "r1", reportTitle: "Run 1", runCreatedAt: "2026-10-19T12:00:00.000Z",
  },
  {
    kind: "rejected", symbol: "XYZ", outlook: "bearish", structure: "put spread",
    thesis: "", reason: "Spread too wide", gate: "liquidity", triggerCondition: "",
    reportId: "r1", reportTitle: "Run 1", runCreatedAt: "2026-10-19T12:00:00.000Z",
  },
];

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    const u = new URL(String(url), "http://local");
    let entries = ALL;
    const kind = u.searchParams.get("kind");
    if (kind) entries = entries.filter((e) => e.kind === kind);
    const gate = u.searchParams.get("gate");
    if (gate) entries = entries.filter((e) => e.gate === gate);
    return {
      ok: true,
      status: 200,
      json: async () => ({ count: entries.length, gates: ["liquidity"], entries }),
    } as Response;
  });
  return calls;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

describe("ResearchIdeasBrowser", () => {
  beforeEach(() => stubFetch());
  afterEach(() => vi.unstubAllGlobals());

  it("renders watchlist and rejected entries with gate badges", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<ResearchIdeasBrowser onOpenReport={() => undefined} />));
    await flush();
    const text = container.textContent || "";
    expect(text).toContain("NVDA");
    expect(text).toContain("XYZ");
    expect(text).toContain("liquidity");
    expect(text).toContain("IV rank < 40");
    act(() => root.unmount());
    container.remove();
  });

  it("links a row back to its run", async () => {
    const opened: string[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(<ResearchIdeasBrowser onOpenReport={(id) => opened.push(id)} />)
    );
    await flush();
    const buttons = [...container.querySelectorAll("button")].filter((b) =>
      (b.textContent || "").includes("→")
    );
    expect(buttons.length).toBe(2);
    act(() => buttons[0].click());
    expect(opened).toEqual(["r1"]);
    act(() => root.unmount());
    container.remove();
  });
});
