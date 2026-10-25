/**
 * Issue #17 (portfolio context, opt-in): buildPortfolioFlags +
 * applyPortfolioContextRanking.
 *
 * - Thresholds come from CONCENTRATION_POLICY (5% material, 40%
 *   dominant sector) — the tests pin the policy values, not copies.
 * - Share basis is portfolio market value, stated in flag messages.
 * - Empty / zero-total / non-positive snapshots flag nothing.
 * - The partition is stable (relative order preserved in both groups),
 *   never mutates its input, and demotes only flagged symbols.
 * - Boundary values (exactly 5%, exactly 40%) flag (>=, not >).
 */
import { describe, it, expect } from "vitest";
import {
  buildPortfolioFlags,
  applyPortfolioContextRanking,
} from "../src/services/portfolioContextRanking";
import { CONCENTRATION_POLICY } from "../src/services/portfolioConcentration";

const pos = (symbol: string, marketValue: number | null) => ({
  symbol,
  marketValue,
});

describe("Issue #17 — buildPortfolioFlags", () => {
  it("pins the policy thresholds it reuses", () => {
    expect(CONCENTRATION_POLICY.materialSharePct).toBe(5);
    expect(CONCENTRATION_POLICY.dominantSectorSharePct).toBe(40);
  });

  it("flags a held name at or above the material share, and nothing below it", () => {
    const flags = buildPortfolioFlags([
      pos("NVDA", 6),
      pos("FAKE1", 47),
      pos("FAKE2", 47),
    ]);
    const nvda = flags.get("NVDA") ?? [];
    expect(nvda.some((f) => f.kind === "held-concentration")).toBe(true);
    expect(nvda.every((f) => f.kind !== "sector-concentration")).toBe(true);
    expect(nvda[0].message).toContain("market value");
    // FAKE names sit in the Unknown bucket (94%): sector-flagged, and
    // held-flagged too (47% each) — the Unknown bucket is not a haven.
    expect(flags.get("FAKE1")?.some((f) => f.kind === "sector-concentration")).toBe(true);
  });

  it("flags every name in a dominant sector, and boundary values flag", () => {
    const flags = buildPortfolioFlags([pos("NVDA", 40), pos("XXXX", 60)]);
    expect(flags.get("NVDA")?.some((f) => f.kind === "sector-concentration")).toBe(true);
    expect(flags.get("NVDA")?.some((f) => f.kind === "held-concentration")).toBe(true);
    // Exactly 5% held: flagged (>=, not >).
    const edge = buildPortfolioFlags([pos("NVDA", 5), pos("XXXX", 95)]);
    expect(edge.get("NVDA")?.some((f) => f.kind === "held-concentration")).toBe(true);
  });

  it("aggregates duplicate symbols and matches case-insensitively", () => {
    const flags = buildPortfolioFlags([
      pos("nvda", 3),
      pos("NVDA", 3),
      pos("XXXX", 94),
    ]);
    expect(flags.get("NVDA")?.some((f) => f.kind === "held-concentration")).toBe(true);
  });

  it("empty, zero-total, and non-positive snapshots flag nothing", () => {
    expect(buildPortfolioFlags([]).size).toBe(0);
    expect(buildPortfolioFlags([pos("NVDA", 0), pos("AAPL", null)]).size).toBe(0);
    expect(buildPortfolioFlags([pos("NVDA", -10)]).size).toBe(0);
  });
});

describe("Issue #17 — applyPortfolioContextRanking", () => {
  it("stably partitions flagged below unflagged and reports demoted symbols", () => {
    const ranked = [
      { symbol: "NVDA", score: 90 },
      { symbol: "AMZN", score: 85 },
      { symbol: "AAPL", score: 80 },
    ];
    const flags = buildPortfolioFlags([
      pos("NVDA", 60),
      pos("AAPL", 30),
      pos("XXXX", 10),
    ]);
    const { ranked: out, demoted } = applyPortfolioContextRanking(ranked, flags);
    expect(out.map((r) => r.symbol)).toEqual(["AMZN", "NVDA", "AAPL"]);
    expect(demoted).toEqual(["NVDA", "AAPL"]);
    // Input untouched.
    expect(ranked.map((r) => r.symbol)).toEqual(["NVDA", "AMZN", "AAPL"]);
  });

  it("an unflagged list passes through unchanged", () => {
    const ranked = [{ symbol: "AMZN" }, { symbol: "TSLA" }];
    const { ranked: out, demoted } = applyPortfolioContextRanking(
      ranked,
      new Map()
    );
    expect(out).toEqual(ranked);
    expect(demoted).toEqual([]);
  });
});
