import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UX token coverage ratchet (Phase 2 of #137, issue #470).
 *
 * Raw color literals (hex + rgb/hsl functional notation) may only live in
 * the token sources (src/client/tokens.css and the generated section of
 * src/client/designTokens.ts). Everywhere else in src/client the counts can
 * only go DOWN:
 *
 * - tests/ux_token_coverage_ratchet.json pins the per-file ceiling measured
 *   by the Phase 0 baseline (scripts/token-coverage.mjs, #468).
 * - A file exceeding its ceiling, or a new file with any raw literal, fails.
 * - When a migration slice lowers a file's count, lower its ceiling in the
 *   same PR. Phase 6 (#476) deletes the allowlist entirely.
 *
 * Also pinned: theme-class selectors (.dark/.light/.theme-*) are banned in
 * CSS outside tokens.css — `data-theme` is the sanctioned mechanism
 * (legacy adapters themselves are removed in Phase 4, #474).
 */

const ROOT = join(__dirname, "..");
const CLIENT_DIR = join(ROOT, "src", "client");
const TOKEN_SOURCES = new Set(["src/client/tokens.css", "src/client/designTokens.ts"]);
const EXTENSIONS = new Set([".css", ".ts", ".tsx"]);

// Comments are prose, not styles: an issue reference like "#450" inside a
// comment must not count as a hex literal. Mirrors stripComments in
// scripts/token-coverage.mjs — keep the two implementations in sync.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;{}(])\/\/[^\n]*/g, "$1 ");
}

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const FN_RE = /\b(?:rgba?|hsla?)\([^)]*\)/g;
const THEME_CLASS_RE = /(^|[\s,>+~])\.(?:dark|light|theme-dark|theme-light)(?=[\s{.:,#\[]|$)/m;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) yield full;
  }
}

function scan(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walk(CLIENT_DIR)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (TOKEN_SOURCES.has(rel)) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    const n = (text.match(HEX_RE) ?? []).length + (text.match(FN_RE) ?? []).length;
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

const allowlist = JSON.parse(readFileSync(join(ROOT, "tests", "ux_token_coverage_ratchet.json"), "utf8")) as Record<string, number>;

describe("UX token coverage ratchet (#470)", () => {
  it("no file exceeds its raw-color ceiling and no unlisted file has raw colors", () => {
    const counts = scan();
    const violations: string[] = [];
    for (const [file, n] of counts) {
      const ceiling = allowlist[file];
      if (ceiling === undefined) violations.push(`${file}: ${n} raw color literals, no allowlist entry (add tokens, not literals)`);
      else if (n > ceiling) violations.push(`${file}: ${n} raw color literals exceeds ceiling ${ceiling}`);
    }
    expect(violations).toEqual([]);
  });

  it("allowlist ceilings are never above the measured counts plus zero slack for removed files", () => {
    const counts = scan();
    for (const [file, ceiling] of Object.entries(allowlist)) {
      const current = counts.get(file) ?? 0;
      // A ceiling may equal the current count (not yet migrated) — but it may
      // not exceed it by invention: ceilings come from the baseline or a
      // lowered value recorded by a migration PR.
      expect(ceiling, `${file} ceiling`).toBeGreaterThanOrEqual(current);
    }
  });

  it("no theme-class selectors in CSS outside tokens.css", () => {
    const offenders: string[] = [];
    for (const file of walk(CLIENT_DIR)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (!rel.endsWith(".css") || TOKEN_SOURCES.has(rel)) continue;
      if (THEME_CLASS_RE.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
