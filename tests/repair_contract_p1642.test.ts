/**
 * Issue #1642 (parent #1638, doc §6) — portfolio repair: one repair
 * model or an explicit two-level contract.
 *
 * DECISION (recorded on #1642, comment 6411555564): explicit
 * two-level contract over ONE proposal contract. The levels are
 * semantically different operations — position-level ratio repair
 * (#355: breakeven/max-recovery, risk removed not directly
 * measurable) vs structural composition repair (leg-graph rewrite,
 * max-loss reduction when the composition gate measured it) — so
 * collapsing them into one computation would invent a number for
 * one level or discard the other's measurement. The contract is
 * `RepairOption` + `buildRepairOptions` in repairPolicies.ts
 * (#1257 C5, ratified here, not rebuilt); the levels survive as
 * RatioRepairPolicy and CompositionRepairPolicy.
 *
 * This file pins what #1642 adds to that ratification:
 *  - Contract hardening: composition costs clamp at zero, matching
 *    the ratio policy (which already clamps via Math.max(0, ...)).
 *    A negative caller-supplied cost must never inflate rankScore.
 *  - Contract boundaries (caller map, source pins): the bundle is
 *    the only RepairOption consumer and reaches repairs only via
 *    buildRepairOptions; the composition policy never imports
 *    strategyComposition, so no unpriced operator outcome can enter
 *    the proposal ranking — composition inputs are caller-supplied
 *    priced candidates by design.
 *  - Dormant-by-design note: no production caller currently supplies
 *    compositionRepairs to the bundle (only tests); the policy is
 *    live code awaiting its first producer, not a live path — see §15.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRepairOptions,
  DEFAULT_REPAIR_POLICIES,
  CompositionRepairPolicy,
} from "../src/services/repairPolicies";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const policiesSrc = readFileSync(path.join(SRC, "services/repairPolicies.ts"), "utf8");
const bundleSrc = readFileSync(path.join(SRC, "services/recommendationBundle.ts"), "utf8");

describe("repair contract decision (#1642 §6)", () => {
  it("exactly two levels survive as policies over one contract", () => {
    expect(DEFAULT_REPAIR_POLICIES.map((p) => p.policyKind)).toEqual([
      "ratio_repair",
      "composition",
    ]);
  });

  it("composition cost clamps at zero: a negative cost never inflates rankScore", () => {
    const out = buildRepairOptions({
      repairAnalysis: null,
      compositionRepairs: [
        { label: "negative cost", costDollars: -50, riskRemovedDollars: 100, detail: "bad input" },
        { label: "legit", costDollars: 10, riskRemovedDollars: 130, detail: "good input" },
      ],
    });
    const bad = out.options.find((o) => o.label === "negative cost")!;
    expect(bad.costDollars).toBe(0);
    expect(bad.rankScore).toBe(100);
    // Legit (130 - 10 = 120) still outranks the clamped entry (100).
    expect(out.options[0].label).toBe("legit");
  });

  it("composition policy maps a negative cost to zero in isolation", () => {
    const policy = new CompositionRepairPolicy();
    const [opt] = policy.options({
      compositionRepairs: [{ label: "x", costDollars: -5, detail: "d" }],
    });
    expect(opt.costDollars).toBe(0);
    expect(opt.rankScore).toBe(0);
  });
});

describe("repair caller map (#1642 §6)", () => {
  it("the composition policy never imports strategyComposition (priced inputs only)", () => {
    expect(policiesSrc).not.toMatch(/from\s+["']\.\/strategyComposition["']/);
  });

  it("the bundle reaches repairs only via buildRepairOptions", () => {
    expect(bundleSrc).toContain("buildRepairOptions");
    // Value import of the position producer would be a bypass; the
    // bundle imports only the RepairAnalysis TYPE from that module.
    expect(bundleSrc).not.toMatch(/import\s+\{[^}]*\bgenerateRepairProposals\b[^}]*\}\s+from/);
    expect(bundleSrc).toMatch(/import type\s+\{[^}]*\bRepairAnalysis\b[^}]*\}\s+from\s+["']\.\/repairProposals["']/);
  });
});
