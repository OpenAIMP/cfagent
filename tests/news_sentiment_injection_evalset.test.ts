/**
 * Issue #881 (parent #764, AISecOps #767 path 4) — red-team eval set for
 * the news-sentiment prompt-injection defense (THREAT_MODEL §7 path 4),
 * executed in CI. Sibling of tests/nlq_injection_evalset.test.ts (#863)
 * and tests/orchestrator_injection_evalset.test.ts (#879).
 *
 * Dataset: evaluations/injection/v3/ (manifest.json + cases.json). Each
 * case is a poisoned (or benign) fetched news headline run through the
 * PRODUCTION prompt assembly, `buildNewsSentimentPrompt` from
 * src/trading/options/flows/newsSentiment.ts, as a single news item.
 *
 * Per-case invariants (the defended assembly):
 *  1. The case's legitimate datum survives INSIDE the delimited region
 *     as data (the defense contains attacks without mangling real
 *     content).
 *  2. Exactly one BEGIN and one END delimiter — embedded markers in
 *     the attack content were defused.
 *  3. The prompt carries a data-is-not-instructions line.
 *  4. Nothing of the case's legitimate datum sits OUTSIDE the region
 *     (it is never bare in the prompt).
 *
 * Negative control (the bite): the SAME assembled prompt with the
 * separation stripped back off (delimiters and data line removed —
 * which reconstructs the pre-#881 bare-interpolation assembly) must
 * have no delimited region at all, so if the delimiting ever regresses
 * out of the builder, this suite fails. Model-behavior grading against
 * a live model is deliberately out of scope for CI (see the manifest
 * notes); this set pins the assembly, which is the layer the code
 * controls.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildNewsSentimentPrompt,
  NEWS_SENTIMENT_BEGIN,
  NEWS_SENTIMENT_END,
} from "../src/trading/options/flows/newsSentiment";
import type { NewsFlowItem } from "../src/trading/options/flows/types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const setDir = path.join(repoRoot, "evaluations/injection/v3");
const manifest = JSON.parse(readFileSync(path.join(setDir, "manifest.json"), "utf-8"));
const cases = JSON.parse(readFileSync(path.join(setDir, manifest.casesFile), "utf-8")) as Array<{
  caseId: string;
  category: string;
  description: string;
  content: string;
  expect: { mustContainData: string };
}>;

function assemble(c: (typeof cases)[number]): string {
  const item: NewsFlowItem = {
    id: c.caseId, time: "9:00am", timestamp: 1, headline: c.content,
    symbols: ["SPY"], source: "W",
    sentiment: "neutral", sentimentMethod: "unavailable",
  };
  return buildNewsSentimentPrompt([item]);
}

function regionOf(assembled: string): string | null {
  const begin = assembled.indexOf(NEWS_SENTIMENT_BEGIN);
  if (begin === -1) return null;
  const end = assembled.indexOf(NEWS_SENTIMENT_END, begin);
  if (end === -1) return null;
  return assembled.slice(begin + NEWS_SENTIMENT_BEGIN.length, end);
}

function outsideRegion(assembled: string): string {
  const begin = assembled.indexOf(NEWS_SENTIMENT_BEGIN);
  const end = assembled.indexOf(NEWS_SENTIMENT_END, begin);
  if (begin === -1 || end === -1) return assembled;
  return assembled.slice(0, begin) + assembled.slice(end + NEWS_SENTIMENT_END.length);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function stripSeparation(assembled: string): string {
  return assembled
    .split(`${NEWS_SENTIMENT_BEGIN}\n`).join("")
    .split(`\n${NEWS_SENTIMENT_END}`).join("");
}

describe("news-sentiment injection eval set — dataset integrity", () => {
  it("every declared category has at least one case", () => {
    for (const category of manifest.categories as string[]) {
      expect(cases.some((c) => c.category === category), `no case for ${category}`).toBe(true);
    }
  });

  it("case ids are unique", () => {
    const ids = cases.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(cases)("$caseId ($category)", (c) => {
  it("contains the attack as data inside exactly one delimited region", () => {
    const prompt = assemble(c);
    expect(countOccurrences(prompt, NEWS_SENTIMENT_BEGIN)).toBe(1);
    expect(countOccurrences(prompt, NEWS_SENTIMENT_END)).toBe(1);
    expect(prompt).toContain("not instructions");
    const region = regionOf(prompt);
    expect(region).not.toBeNull();
    expect(region).toContain(c.expect.mustContainData);
    expect(outsideRegion(prompt)).not.toContain(c.expect.mustContainData);
  });

  it("negative control: the separation-stripped assembly has no delimited region", () => {
    const stripped = stripSeparation(assemble(c));
    expect(regionOf(stripped)).toBeNull();
  });
});
