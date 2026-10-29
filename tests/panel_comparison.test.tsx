/** @vitest-environment jsdom */
/**
 * #1257 comparison surfacing — the hub options-tab panel gains a
 * three-way generator comparison button, distinct from the existing
 * "Compare Quant vs AI" annotation compare. The button posts the
 * panel's current request to POST /trading/options/comparison and
 * renders per-arm ranked lists, per-arm attrition, overlap, and
 * generation notes, plus a ledger read-back by run id. It never
 * reorders production rankings: the comparison surface is
 * read-only over the artifact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OptionsResearchPanel } from "../src/client/options/OptionsResearchPanel";
import { ToastProvider } from "../src/client/components/ui";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const artifact = {
  runId: "cmp-panel-1",
  arms: {
    llm: {
      attrition: { generated: 3, gatePassed: 2, priced: 2, falsified: 2, ranked: 2 },
      ranked: [
        { id: "llm-1", structure: "iron_condor", label: "Iron condor (LLM)", status: "qualified", score: 8.5, provenance: "llm" },
        { id: "llm-2", structure: "bull_put_spread", label: "Bull put spread (LLM)", status: "watchlist", score: 6.1, provenance: "llm" },
      ],
    },
    quant: {
      attrition: { generated: 2, gatePassed: 1, priced: 1, falsified: 1, ranked: 1 },
      ranked: [{ id: "q-1", structure: "iron_condor", label: "Iron condor (quant)", status: "qualified", score: 9.0, provenance: "quant" }],
    },
    hybrid: {
      attrition: { generated: 2, gatePassed: 2, priced: 2, falsified: 2, ranked: 2 },
      ranked: [
        { id: "h-1", structure: "bull_put_spread", label: "Bull put spread (hybrid)", status: "qualified", score: 7.7, provenance: "quant" },
        { id: "h-2", structure: "iron_condor", label: "Iron condor (hybrid)", status: "qualified", score: 7.2, provenance: "quant" },
      ],
    },
  },
  overlap: { sharedStructures: ["iron_condor"], armUnique: { llm: [], quant: [], hybrid: ["bull_put_spread"] } },
  stats: { armRankedCounts: { llm: 2, quant: 1, hybrid: 2 }, sharedStructureCount: 1 },
};

const comparisonResponse = {
  status: "compared",
  artifact,
  generationNotes: { model: "test-model", citedCount: 5, droppedCount: 1, llmGenerated: 2, llmBuilderLimitations: [], skippedReason: null },
  symbol: "NVDA",
  dataSource: "live",
};

const outcomesResponse = {
  runId: "cmp-panel-1",
  outcomes: [
    { id: "o-1", run_id: "cmp-panel-1", arm: "llm", candidate_id: "llm-1", structure: "iron_condor", symbol: "NVDA", status: "qualified", provenance: "llm" },
    { id: "o-2", run_id: "cmp-panel-1", arm: "quant", candidate_id: "q-1", structure: "iron_condor", symbol: "NVDA", status: "qualified", provenance: "quant" },
  ],
};

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function switchToCustomTab(container: HTMLDivElement) {
  const tab = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Custom Thesis"));
  expect(tab).toBeDefined();
  await act(async () => {
    tab!.click();
  });
}

describe("panel three-way comparison", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn() as any;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/trading/options/comparison/outcomes")) {
        return { ok: true, json: async () => outcomesResponse } as Response;
      }
      if (url.includes("/api/trading/options/comparison")) {
        return { ok: true, json: async () => comparisonResponse } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("posts the panel request to the comparison route and renders arms, attrition, and overlap", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <OptionsResearchPanel activeEnv="TEST" userLogin="alice" />
        </ToastProvider>
      );
    });
    await switchToCustomTab(container);
    const symbolInput = container.querySelector('input[placeholder="Ticker"]') as HTMLInputElement;
    const priceInput = container.querySelector('input[placeholder="Price at target date"]') as HTMLInputElement;
    expect(symbolInput).not.toBeNull();
    setInputValue(symbolInput, "NVDA");
    setInputValue(priceInput, "260");
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Compare generators"));
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const comparisonCall = fetchMock.mock.calls.find((c) => typeof c[0] === "string" && (c[0] as string).includes("/api/trading/options/comparison") && !(c[0] as string).includes("outcomes"));
    expect(comparisonCall).toBeDefined();
    const body = JSON.parse(comparisonCall![1].body as string);
    expect(body.symbol).toBe("NVDA");
    expect(body.targetPrice).toBe(260);
    const text = container.textContent ?? "";
    expect(text).toContain("Generator comparison");
    expect(text).toContain("Iron condor (LLM)");
    expect(text).toContain("Iron condor (quant)");
    expect(text).toContain("Iron condor (hybrid)");
    expect(text).toContain("cmp-panel-1");
    expect(text).toContain("No winner is declared");
  });

  it("reads ledger outcomes back by run id", async () => {
    await act(async () => {
      root.render(
        <ToastProvider>
          <OptionsResearchPanel activeEnv="TEST" userLogin="alice" />
        </ToastProvider>
      );
    });
    await switchToCustomTab(container);
    setInputValue(container.querySelector('input[placeholder="Ticker"]') as HTMLInputElement, "NVDA");
    setInputValue(container.querySelector('input[placeholder="Price at target date"]') as HTMLInputElement, "260");
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Compare generators"));
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const outcomesButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Load ledger outcomes"));
    expect(outcomesButton).toBeDefined();
    await act(async () => {
      outcomesButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const outcomesCall = fetchMock.mock.calls.find((c) => typeof c[0] === "string" && (c[0] as string).includes("/comparison/outcomes"));
    expect(outcomesCall).toBeDefined();
    expect(outcomesCall![0]).toContain("runId=cmp-panel-1");
    expect(container.textContent ?? "").toContain("llm-1");
  });
});
