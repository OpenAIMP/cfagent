/**
 * Issue #275 — the Strategy Library (the Scanner's strategy picker)
 * filters strategies by direction tag and renders the tags as
 * direction badges.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { StrategyLibraryModal, type StrategyInfo } from "../src/client/options/StrategyLibraryModal";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STRATEGIES: StrategyInfo[] = [
  { id: "long_call", label: "Long Call", category: "single", description: "Buy one call.", theses: ["bullish"], aliases: [] },
  { id: "long_put", label: "Long Put", category: "single", description: "Buy one put.", theses: ["bearish"], aliases: [] },
  { id: "iron_condor", label: "Iron Condor", category: "condor", description: "Credit condor.", theses: ["range_bound"], aliases: [] },
  { id: "long_straddle", label: "Long Straddle", category: "volatility", description: "Buy both sides.", theses: ["large_move"], aliases: [] },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <StrategyLibraryModal isOpen={true} onClose={() => {}} strategies={STRATEGIES} multiSelect={true} selectedIds={[]} onApply={() => {}} />
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("StrategyLibraryModal direction filter (#275)", () => {
  it("renders direction filter chips for all four tags", async () => {
    await render();
    const text = document.body.textContent || "";
    for (const label of ["Bullish", "Bearish", "Range-bound", "Large move"]) {
      expect(text).toContain(label);
    }
  });

  it("renders each strategy's direction tags as badges", async () => {
    await render();
    const tags = [...document.body.querySelectorAll(".strat-thesis-tag")].map((el) => el.textContent?.trim());
    expect(tags).toContain("bullish");
    expect(tags).toContain("range bound");
    const bullishTag = [...document.body.querySelectorAll(".strat-thesis-tag")].find(
      (el) => el.textContent?.trim() === "bullish"
    );
    expect(bullishTag?.className).toContain("dir-bullish");
  });

  it("clicking a direction chip filters the grid to matching strategies", async () => {
    await render();
    const chip = [...document.body.querySelectorAll("button")].find(
      (b) => (b.textContent || "").trim() === "Bearish"
    );
    expect(chip).toBeTruthy();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = document.body.textContent || "";
    expect(text).toContain("Long Put");
    expect(text).not.toContain("Long Call");
    expect(text).not.toContain("Iron Condor");
    expect(text).not.toContain("Long Straddle");
  });
});
