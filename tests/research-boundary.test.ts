/**
 * Issue #319 — read-only research boundary enforcement.
 *
 * The research agent NEVER submits, modifies, or cancels orders. This test
 * fails the suite if any research module gains an import path to an
 * order-placement function or references order-mutation symbols.
 *
 * Mirrors tests/trading-boundary.test.ts (issue #290).
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname, "../src");

const RESEARCH_FILES = [
  "services/researchEconomics.ts",
  "services/researchGates.ts",
  "services/researchConfig.ts",
  "services/researchFalsification.ts",
  "services/researchPipeline.ts",
  "services/researchProviders.ts",
  "services/researchTriggers.ts",
  "agents/research-agent.ts",
];

/** Order-mutation symbols that must never appear in research code. */
const ORDER_SYMBOLS = [
  "placeOrderRemote",
  "previewOrder",
  "submitOrder",
  "executeOrder",
  "cancelOrder",
  "modifyOrder",
  "placeOrder",
];

const SPECIFIER_RE =
  /(?:from\s*|import\s*\(\s*|export\s+(?:\*|\{[^}]*\}|type\s*\{[^}]*\})\s*from\s*)["']([^"']+)["']/g;

describe("research read-only boundary (issue #319)", () => {
  it("every research module exists", () => {
    for (const rel of RESEARCH_FILES) {
      expect(fs.existsSync(path.join(SRC, rel)), rel).toBe(true);
    }
  });

  it("no research module references order-mutation symbols", () => {
    const violations: string[] = [];
    for (const rel of RESEARCH_FILES) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      for (const sym of ORDER_SYMBOLS) {
        const re = new RegExp(`\\b${sym}\\b`);
        if (re.test(text)) {
          violations.push(`${rel} references ${sym}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no research module imports a trading-internal path (boundary #290)", () => {
    const violations: string[] = [];
    const tradingDir = path.join(SRC, "trading");
    const indexFile = path.join(tradingDir, "index.ts");
    for (const rel of RESEARCH_FILES) {
      const file = path.join(SRC, rel);
      const text = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      SPECIFIER_RE.lastIndex = 0;
      while ((m = SPECIFIER_RE.exec(text)) !== null) {
        const spec = m[1];
        if (!spec.startsWith(".")) continue;
        const resolved = path.normalize(path.join(path.dirname(file), spec));
        if (
          resolved.startsWith(tradingDir + path.sep) &&
          resolved !== indexFile &&
          resolved !== tradingDir
        ) {
          violations.push(`${rel} -> ${path.relative(SRC, resolved)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("the research UI never invokes the trade-preview callback", () => {
    const ui = path.join(SRC, "client/options/ResearchRunsPanel.tsx");
    const text = fs.readFileSync(ui, "utf8");
    expect(text).not.toMatch(/onPreviewTrade\s*\(/);
  });
});
