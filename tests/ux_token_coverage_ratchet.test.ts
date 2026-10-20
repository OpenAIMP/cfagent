import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UX token coverage gate (Phase 2 of #137, issue #470; completed in
 * Phase 6, #476).
 *
 * Raw color literals (hex + rgb/hsl functional notation) may only live in
 * the token sources (src/client/tokens.css and src/client/designTokens.ts).
 * The Phase 2–6 ratchet drove the count from the Phase 0 baseline of 3,105
 * to ZERO; the per-file ceiling allowlist was deleted when it reached zero
 * (its history lives in git and in plans/UX/baseline/). Any raw literal
 * anywhere else in src/client now fails outright — add a token instead.
 *
 * Also pinned: theme-class selectors (.dark/.light/.theme-*) are banned in
 * CSS outside tokens.css — `data-theme` is the sanctioned mechanism
 * (legacy adapters themselves were removed in Phase 4, #474).
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

describe("UX token coverage gate (#470, #476)", () => {
  it("no raw color literals anywhere in src/client outside the token sources", () => {
    const counts = scan();
    const violations: string[] = [];
    for (const [file, n] of counts) {
      violations.push(`${file}: ${n} raw color literals (add tokens, not literals)`);
    }
    expect(violations).toEqual([]);
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
