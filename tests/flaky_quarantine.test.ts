/**
 * Flake quarantine registry pin (#2070, gitops §18.3).
 *
 * tests/flaky-quarantine.json lists suites quarantined on EVIDENCE
 * (same suite passes standalone on the same tree; merge-time failures
 * compared against unmodified main). An entry is a remediation
 * backlog item — fix, or quarantine with a tracked issue — never a
 * permanent exemption. An empty registry is the healthy state: it
 * means no suite has reproduced as flaky.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

interface QuarantineEntry {
  file: string;
  owner: string;
  issue: number;
  evidence: string;
  quarantinedSince: string;
}

function readRegistry(): QuarantineEntry[] {
  const raw = fs.readFileSync(
    path.join(process.cwd(), "tests/flaky-quarantine.json"),
    "utf8",
  );
  const parsed: unknown = JSON.parse(raw);
  expect(Array.isArray(parsed)).toBe(true);
  return parsed as QuarantineEntry[];
}

describe("flake quarantine registry (#2070)", () => {
  it("every entry names a real suite with an owner, a tracking issue, and evidence", () => {
    const entries = readRegistry();
    const seen = new Set<string>();
    for (const entry of entries) {
      expect(typeof entry.file).toBe("string");
      expect(entry.file.startsWith("tests/")).toBe(true);
      expect(
        fs.existsSync(path.join(process.cwd(), entry.file)),
        `quarantined file missing: ${entry.file}`,
      ).toBe(true);
      expect(seen.has(entry.file)).toBe(false);
      seen.add(entry.file);
      expect(typeof entry.owner).toBe("string");
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(Number.isInteger(entry.issue)).toBe(true);
      expect(entry.issue).toBeGreaterThan(0);
      expect(typeof entry.evidence).toBe("string");
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.quarantinedSince)).toBe(true);
    }
  });
});
