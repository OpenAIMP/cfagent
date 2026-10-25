import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Issue #411 (Tests checklist) — no test may reach the live LLM binding.
 *
 * Audit result (2026-10-20): every `AI:` binding in the suite is inert
 * (`{}` — an object with no `run` method) or an explicit stub
 * (`{ run: vi.fn() }`, `{ run: async () => ... }`). No test passes a real
 * env through. This pin keeps that true: it scans every test file's `AI:`
 * binding sites and fails on any shape that could carry a live binding.
 *
 * This file is excluded from its own scan: it necessarily contains the
 * binding syntax it searches for.
 */
const SELF = "no_live_ai_binding.test.ts";
const TESTS_DIR = join(__dirname);

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...testFiles(p));
    else if (/\.test\.tsx?$/.test(name) && name !== SELF) out.push(p);
  }
  return out;
}

/** An RHS is safe iff it is an empty object, an explicit run-stub, or absent. */
function isInertBinding(rhs: string): boolean {
  const t = rhs.trimStart();
  return (
    /^\{\s*\}/.test(t) || // {} (optionally followed by `as any` / `as never`)
    /^\{\s*run\b/.test(t) || // { run: ... } — an explicit stub
    /^undefined\b/.test(t) ||
    /^null\b/.test(t)
  );
}

describe("no test reaches the live LLM binding (#411)", () => {
  it("every AI: binding in the test suite is inert or an explicit stub", () => {
    const violations: string[] = [];
    let sites = 0;
    for (const file of testFiles(TESTS_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        const re = /\bAI:\s*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          sites += 1;
          const rhs = line.slice(m.index + m[0].length);
          if (!isInertBinding(rhs)) {
            violations.push(
              `${file.split("/").pop()}:${i + 1} — AI: ${rhs.trim().slice(0, 60)}`
            );
          }
        }
      });
    }
    // Sanity: the scan must actually find the suite's binding sites, or the
    // pin is vacuous (a broken scan must fail loudly, not pass silently).
    expect(sites).toBeGreaterThanOrEqual(30);
    expect(violations).toEqual([]);
  });
});
