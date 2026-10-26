/**
 * Shell conformance list (#1804): pages migrated onto PageShell + the
 * route table. Empty in S1 (#1808) — the list grows in S3–S4, one entry
 * per migrated page. Pins list shape: known route ids, no duplicates.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { getRoute } from "../src/client/routes";

describe("shell conformance list", () => {
  it("lists only known route ids, without duplicates", () => {
    const list = JSON.parse(
      readFileSync(join(__dirname, "shell_conformance_1804.json"), "utf8"),
    ) as { migrated: string[] };
    expect(Array.isArray(list.migrated)).toBe(true);
    expect(new Set(list.migrated).size).toBe(list.migrated.length);
    for (const id of list.migrated) {
      expect(getRoute(id)).toBeDefined();
    }
  });
});
