/**
 * Issue #266 — SA-style factor grades: percentile math, grade boundaries,
 * quant ratings, and honest withholding of unfundable factors.
 * Pure functions. No network, no mocks.
 */
import { describe, it, expect } from "vitest";
import {
  computeFactorGrades,
  percentileToGrade,
  compositeToQuantRating,
  type GradeableStock,
} from "../src/trading/factorGrades";

function makeStock(overrides: Partial<GradeableStock> = {}): GradeableStock {
  return {
    symbol: "TEST",
    peRatio: 20,
    rangePosition: 0.5,
    changePercent: 1,
    intradayPosition: 0.6,
    screenScore: 60,
    ...overrides,
  };
}

function universe(n: number): GradeableStock[] {
  // Deterministic spread: P/E 8..40, range 0.05..0.95, change -4..+4.
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    return makeStock({
      symbol: `S${i}`,
      peRatio: 8 + t * 32,
      rangePosition: 0.05 + t * 0.9,
      changePercent: -4 + t * 8,
    });
  });
}

describe("percentileToGrade", () => {
  it("maps percentiles to SA-style letter grades", () => {
    expect(percentileToGrade(97)).toBe("A+");
    expect(percentileToGrade(90)).toBe("A");
    expect(percentileToGrade(82)).toBe("A-");
    expect(percentileToGrade(72)).toBe("B+");
    expect(percentileToGrade(55)).toBe("B-");
    expect(percentileToGrade(35)).toBe("C");
    expect(percentileToGrade(15)).toBe("D+");
    expect(percentileToGrade(7)).toBe("D");
    expect(percentileToGrade(2)).toBe("F");
  });
});

describe("compositeToQuantRating", () => {
  it("maps composite percentiles to ratings", () => {
    expect(compositeToQuantRating(85)).toBe("Strong Buy");
    expect(compositeToQuantRating(65)).toBe("Buy");
    expect(compositeToQuantRating(50)).toBe("Hold");
    expect(compositeToQuantRating(25)).toBe("Sell");
    expect(compositeToQuantRating(10)).toBe("Strong Sell");
  });
});

describe("computeFactorGrades", () => {
  it("grades value and momentum relative within the universe", () => {
    const stocks = universe(20);
    const grades = computeFactorGrades(stocks);
    expect(grades.size).toBe(20);

    // Cheapest stock (lowest P/E, nearest 52w low) should grade well on value.
    const cheapest = grades.get("S0")!;
    expect(cheapest.valueScore).toBeGreaterThan(80);
    expect(cheapest.value![0]).toBe("A");

    // Most expensive should grade poorly on value.
    const priciest = grades.get("S19")!;
    expect(priciest.valueScore).toBeLessThan(20);
    expect(["D", "F"]).toContain(priciest.value![0]);

    // Strongest momentum (highest change%) should grade well on momentum.
    const hottest = grades.get("S19")!;
    expect(hottest.momentumScore).toBeGreaterThan(80);
  });

  it("produces a quant rating from the graded factors", () => {
    const grades = computeFactorGrades(universe(20));
    for (const [, g] of grades) {
      expect(g.quantRating).toBeTruthy();
      expect(g.compositeScore).toBeGreaterThanOrEqual(0);
      expect(g.compositeScore).toBeLessThanOrEqual(100);
      expect(g.gradedFactors).toContain("Value");
      expect(g.gradedFactors).toContain("Momentum");
    }
  });

  it("withholds growth/profitability/revisions — never fakes them", () => {
    const grades = computeFactorGrades(universe(10));
    for (const [, g] of grades) {
      expect(g.growth).toBeNull();
      expect(g.profitability).toBeNull();
      expect(g.revisions).toBeNull();
    }
  });

  it("withholds value grade when no P/E and no range data", () => {
    const stocks = universe(10).map((s) => ({
      ...s,
      peRatio: null,
      rangePosition: null,
    }));
    const grades = computeFactorGrades(stocks);
    for (const [, g] of grades) {
      expect(g.value).toBeNull();
      expect(g.valueScore).toBeNull();
      // Momentum still gradable; quant rating from momentum alone.
      expect(g.momentum).toBeTruthy();
      expect(g.quantRating).toBeTruthy();
      expect(g.gradedFactors).toEqual(["Momentum"]);
    }
  });

  it("returns empty map for empty universe", () => {
    expect(computeFactorGrades([]).size).toBe(0);
  });
});
