import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Platform Decoupling & Agnosticism Assessment Document", () => {
  const docPath = path.join(
    process.cwd(),
    "docs/architecture/enterprise/assessment/platform-decoupling-and-native-roadmap.md"
  );

  it("should exist in the docs/architecture/enterprise/assessment directory", () => {
    expect(fs.existsSync(docPath)).toBe(true);
  });

  it("should contain required architectural sections", () => {
    const content = fs.readFileSync(docPath, "utf8");

    // Check Agnosticism section
    expect(content).toContain("Platform Agnosticism Blueprint");
    expect(content).toContain("Cloud Agnosticism");
    expect(content).toContain("Technology & Database Agnosticism");
    expect(content).toContain("Framework & Runtime Agnosticism");

    // Check Native Capabilities section
    expect(content).toContain("Native Capabilities Framework");
    expect(content).toContain("AI-Native");
    expect(content).toContain("API-Native");
    expect(content).toContain("MCP-Native");
    expect(content).toContain("Agentic-Native");
    expect(content).toContain("Data-Native");

    // Check Governance section
    expect(content).toContain("Governance Architecture");
    expect(content).toContain("AI Governance");
    expect(content).toContain("Data Governance");
    expect(content).toContain("Application & Security Governance");

    // Check Platform Improvements section
    expect(content).toContain("Platform Improvement & Optimization Blueprint");

    // Check Decoupling Blueprint section
    expect(content).toContain("Decoupling Blueprint: Zero-Modification Cloud Deployment");
    expect(content).toContain("GCP Cloud Run Step-by-Step Execution Blueprint");
  });
});
