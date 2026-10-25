import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Gitleaks configuration and allowlists", () => {
  const root = process.cwd();
  const configPath = path.join(root, ".gitleaks.toml");
  const ignorePath = path.join(root, ".gitleaksignore");

  it("maintains .gitleaks.toml extending default rules with required allowlists", () => {
    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[extend]");
    expect(content).toContain("useDefault = true");
    expect(content).toContain("[allowlist]");
    expect(content).toContain("tests/.*");
    expect(content).toContain("docs/.*");
    expect(content).toContain("commits = [");
  });

  it("maintains .gitleaksignore with historical suppression fingerprints", () => {
    expect(fs.existsSync(ignorePath)).toBe(true);
    const content = fs.readFileSync(ignorePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const line of lines) {
      expect(line.trim()).toMatch(/^[a-f0-9]{40}:.+:.+:\d+$/);
    }
  });
});
