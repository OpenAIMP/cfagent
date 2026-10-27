import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPaletteAnnouncement,
  getPaletteSelectedLabel,
  paletteOptionId,
  type StockTickerItem,
} from "../src/client/components/StockSearchBar";

/**
 * Ctrl-K palette a11y pins (#1695, follow-up to A2 #1578).
 *
 * The palette is a stateful component, and this repo's suite is DOM-free,
 * so the pins are split: pure helpers are unit-tested directly, and the
 * composition (Modal primitive + listbox semantics + live region, no
 * hand-rolled dialog) is pinned by static assertions over the component
 * source — the same static-scan idiom the freeze/ratchet gates use.
 * The Modal primitive's own trap/restore/Esc behavior is pinned by
 * tests/ui_modal_focus_trap.test.tsx; this file pins that the palette
 * actually uses it.
 */

const ROOT = join(__dirname, "..");

const TICKERS: StockTickerItem[] = [
  { symbol: "NVDA", name: "NVIDIA Corporation", price: "$138.25", change: "+3.42%", isPositive: true, type: "stock" },
  { symbol: "AAPL", name: "Apple Inc.", price: "$232.10", change: "+0.84%", isPositive: true, type: "stock" },
];
const NAV = [
  { id: "autopilot", label: "Autopilot Control Center" },
  { id: "chat", label: "Copilot Ideas & Agent Chat" },
];
const ACTIONS = [
  { id: "action-options", label: "Screen NVDA 0DTE Options Flow" },
  { id: "action-research", label: "Generate Market Data Valuation Report for NVDA" },
];

describe("paletteOptionId (#1695)", () => {
  it("names options deterministically for aria-activedescendant", () => {
    expect(paletteOptionId(0)).toBe("palette-option-0");
    expect(paletteOptionId(5)).toBe("palette-option-5");
  });
});

describe("getPaletteSelectedLabel (#1695)", () => {
  it("walks tickers, then navigation, then actions", () => {
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 0)).toBe("NVDA, NVIDIA Corporation");
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 1)).toBe("AAPL, Apple Inc.");
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 2)).toBe("Autopilot Control Center");
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 3)).toBe("Copilot Ideas & Agent Chat");
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 4)).toBe("Screen NVDA 0DTE Options Flow");
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 5)).toBe("Generate Market Data Valuation Report for NVDA");
  });

  it("returns null for out-of-range and negative indices", () => {
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, 6)).toBeNull();
    expect(getPaletteSelectedLabel(TICKERS, NAV, ACTIONS, -1)).toBeNull();
    expect(getPaletteSelectedLabel([], [], [], 0)).toBeNull();
  });
});

describe("buildPaletteAnnouncement (#1695)", () => {
  it("announces empty results", () => {
    expect(buildPaletteAnnouncement(0, null)).toBe("No matching stocks or commands");
  });

  it("announces count, with singular agreement", () => {
    expect(buildPaletteAnnouncement(1, null)).toBe("1 result.");
    expect(buildPaletteAnnouncement(37, null)).toBe("37 results.");
  });

  it("announces count plus selection", () => {
    expect(buildPaletteAnnouncement(37, "NVDA, NVIDIA Corporation")).toBe(
      "37 results. Selected: NVDA, NVIDIA Corporation.",
    );
  });
});

describe("palette composition pins (#1695)", () => {
  const source = readFileSync(
    join(ROOT, "src", "client", "components", "StockSearchBar.tsx"),
    "utf8",
  );

  it("uses the Modal primitive instead of a hand-rolled dialog", () => {
    expect(source).toContain("<Modal");
    expect(source).toContain("panelClassName=\"stock-search-modal-dialog\"");
    expect(source).not.toContain("stock-search-modal-backdrop");
    expect(source).not.toContain("role=\"dialog\"");
    expect(source).not.toContain("aria-modal=");
  });

  it("wires listbox semantics and the combobox contract", () => {
    expect(source).toContain("role=\"listbox\"");
    expect(source).toContain("role=\"option\"");
    expect(source).toContain("role=\"combobox\"");
    expect(source).toContain("aria-activedescendant");
    expect(source).toContain("aria-controls={listboxId}");
    expect(source).toContain("aria-selected={isSelected}");
  });

  it("announces through a polite live region that stays screen-reader visible", () => {
    expect(source).toContain("aria-live=\"polite\"");
    expect(source).toContain("ui-visually-hidden");
    const primitives = readFileSync(
      join(ROOT, "src", "client", "components", "ui", "primitives.css"),
      "utf8",
    );
    expect(primitives).toContain(".ui-visually-hidden");
  });
});
