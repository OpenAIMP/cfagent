/**
 * Issue #1732 (parent #1717, slice (l)) — portfolio repair remainders
 * (scan appendix (l) findings PR-1, PR-2, PR-3; PR-4 IDENTICAL, pin only).
 *
 * RATIFIED DESIGN (#1642, restated in the #1732 issue body): the two
 * repair models coexist — switch, don't delete, and do not re-merge
 * without a new owner decision. This slice therefore pins the pairs
 * (following the #1729/#1730/#1731 precedent) instead of forcing a
 * phantom switch, with ONE minimal executable change: the PR-2
 * visible marker. A bundle consumer reading `repairs` could not tell
 * from output alone that the composition leg is structurally empty
 * in production (no production caller supplies compositionRepairs —
 * tests only). `buildRepairOptions` now carries a per-level marker
 * (`levels`), so that emptiness is visible in the output itself:
 * supplied vs not-supplied, plus the option count per level.
 * `status` and `options` are unchanged for every input.
 *
 * Why no producer switch (read before adding one): PR-2's guidance
 * offers two outcomes — the first producer, or an explicit recorded
 * decision to keep the leg dormant with a visible marker. This slice
 * takes the second, deliberately. A producer on/off switch over a
 * producer that does not exist yet would be a phantom: no call site
 * could honor both values, and its tests would pass trivially by
 * construction. The switch belongs to the slice that lands the first
 * producer, with that producer's own Red evidence; it must be added
 * to PORTFOLIO_REPAIR_1732_SWITCHES in that slice, not here.
 * Likewise PR-3's per-endpoint error semantics are pinned, not
 * switched: silently making the bundle fail loud (or analyze
 * swallow) would change a named endpoint contract without an owner
 * decision naming which endpoint changed and why.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PORTFOLIO_REPAIR_1732_PINS,
  PORTFOLIO_REPAIR_1732_SWITCHES,
  portfolioRepairPin,
} from "../src/config/portfolioRepairModes";
import {
  buildRepairOptions,
  type RepairPolicyInput,
} from "../src/services/repairPolicies";
import type { RepairAnalysis } from "../src/services/repairProposals";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const brokerSrc = readFileSync(
  path.join(SRC, "agents/routes/etradeBroker.ts"),
  "utf8",
);
const policiesSrc = readFileSync(
  path.join(SRC, "services/repairPolicies.ts"),
  "utf8",
);

const emptyAnalysis: RepairAnalysis = {
  asOf: "2026-10-27T00:00:00.000Z",
  status: "not-underwater",
  symbolsUnavailable: [],
  unavailableReasons: {},
  proposals: [],
};

describe("portfolio repair remainders registry (#1732)", () => {
  it("adds NO runtime switch, deliberately", () => {
    expect(PORTFOLIO_REPAIR_1732_SWITCHES).toEqual([]);
  });

  it("pins all four appendix-(l) findings, no pair dropped", () => {
    expect(PORTFOLIO_REPAIR_1732_PINS.map((p) => p.id)).toEqual([
      "PR-1",
      "PR-2",
      "PR-3",
      "PR-4",
    ]);
    expect(
      PORTFOLIO_REPAIR_1732_PINS.map((p) => p.resolution),
    ).toEqual(["pinned", "pinned", "pinned", "identical"]);
  });

  it("lookup returns the pin, and undefined for an unknown id", () => {
    expect(portfolioRepairPin("PR-2")?.resolution).toBe("pinned");
    expect(
      portfolioRepairPin("PR-9" as "PR-1"),
    ).toBeUndefined();
  });

  it("PR-1 pin names the contract deltas that must NOT be averaged away", () => {
    const pin = portfolioRepairPin("PR-1")!;
    expect(pin.defaultBehavior).toMatch(/riskRemovedDollars.*null/);
    expect(pin.defaultBehavior).toMatch(/rankScore desc, label asc/);
    expect(policiesSrc).not.toMatch(
      /from\s+["']\.\/strategyComposition["']/,
    );
  });

  it("PR-3 pins the per-endpoint error semantics on current main", () => {
    // Analyze surfaces a producer failure as HTTP 500 …
    expect(brokerSrc).toContain("Failed to generate repair proposals");
    // … while the bundle route swallows it and still returns a bundle.
    expect(brokerSrc).toContain(
      "generateRepairProposals(etrade).catch(() => null)",
    );
    const pin = portfolioRepairPin("PR-3")!;
    expect(pin.defaultBehavior).toMatch(/analyze.*500/);
    expect(pin.defaultBehavior).toMatch(/bundle.*null/);
  });
});

describe("PR-2 visible marker: per-level supplied + count (#1732)", () => {
  it("production shape: ratio supplied, composition structurally empty", () => {
    const out = buildRepairOptions({
      repairAnalysis: emptyAnalysis,
      compositionRepairs: undefined,
    } as RepairPolicyInput);
    // Status and options are UNCHANGED by the marker.
    expect(out.status).toBe("proposals");
    expect(out.options).toHaveLength(0);
    // The marker is what is new: the consumer can now see that the
    // composition leg contributed nothing because it was never
    // supplied — not because it was supplied and came up empty.
    expect(out.levels.ratio_repair.supplied).toBe(true);
    expect(out.levels.ratio_repair.optionCount).toBe(0);
    expect(out.levels.composition.supplied).toBe(false);
    expect(out.levels.composition.optionCount).toBe(0);
  });

  it("test-supplied composition: composition supplied, ratio not", () => {
    const out = buildRepairOptions({
      repairAnalysis: null,
      compositionRepairs: [
        { label: "butterfly", costDollars: 10, detail: "d" },
      ],
    });
    expect(out.status).toBe("proposals");
    expect(out.options).toHaveLength(1);
    expect(out.levels.ratio_repair.supplied).toBe(false);
    expect(out.levels.composition.supplied).toBe(true);
    expect(out.levels.composition.optionCount).toBe(1);
  });

  it("supplied-but-empty composition is distinct from unsupplied", () => {
    const suppliedEmpty = buildRepairOptions({
      repairAnalysis: null,
      compositionRepairs: [],
    });
    expect(suppliedEmpty.levels.composition.supplied).toBe(true);
    expect(suppliedEmpty.levels.composition.optionCount).toBe(0);
    const unsupplied = buildRepairOptions({
      repairAnalysis: null,
      compositionRepairs: undefined,
    });
    expect(unsupplied.levels.composition.supplied).toBe(false);
    // Status logic itself is untouched: neither input supplied
    // with content still yields none_supplied.
    expect(unsupplied.status).toBe("none_supplied");
  });

  it("failed ratio producer (null analysis) marks ratio unsupplied", () => {
    const out = buildRepairOptions({
      repairAnalysis: null,
      compositionRepairs: undefined,
    });
    expect(out.levels.ratio_repair.supplied).toBe(false);
    expect(out.status).toBe("none_supplied");
  });
});
