#!/usr/bin/env node
/**
 * Token coverage metric (UX token architecture, #137 / Phase 0 #468).
 *
 * Counts raw color literals in the client source: hex (#rgb, #rrggbb,
 * #rrggbbaa) and rgb()/rgba()/hsl()/hsla() functional notations.
 * Token SOURCE files are excluded (they are where raw values belong):
 *   - src/client/tokens.css
 *   - src/client/designTokens.ts
 *
 * Usage:
 *   node scripts/token-coverage.mjs              # human-readable report
 *   node scripts/token-coverage.mjs --json       # JSON to stdout
 *   node scripts/token-coverage.mjs --json out.json
 *
 * Exit code is always 0: this is a measurement tool. Enforcement lives in
 * the Phase 2 ratchet pin test (#470), which reads the baseline produced
 * with this script.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const CLIENT_DIR = join(ROOT, "src", "client");
const TOKEN_SOURCES = new Set(["src/client/tokens.css", "src/client/designTokens.ts"]);
const EXTENSIONS = new Set([".css", ".ts", ".tsx"]);

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const FN_RE = /\b(?:rgba?|hsla?)\([^)]*\)/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) yield full;
  }
}

const perFile = [];
let totalHex = 0;
let totalFn = 0;
const distinctHex = new Set();
let inlineStyleFiles = 0;

// Comments are prose, not styles: without stripping, an issue reference
// like "#450" inside a JSDoc block counts as a hex color literal.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;{}(])\/\/[^\n]*/g, "$1 ");
}

for (const file of walk(CLIENT_DIR)) {
  const rel = relative(ROOT, file);
  if (TOKEN_SOURCES.has(rel)) continue;
  const text = stripComments(readFileSync(file, "utf8"));
  const hex = [...text.matchAll(HEX_RE)].map((m) => m[0].toLowerCase());
  const fn = [...text.matchAll(FN_RE)];
  const inlineStyles = rel.endsWith(".tsx") ? (text.match(/style=\{\{/g) ?? []).length : 0;
  if (inlineStyles > 0) inlineStyleFiles += 1;
  if (hex.length === 0 && fn.length === 0 && inlineStyles === 0) continue;
  for (const h of hex) distinctHex.add(h);
  totalHex += hex.length;
  totalFn += fn.length;
  perFile.push({ file: rel, hex: hex.length, functional: fn.length, inlineStyleBlocks: inlineStyles });
}

perFile.sort((a, b) => b.hex + b.functional - (a.hex + a.functional));

const report = {
  generatedAt: new Date().toISOString(),
  scope: "src/client (.css/.ts/.tsx), excluding token sources tokens.css + designTokens.ts",
  totals: {
    rawColorLiterals: totalHex + totalFn,
    hexLiterals: totalHex,
    functionalLiterals: totalFn,
    distinctHexValues: distinctHex.size,
    tsxFilesWithInlineStyleBlocks: inlineStyleFiles,
  },
  perFile,
};

const jsonArg = process.argv.indexOf("--json");
if (jsonArg !== -1) {
  const out = process.argv[jsonArg + 1];
  const payload = JSON.stringify(report, null, 2);
  if (out && !out.startsWith("--")) writeFileSync(out, payload + "\n");
  else console.log(payload);
} else {
  console.log("Token coverage — raw color literals outside token sources");
  console.log("=".repeat(72));
  for (const f of perFile) {
    console.log(
      `${String(f.hex + f.functional).padStart(5)}  hex=${String(f.hex).padEnd(5)} fn=${String(f.functional).padEnd(4)} inlineStyle=${f.inlineStyleBlocks}  ${f.file}`,
    );
  }
  console.log("-".repeat(72));
  console.log(
    `TOTAL raw=${report.totals.rawColorLiterals} hex=${totalHex} functional=${totalFn} distinctHex=${distinctHex.size} tsxFilesWithInlineStyles=${inlineStyleFiles}`,
  );
}
