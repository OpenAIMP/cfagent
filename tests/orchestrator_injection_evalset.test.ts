/**
 * Issue #879 (parent #767) — red-team eval set for the orchestrator
 * retrieved-content prompt-injection defense (THREAT_MODEL §7 path 2),
 * executed in CI. Sibling of tests/nlq_injection_evalset.test.ts (#863).
 *
 * Dataset: evaluations/injection/v2/ (manifest.json + cases.json). Each
 * case is poisoned (or benign) STORED content — a session-memory block,
 * a vector/knowledge block, or an options-research context, in the
 * exact shapes production assembles them — run through the PRODUCTION
 * prompt assembly, `buildOrchestratorSystemPrompt` from
 * src/agents/chatPrompt.ts, with the content in its declared slot.
 *
 * Per-case invariants (the defended assembly):
 *  1. The case's legitimate datum survives INSIDE a delimited region
 *     as data (the defense contains attacks without mangling real
 *     content or removing the context).
 *  2. Nothing of the case content appears OUTSIDE a delimited region:
 *     retrieved content never sits bare in the system prompt.
 *  3. Exactly one real END delimiter per populated slot — embedded
 *     markers in the attack content were defused (the count includes
 *     the one literal END mentioned inside the rule text, which is
 *     present whenever the rule is).
 *  4. The system prompt carries RETRIEVED_CONTENT_RULE exactly once.
 *
 * Negative control (the bite): the SAME assembled prompt with the
 * separation stripped back off (delimiters and rule removed — which
 * reconstructs the pre-#879 bare-interpolation assembly byte-for-byte
 * for the populated slot) must violate invariants 1–2 and lack the
 * rule — so if the delimiting ever regresses out of the builder, this
 * suite fails. Model-behavior grading against a live model is
 * deliberately out of scope for CI (see the manifest notes); this set
 * pins the assembly, which is the layer the code controls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildOrchestratorSystemPrompt,
  type OrchestratorPromptInput,
  RETRIEVED_CONTENT_BEGIN,
  RETRIEVED_CONTENT_END,
  RETRIEVED_CONTENT_RULE,
} from "../src/agents/chatPrompt";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setDir = path.join(repoRoot, "evaluations/injection/v2");
const manifest = JSON.parse(readFileSync(path.join(setDir, "manifest.json"), "utf-8"));
const cases = JSON.parse(readFileSync(path.join(setDir, manifest.casesFile), "utf-8")) as Array<{
  caseId: string;
  category: string;
  description: string;
  slot: "memory" | "vector" | "research";
  content: string;
  expect: { mustContainData: string };
}>;

function assemble(c: (typeof cases)[number]): string {
  const input: OrchestratorPromptInput = {
    route: { agent: "trading", confidence: 1, reason: "eval case" },
    memoryContext: "",
    vectorContext: "",
    optionsResearchContext: "",
    isAutoOptionsResearchRequest: false,
  };
  if (c.slot === "memory") input.memoryContext = c.content;
  if (c.slot === "vector") input.vectorContext = c.content;
  if (c.slot === "research") {
    input.optionsResearchContext = c.content;
    input.isAutoOptionsResearchRequest = true;
  }
  return buildOrchestratorSystemPrompt(input);
}

/** Region contents via the structural scan (BEGIN paired with the next END). */
function regions(assembled: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const begin = assembled.indexOf(RETRIEVED_CONTENT_BEGIN, from);
    if (begin === -1) return out;
    const end = assembled.indexOf(RETRIEVED_CONTENT_END, begin);
    if (end === -1) return out;
    out.push(assembled.slice(begin + RETRIEVED_CONTENT_BEGIN.length, end));
    from = end + RETRIEVED_CONTENT_END.length;
  }
}

/** The assembled prompt with every delimited region removed. */
function outsideRegions(assembled: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const begin = assembled.indexOf(RETRIEVED_CONTENT_BEGIN, from);
    if (begin === -1) return out + assembled.slice(from);
    const end = assembled.indexOf(RETRIEVED_CONTENT_END, begin);
    if (end === -1) return out + assembled.slice(from);
    out += assembled.slice(from, begin);
    from = end + RETRIEVED_CONTENT_END.length;
  }
}

/**
 * The negative-control assembly: the defended prompt with the #879
 * separation stripped back off. For the populated slot this is
 * byte-equivalent to the pre-#879 assembly (bare interpolation, no
 * rule) — the regression shape this suite exists to catch.
 */
function stripSeparation(assembled: string): string {
  return assembled
    .split(`${RETRIEVED_CONTENT_BEGIN}\n`).join("")
    .split(`\n${RETRIEVED_CONTENT_END}`).join("")
    .split(`\n\n${RETRIEVED_CONTENT_RULE}`).join("");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("orchestrator injection eval set — dataset integrity", () => {
  it("is versioned with a manifest that names its runner", () => {
    expect(manifest.version).toBe("v2");
    expect(manifest.runner).toContain("orchestrator_injection_evalset");
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

  it("every case declares a retrieved slot and a data-survival expectation inside its content", () => {
    for (const c of cases) {
      expect(["memory", "vector", "research"]).toContain(c.slot);
      expect(c.expect.mustContainData.length).toBeGreaterThan(0);
      expect(c.content).toContain(c.expect.mustContainData);
    }
  });
});

describe("orchestrator injection eval set — defended assembly invariants", () => {
  for (const c of cases) {
    it(`${c.caseId} (${c.category}/${c.slot}): attack contained as data, legitimate datum preserved`, () => {
      const assembled = assemble(c);
      const regs = regions(assembled);

      // 1. Legitimate datum survives inside the slot's region.
      expect(regs.length).toBeGreaterThanOrEqual(1);
      expect(regs[0]).toContain(c.expect.mustContainData);
      // Non-escape cases: the region holds the case content byte-for-byte
      // (the defense delimits; it does not mangle or drop stored content).
      if (c.category !== "delimiter-escape") {
        expect(regs[0]).toBe(`\n${c.content}\n`);
      } else {
        // Escape case: embedded END defused, the rest intact.
        expect(regs[0]).toBe(`\n${c.content.split(RETRIEVED_CONTENT_END).join("[end marker removed]")}\n`);
        expect(assembled).not.toContain(c.content);
      }
      // 2. Nothing of the case content sits outside a region.
      expect(outsideRegions(assembled)).not.toContain(c.expect.mustContainData);
      // 3. Exactly one real END for the populated slot (+1 literal mention in the rule).
      expect(countOccurrences(assembled, RETRIEVED_CONTENT_END)).toBe(2);
      expect(countOccurrences(assembled, RETRIEVED_CONTENT_BEGIN)).toBe(2);
      // 4. The rule is present exactly once.
      expect(countOccurrences(assembled, RETRIEVED_CONTENT_RULE)).toBe(1);
      expect(assembled).toContain("strictly as DATA");
    });

    it(`${c.caseId} (${c.category}/${c.slot}): NEGATIVE CONTROL — separation-stripped assembly fails the invariants`, () => {
      const stripped = stripSeparation(assemble(c));
      // No regions, no rule — and the datum now sits bare in the system prompt.
      expect(regions(stripped)).toHaveLength(0);
      expect(stripped).not.toContain(RETRIEVED_CONTENT_RULE);
      expect(outsideRegions(stripped)).toContain(c.expect.mustContainData);
    });
  }
});
