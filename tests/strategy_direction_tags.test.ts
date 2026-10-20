/**
 * Issue #275 — strategy direction tags: every catalog strategy carries
 * direction tags (its `theses` — bullish / bearish / range_bound /
 * large_move), the scanner UI filters by them, and scheduled runs tag
 * each opportunity with its strategy's direction.
 */
import { describe, it, expect } from "vitest";
import {
  DIRECTION_TAGS,
  DIRECTION_TAG_LABELS,
  directionTagsForStrategy,
  tagOpportunitiesWithDirection,
} from "../src/trading/options/strategies/directionTags";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";

describe("directionTagsForStrategy (#275)", () => {
  it("returns the catalog theses as direction tags", () => {
    expect(directionTagsForStrategy("long_call")).toEqual(["bullish"]);
    expect(directionTagsForStrategy("long_straddle")).toEqual(["large_move"]);
    expect(directionTagsForStrategy("short_call")).toEqual(["bearish", "range_bound"]);
    expect(directionTagsForStrategy("iron_condor")).toEqual(["range_bound"]);
  });

  it("returns [] for an unknown strategy id", () => {
    expect(directionTagsForStrategy("not_a_strategy")).toEqual([]);
    expect(directionTagsForStrategy("")).toEqual([]);
  });

  it("every catalog strategy carries at least one direction tag, all from the direction vocabulary", () => {
    const all = defaultRegistry.list();
    expect(all.length).toBeGreaterThan(20);
    for (const def of all) {
      const tags = directionTagsForStrategy(def.id);
      expect(tags.length, `${def.id} has no direction tags`).toBeGreaterThan(0);
      for (const t of tags) expect(DIRECTION_TAGS).toContain(t);
    }
  });

  it("labels exist for every direction tag", () => {
    for (const tag of DIRECTION_TAGS) {
      expect(DIRECTION_TAG_LABELS[tag]).toBeTruthy();
    }
    expect(DIRECTION_TAG_LABELS.range_bound).toMatch(/range/i);
    expect(DIRECTION_TAG_LABELS.large_move).toMatch(/large/i);
  });
});

describe("tagOpportunitiesWithDirection (#275)", () => {
  const rows: any[] = [
    {
      symbol: "AAPL",
      pick: { status: "recommended", best: { candidate: { type: "call_debit_spread" } } },
    },
    {
      symbol: "SPY",
      pick: { status: "recommended", best: { candidate: { type: "long_strangle" } } },
    },
    { symbol: "MSFT", pick: { status: "no_trade", best: undefined } },
    { symbol: "NVDA" },
  ];

  it("tags each row from its pick's strategy and leaves the rows otherwise untouched", () => {
    const tagged = tagOpportunitiesWithDirection(rows);
    expect(tagged[0].directionTags).toEqual(["bullish"]);
    expect(tagged[1].directionTags).toEqual(["large_move"]);
    expect(tagged[0].symbol).toBe("AAPL");
    expect(tagged[0].pick).toBe(rows[0].pick);
  });

  it("rows without a pick or with an unknown strategy get an empty tag list, never a crash", () => {
    const tagged = tagOpportunitiesWithDirection(rows);
    expect(tagged[2].directionTags).toEqual([]);
    expect(tagged[3].directionTags).toEqual([]);
  });

  it("does not mutate the input rows", () => {
    const tagged = tagOpportunitiesWithDirection(rows);
    expect((rows[0] as any).directionTags).toBeUndefined();
    expect(tagged[0]).not.toBe(rows[0]);
  });
});
