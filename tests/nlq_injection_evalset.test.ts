/**
 * Issue #863 (parent #767) — red-team eval set for the email→NLQ
 * prompt-injection defense (#862), executed in CI.
 *
 * Dataset: evaluations/injection/v1/ (manifest.json + cases.json), in the
 * conventions of evaluations/datasets/v1. Each case is an email
 * (subject + body) run through the PRODUCTION prompt assembly —
 * `plannerPrompt` / `withUntrustedRule` from src/agents/nlq/llmPlanning.ts —
 * exactly as the email handler concatenates it (subject + " " + body).
 *
 * Per-case invariants (the defended assembly):
 *  1. The prompt is delimiter-wrapped (BEGIN … END).
 *  2. Exactly ONE real END delimiter exists — embedded markers in the
 *     attack content were defused, so nothing escapes the data region.
 *  3. The case's legitimate request survives INSIDE the region as data
 *     (the defense contains attacks without mangling real asks).
 *  4. The system prompt carries the data-is-not-instructions rule.
 *
 * Negative control (the bite): the SAME case assembled WITHOUT the defense
 * must violate invariants 1–2 — so if the untrusted flag threading ever
 * regresses (email stops flagging, planner stops wrapping), this suite
 * fails. Model-behavior grading against a live model is deliberately out
 * of scope for CI (see the manifest notes); this set pins the assembly,
 * which is the layer the code controls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  plannerPrompt,
  withUntrustedRule,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  UNTRUSTED_CONTENT_RULE,
} from "../src/agents/nlq/llmPlanning";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setDir = path.join(repoRoot, "evaluations/injection/v1");
const manifest = JSON.parse(readFileSync(path.join(setDir, "manifest.json"), "utf-8"));
const cases = JSON.parse(readFileSync(path.join(setDir, manifest.casesFile), "utf-8")) as Array<{
  caseId: string;
  category: string;
  description: string;
  subject: string;
  body: string;
  expect: { mustContainData: string };
}>;

/** The email handler's concatenation (src/trading/email/agent.ts). */
function emailPrompt(c: { subject: string; body: string }): string {
  return (c.subject.trim() + " " + c.body.trim()).trim();
}

function region(assembled: string): string {
  const start = assembled.indexOf(UNTRUSTED_BEGIN) + UNTRUSTED_BEGIN.length;
  const end = assembled.lastIndexOf(UNTRUSTED_END);
  return assembled.slice(start, end);
}

describe("injection eval set — dataset integrity", () => {
  it("is versioned with a manifest that names its runner", () => {
    expect(manifest.version).toBe("v1");
    expect(manifest.runner).toContain("nlq_injection_evalset");
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThanOrEqual(8);
  });

  it("has unique case ids", () => {
    const ids = cases.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every attack category the manifest declares", () => {
    const present = new Set(cases.map((c) => c.category));
    for (const cat of manifest.categories as string[]) {
      expect(present.has(cat), `missing category: ${cat}`).toBe(true);
    }
  });

  it("every case carries a data-survival expectation", () => {
    for (const c of cases) {
      expect(c.expect.mustContainData.length).toBeGreaterThan(0);
      expect(emailPrompt(c)).toContain(c.expect.mustContainData);
    }
  });
});

describe("injection eval set — defended assembly invariants", () => {
  for (const c of cases) {
    it(`${c.caseId} (${c.category}): attack contained as data, legitimate ask preserved`, () => {
      const content = emailPrompt(c);
      const assembled = plannerPrompt(content, true);
      const system = withUntrustedRule("You are an NLQ planner.", true);

      // 1. Delimiter-wrapped.
      expect(assembled.startsWith(UNTRUSTED_BEGIN + "\n")).toBe(true);
      expect(assembled.endsWith("\n" + UNTRUSTED_END)).toBe(true);
      // 2. Exactly one real END delimiter — no escape.
      expect(assembled.split(UNTRUSTED_END)).toHaveLength(2);
      // 3. Legitimate request survives inside the region as data.
      expect(region(assembled)).toContain(c.expect.mustContainData);
      // 4. System prompt carries the rule.
      expect(system).toContain(UNTRUSTED_CONTENT_RULE);
      expect(system).toContain("strictly as DATA");
    });

    it(`${c.caseId} (${c.category}): NEGATIVE CONTROL — undefended assembly fails the invariants`, () => {
      const content = emailPrompt(c);
      const undefended = plannerPrompt(content, false);
      const wrapped =
        undefended.startsWith(UNTRUSTED_BEGIN + "\n") &&
        undefended.endsWith("\n" + UNTRUSTED_END) &&
        undefended.split(UNTRUSTED_END).length === 2;
      expect(wrapped).toBe(false);
    });
  }
});
