/**
 * Issue #319 — economics core tests (spec §1: independently recomputed).
 */
import { describe, it, expect } from "vitest";
import {
  blackScholesPrice,
  expectedMove,
  verticalSpreadEconomics,
  ironCondorEconomics,
  butterflyEconomics,
  straddleEconomics,
  pmccEconomics,
  buildScenarioRows,
  SCENARIO_SPECS,
  type ResearchLeg,
} from "../src/services/researchEconomics";

function leg(
  optionType: "call" | "put",
  strike: number,
  bid: number,
  ask: number,
  quantity: number,
  dte = 35
): ResearchLeg {
  return {
    optionType,
    strike,
    expiry: "2026-12-18",
    dte,
    bid,
    ask,
    iv: 0.4,
    volume: 100,
    openInterest: 500,
    quantity,
    quoteTimestamp: Date.now(),
  };
}

describe("blackScholesPrice", () => {
  it("prices an ATM call near the textbook value", () => {
    const px = blackScholesPrice({
      spot: 100, strike: 100, years: 1, rate: 0.05, dividendYield: 0, sigma: 0.2, optionType: "call",
    });
    expect(px).toBeCloseTo(10.45, 1);
  });
  it("put-call parity holds", () => {
    const args = { spot: 100, strike: 105, years: 0.5, rate: 0.05, dividendYield: 0.01, sigma: 0.3 };
    const c = blackScholesPrice({ ...args, optionType: "call" });
    const p = blackScholesPrice({ ...args, optionType: "put" });
    const parity = c - p - (args.spot * Math.exp(-args.dividendYield * args.years) - args.strike * Math.exp(-args.rate * args.years));
    expect(Math.abs(parity)).toBeLessThan(1e-9);
  });
  it("returns NaN on degenerate input", () => {
    expect(
      blackScholesPrice({ spot: 0, strike: 100, years: 1, rate: 0.05, dividendYield: 0, sigma: 0.2, optionType: "call" })
    ).toBeNaN();
  });
});

describe("verticalSpreadEconomics", () => {
  it("bull call spread: max loss equals the debit", () => {
    const econ = verticalSpreadEconomics(
      [leg("call", 100, 4.8, 5.0, 1), leg("call", 110, 1.0, 1.2, -1)],
      100
    );
    expect(econ.netDebit).toBeCloseTo(3.8, 1);
    expect(econ.maxLoss).toBeCloseTo(3.8, 1);
    expect(econ.maxGain).toBeCloseTo(10 - 3.8, 1);
    expect(econ.breakevens).toHaveLength(1);
    expect(econ.breakevens[0]).toBeCloseTo(103.8, 0);
  });
  it("bull put spread (credit): max loss equals width minus credit", () => {
    const econ = verticalSpreadEconomics(
      [leg("put", 95, 2.4, 2.6, -1), leg("put", 90, 1.0, 1.2, 1)],
      100
    );
    expect(econ.netCredit).toBeCloseTo(1.4, 1);
    expect(econ.maxLoss).toBeCloseTo(5 - 1.4, 1);
  });
  it("rejects mismatched expiries and types", () => {
    expect(() =>
      verticalSpreadEconomics(
        [leg("call", 100, 4.8, 5.0, 1), { ...leg("put", 110, 1.0, 1.2, -1) }],
        100
      )
    ).toThrow();
  });
});

describe("ironCondorEconomics", () => {
  it("max loss equals wing width minus credit", () => {
    const econ = ironCondorEconomics(
      [
        leg("put", 90, 1.0, 1.2, 1),
        leg("put", 95, 2.4, 2.6, -1),
        leg("call", 105, 2.4, 2.6, -1),
        leg("call", 110, 1.0, 1.2, 1),
      ],
      100
    );
    expect(econ.netCredit).toBeCloseTo(2.8, 1);
    expect(econ.maxLoss).toBeCloseTo(5 - 2.8, 1);
    expect(econ.breakevens).toHaveLength(2);
  });
});

describe("butterflyEconomics", () => {
  it("max loss equals the debit, max gain at the body", () => {
    const econ = butterflyEconomics(
      [
        leg("call", 95, 6.0, 6.4, 1),
        leg("call", 100, 3.0, 3.2, -2),
        leg("call", 105, 1.0, 1.2, 1),
      ],
      100
    );
    expect(econ.netDebit).toBeGreaterThan(0);
    expect(econ.maxLoss).toBeCloseTo(econ.netDebit, 1);
    expect(econ.maxGain).toBeCloseTo(5 - econ.netDebit, 1);
  });
});

describe("straddleEconomics", () => {
  it("assesses premium against the expected move", () => {
    const legs = [leg("call", 100, 6.0, 6.4, 1), leg("put", 100, 6.0, 6.4, 1)];
    const a = straddleEconomics(legs, 100, 0.4, 35);
    const em = expectedMove(100, 0.4, 35 / 365);
    expect(a.expectedMove).toBeCloseTo(Number(em.toFixed(2)), 6);
    expect(a.breakevens).toHaveLength(2);
    expect(a.premiumToExpectedMove).toBeGreaterThan(0);
  });
});

describe("pmccEconomics", () => {
  const input = {
    longCall: leg("call", 80, 24.0, 24.6, 1, 400),
    shortCall: leg("call", 105, 2.4, 2.6, -1, 35),
    spot: 100,
    rate: 0.05,
    dividendYield: 0,
    longIv: 0.4,
  };
  it("models the long call's remaining value — never width-minus-debit", () => {
    const m = pmccEconomics(input);
    // The trap: naive width-minus-debit must NOT equal the modeled max profit.
    expect(Math.abs(m.maxProfit - m.naiveWidthMinusDebit)).toBeGreaterThan(0.5);
    expect(m.maxProfit).toBeGreaterThan(0);
    expect(m.maxLoss).toBeCloseTo(m.netDebit, 0);
    expect(m.derivationNotes.join(" ")).toMatch(/Black-Scholes/);
  });
  it("rejects a short strike below the long strike", () => {
    expect(() =>
      pmccEconomics({ ...input, shortCall: leg("call", 75, 2.4, 2.6, -1, 35) })
    ).toThrow();
  });
});

describe("buildScenarioRows", () => {
  it("produces the five spec §8 scenario rows", () => {
    const econ = verticalSpreadEconomics(
      [leg("call", 100, 4.8, 5.0, 1), leg("call", 110, 1.0, 1.2, -1)],
      100
    );
    const rows = buildScenarioRows(econ, 100, 0.4, 21, 0.05, 0, {
      feePerContract: 0.65,
      slippagePerContract: 0.02,
      contracts: 1,
    });
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.label)).toEqual(SCENARIO_SPECS.map((s) => s.label));
    // Downside scenario loses money on a bull spread; sharp upside makes money.
    expect(rows[0].pnlPerUnit).toBeLessThan(0);
    expect(rows[3].pnlPerUnit).toBeGreaterThan(0);
  });
});
