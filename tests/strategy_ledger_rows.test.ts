import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildStrategyLedgerRows } from "../src/agents/nlqOptionsStrategy";
import { defaultRegistry } from "../src/trading/options/strategies/catalog";

describe("strategy ledger rows", () => {
  const evaluations = [
    { id: "long_call", label: "Long Call", category: "single", status: "accepted" as const, generated: 4, accepted: 2, summary: "2 passed", reasons: [] },
    { id: "short_call", label: "Short Call", category: "single", status: "rejected" as const, generated: 3, accepted: 0, summary: "Unlimited loss", reasons: [{ reason: "Unlimited loss", count: 3 }] },
    { id: "covered_call", label: "Covered Call", category: "stock", status: "skipped" as const, generated: 0, accepted: 0, summary: "No shares held", reasons: [] },
  ];

  it("groups by category with score, passed, failed, reason and candidate verdicts", () => {
    const rows = buildStrategyLedgerRows(evaluations, new Map([["long_call", 72.5]]), new Map([["long_call", "Buy one call."]]));
    const single = rows.find((row) => row.category === "single")!;
    expect(single).toMatchObject({ score: 72.5, passed: 1, failed: 1 });
    expect(single.reason).toContain("Unlimited loss");
    expect(single.candidateStrategies).toEqual([
      expect.objectContaining({ id: "long_call", name: "Long Call", status: "accepted", description: "Buy one call." }),
      expect.objectContaining({ id: "short_call", name: "Short Call", status: "rejected", why: "Unlimited loss" }),
    ]);
    expect(rows.find((row) => row.category === "stock")).toMatchObject({ passed: 0, failed: 1 });
  });

  it("has a generated description page for every registered strategy", () => {
    for (const def of defaultRegistry.list()) {
      expect(existsSync(`public/strategies/${def.id}.html`), def.id).toBe(true);
    }
  });
});
