/**
 * Issue #1423 (F1, sub-issue of #1070) — dimension registry pin test.
 *
 * The #1069 dimension classification lives as a machine-readable registry
 * in docs/plans/dimension-registry.json. The plan's core rule is pinned
 * here, not in prose: a dimension is never `supported` because an
 * interface or a configuration field exists; supported means a
 * verification reference resolves to a test that passes.
 *
 * Pinned rules:
 *  - the registry parses and every entry carries dimension / status /
 *    owner / evidence;
 *  - every #1069 dimension group from the plan table is present exactly
 *    once (no silent drops, no unplanned additions);
 *  - no `supported` without a resolving verification reference, of the
 *    form "path/to/test.ts :: describe-substring :: it-substring"
 *    (file exists in this repo and contains both substrings);
 *    the failure message names the dimension;
 *  - `out_of_scope` entries cite the #1070 owner-decision requirement
 *    in their evidence.
 *
 * Scope guard: this test pins the registry ONLY. It does not build any
 * dimension capability and it does not change any dimension's status
 * on its own — a status change is a registry edit, reviewed with it.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The 16 dimension groups of the #1069 classification table, as recorded
// in docs/plans/multi-dimensional-system-plan-2026-10-22.md (2026-10-22
// snapshot). The registry is the living record; this list is the
// no-silent-drops check against the plan table.
const PLAN_GROUPS = [
  "Multi-tenant, multi-user, multi-membership, multi-workspace",
  "Multi-role, multi-scope authorization",
  "Multi-identity-provider",
  "Multi-authentication-method",
  "Multi-principal, multi-delegation",
  "Multi-session",
  "Shared execution context (#1069 §8)",
  "Multi-service, multi-agent, multi-model",
  "Multi-provider (brokerage)",
  "Multi-connection, multi-account",
  "Multi-plan, entitlements, metering, budgets",
  "Multi-environment",
  "Versioned contracts",
  "Tenant-scoped audit and recovery",
  "Multi-currency, multi-language, multi-brand, multi-region, dedicated tenant deployments, agent marketplace, multiple payment processors, cross-organization collaboration",
  "Multi-cloud, active-active global writes, arbitrary executable plugins, automatic live-trade/payment provider fallback, every agent protocol, a microservice per capability, shared learning from private tenant data",
];

const STATUSES = new Set([
  "supported",
  "extension_ready",
  "partial",
  "planned",
  "out_of_scope",
]);

const ROOT = join(__dirname, "..");
const REGISTRY_PATH = join(ROOT, "docs", "plans", "dimension-registry.json");

type RegistryEntry = {
  dimension: string;
  status: string;
  owner: string;
  evidence: string;
  verification: string | null;
};

function loadRegistry(): RegistryEntry[] {
  expect(
    existsSync(REGISTRY_PATH),
    "dimension registry missing: docs/plans/dimension-registry.json",
  ).toBe(true);
  const parsed = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as {
    entries: RegistryEntry[];
  };
  expect(Array.isArray(parsed.entries)).toBe(true);
  return parsed.entries;
}

function verificationResolves(verification: string): boolean {
  const parts = verification.split("::").map((p) => p.trim());
  if (parts.length !== 3) return false;
  const [file, describePart, itPart] = parts;
  const path = join(ROOT, file);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  return text.includes(describePart) && text.includes(itPart);
}

describe("dimension registry (#1423, #1069)", () => {
  it("parses and every entry carries dimension/status/owner/evidence", () => {
    const entries = loadRegistry();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.dimension, "entry missing dimension").toBeTruthy();
      expect(
        STATUSES.has(entry.status),
        `dimension "${entry.dimension}" has unknown status "${entry.status}"`,
      ).toBe(true);
      expect(entry.owner, `dimension "${entry.dimension}" missing owner`).toBeTruthy();
      expect(
        entry.evidence,
        `dimension "${entry.dimension}" missing evidence`,
      ).toBeTruthy();
      expect(
        entry.verification === null || typeof entry.verification === "string",
        `dimension "${entry.dimension}" has a non-string, non-null verification`,
      ).toBe(true);
    }
  });

  it("covers every #1069 plan group exactly once, no drops, no extras", () => {
    const entries = loadRegistry();
    const dimensions = entries.map((e) => e.dimension);
    expect(new Set(dimensions).size, "duplicate dimension entries").toBe(
      dimensions.length,
    );
    expect([...dimensions].sort()).toEqual([...PLAN_GROUPS].sort());
  });

  it("no supported without a resolving verification reference", () => {
    const entries = loadRegistry();
    for (const entry of entries) {
      if (entry.status !== "supported") continue;
      expect(
        entry.verification,
        `dimension "${entry.dimension}" is marked supported without a verification reference`,
      ).toBeTruthy();
      expect(
        verificationResolves(entry.verification as string),
        `dimension "${entry.dimension}" is marked supported but its verification ` +
          `"${entry.verification}" does not resolve to an existing test file with the named suite/case`,
      ).toBe(true);
    }
  });

  it("out_of_scope entries cite the #1070 owner-decision requirement", () => {
    const entries = loadRegistry();
    for (const entry of entries) {
      if (entry.status !== "out_of_scope") continue;
      expect(
        entry.evidence.includes("#1070") &&
          entry.evidence.toLowerCase().includes("owner decision"),
        `dimension "${entry.dimension}" is out_of_scope but its evidence does not cite the #1070 owner-decision requirement`,
      ).toBe(true);
    }
  });
});
