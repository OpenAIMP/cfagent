/**
 * Issue #2116 (slice D) — tape set resolution pins.
 */
import { describe, expect, it } from "vitest";
import {
  TAPE_PRESETS,
  TAPE_SET_CAP,
  TAPE_SET_STORAGE_KEY,
  loadTapeSelection,
  resolveTapeSymbols,
  saveTapeSelection,
  synthesizeTapeMeta,
  type TapeSetSelection,
  type TapeSetStorage,
} from "../src/client/quotes/symbolSetResolver";

class FakeStorage implements TapeSetStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe("tape set resolution (#2116)", () => {
  it("defaults to the hardcoded tape set with no selection", () => {
    expect(resolveTapeSymbols(null)).toEqual(TAPE_PRESETS.default);
    expect(resolveTapeSymbols({ kind: "default" })).toEqual(TAPE_PRESETS.default);
    expect(TAPE_PRESETS.default).toHaveLength(10);
  });

  it("resolves each preset from existing sets only", () => {
    expect(resolveTapeSymbols({ kind: "preset", preset: "indices" })).toEqual(["SPY", "QQQ", "DIA"]);
    expect(resolveTapeSymbols({ kind: "preset", preset: "mega-cap" })).toEqual([
      "NVDA",
      "AAPL",
      "MSFT",
      "TSLA",
      "AMD",
      "AMZN",
      "META",
      "GOOGL",
    ]);
    expect(resolveTapeSymbols({ kind: "preset", preset: "crypto" })).toEqual([
      "BTC/USD",
      "ETH/USD",
      "SOL/USD",
    ]);
  });

  it("parses a custom list (unique, uppercase, trimmed) and caps at 20", () => {
    expect(resolveTapeSymbols({ kind: "custom", text: "aapl, msft  SPY, aapl" })).toEqual([
      "AAPL",
      "MSFT",
      "SPY",
    ]);
    const many = Array.from({ length: 25 }, (_, i) => `S${i}`).join(",");
    const resolved = resolveTapeSymbols({ kind: "custom", text: many });
    expect(resolved).toHaveLength(TAPE_SET_CAP);
    expect(resolved[0]).toBe("S0");
  });

  it("falls back to default on an empty custom list", () => {
    expect(resolveTapeSymbols({ kind: "custom", text: " , ; " })).toEqual(TAPE_PRESETS.default);
  });

  it("uses fetched symbols for watchlist/holdings and falls back when empty", () => {
    expect(resolveTapeSymbols({ kind: "watchlist", id: 1 }, ["nvda", "aapl"])).toEqual([
      "NVDA",
      "AAPL",
    ]);
    expect(resolveTapeSymbols({ kind: "watchlist", id: 1 }, [])).toEqual(TAPE_PRESETS.default);
    expect(resolveTapeSymbols({ kind: "holdings" }, [])).toEqual(TAPE_PRESETS.default);
    expect(resolveTapeSymbols({ kind: "holdings" }, ["msft"])).toEqual(["MSFT"]);
  });

  it("round-trips a selection through storage and rejects corrupt rows", () => {
    const store = new FakeStorage();
    const selection: TapeSetSelection = { kind: "custom", text: "NVDA, AAPL" };
    saveTapeSelection(selection, store);
    expect(store.map.get(TAPE_SET_STORAGE_KEY)).toContain("custom");
    expect(loadTapeSelection(store)).toEqual(selection);
    store.setItem(TAPE_SET_STORAGE_KEY, "not json{");
    expect(loadTapeSelection(store)).toBeNull();
    store.setItem(TAPE_SET_STORAGE_KEY, JSON.stringify({ kind: "preset", preset: "bogus" }));
    expect(loadTapeSelection(store)).toBeNull();
  });

  it("synthesizes display metadata (crypto on slash, etf on index funds)", () => {
    const meta = synthesizeTapeMeta(["BTC/USD", "SPY", "NVDA"]);
    expect(meta).toEqual([
      { symbol: "BTC/USD", type: "crypto" },
      { symbol: "SPY", type: "etf" },
      { symbol: "NVDA", type: "stock" },
    ]);
  });
});
