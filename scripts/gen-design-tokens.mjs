#!/usr/bin/env node
/**
 * Generates the TS token mirror in src/client/designTokens.ts from the
 * single source of truth: src/client/tokens.css (UX token architecture,
 * #137 / Phase 1 #469).
 *
 * Usage:
 *   node scripts/gen-design-tokens.mjs           # regenerate designTokens.ts
 *   node scripts/gen-design-tokens.mjs --check   # exit 1 if it is stale
 *
 * The mirror exists for consumers CSS variables cannot reach (charts,
 * canvas, generated SVG, PDF). It is a values map over the semantic
 * --color-* roles of the dark and light token maps. Never hand-edit the
 * generated section; edit tokens.css and re-run this script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CSS_PATH = join(ROOT, "src", "client", "tokens.css");
const TS_PATH = join(ROOT, "src", "client", "designTokens.ts");
const BEGIN = "/* BEGIN GENERATED TOKENS — scripts/gen-design-tokens.mjs — do not edit by hand */";
const END = "/* END GENERATED TOKENS */";

function extractMap(css, marker) {
  const at = css.indexOf(marker);
  if (at === -1) throw new Error(`marker not found: ${marker}`);
  const start = css.indexOf("{", at);
  let depth = 0;
  let end = start;
  for (; end < css.length; end += 1) {
    if (css[end] === "{") depth += 1;
    else if (css[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = css.slice(start + 1, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const map = {};
  for (const decl of body.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) map[decl[1]] = decl[2].trim();
  return map;
}

const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""); // strip comments: the header documents the markers
const generated = {
  dark: extractMap(css, '[data-theme="dark"]'),
  light: extractMap(css, '[data-theme="light"]'),
  "high-contrast": extractMap(css, '[data-theme="high-contrast"]'),
};

const section = [
  BEGIN,
  "/** Semantic --color-* values per theme, generated from tokens.css. */",
  `export const generatedThemeTokens: Record<\"dark\" | \"light\" | \"high-contrast\", Record<string, string>> = ${JSON.stringify(generated, null, 2)};`,
  END,
].join("\n");

const ts = readFileSync(TS_PATH, "utf8");
let next;
if (ts.includes(BEGIN)) {
  next = ts.replace(new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), section);
} else {
  next = ts.replace(/\n*$/, "\n") + "\n" + section + "\n";
}

if (process.argv.includes("--check")) {
  if (next !== ts) {
    console.error("designTokens.ts is stale. Run: npm run tokens:gen");
    process.exit(1);
  }
  console.log("designTokens.ts is in sync with tokens.css");
} else {
  writeFileSync(TS_PATH, next);
  const counts = Object.fromEntries(Object.entries(generated).map(([k, v]) => [k, Object.keys(v).length]));
  console.log(`designTokens.ts regenerated from tokens.css (${JSON.stringify(counts)} color tokens per theme)`);
}
