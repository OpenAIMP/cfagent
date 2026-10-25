#!/usr/bin/env node
/**
 * Token coverage metric (UX token architecture, #137 / Phase 0 #468).
 *
 * Counts raw color literals in the client source: hex (#rgb, #rrggbb,
 * #rrggbbaa), rgb()/rgba()/hsl()/hsla() functional notations, and CSS
 * named-color keywords (white, crimson, …) appearing as style values
 * (#677 — scoped exactly as in the ratchet test: CSS declaration values,
 * inline style={{…}} string values, and SVG presentation attributes in
 * TS/TSX; a name counts only as a standalone value word).
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
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLIENT_DIR = join(ROOT, "src", "client");
const TOKEN_SOURCES = new Set(["src/client/tokens.css", "src/client/designTokens.ts"]);
const EXTENSIONS = new Set([".css", ".ts", ".tsx"]);

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const FN_RE = /\b(?:rgba?|hsla?)\([^)]*\)/g;

// Named-color scan — mirrors the #677 section of
// tests/ux_token_coverage_ratchet.test.ts; keep the two in sync.
// The CSS named-color keywords (CSS Color 4), minus `transparent`.
const NAMED_COLORS =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  );
const NAMED_COLOR_RE = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w-])`, "gi");
const COLOR_KEBAB_PROPS = new Set(
  "color background background-color border-color border-top-color border-right-color border-bottom-color border-left-color outline-color text-decoration-color caret-color accent-color column-rule-color fill stroke stop-color flood-color lighting-color box-shadow text-shadow border border-top border-right border-bottom border-left outline column-rule".split(" "),
);
const COLOR_CAMEL_PROPS = new Set(
  "color background backgroundColor borderColor borderTopColor borderRightColor borderBottomColor borderLeftColor outlineColor textDecorationColor caretColor accentColor columnRuleColor fill stroke stopColor floodColor lightingColor boxShadow textShadow border borderTop borderRight borderBottom borderLeft outline columnRule".split(" "),
);
const COLOR_JSX_ATTR_RE =
  /\b(?:fill|stroke|stop-color|stopColor|flood-color|floodColor|lighting-color|lightingColor)\s*=\s*(?:\{\s*)?(["'])([^"']*)\1/g;

function countNamedInCss(text) {
  let n = 0;
  for (const m of text.matchAll(/(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const prop = m[1].toLowerCase();
    if (!(prop.startsWith("--") || COLOR_KEBAB_PROPS.has(prop))) continue;
    n += (m[2].match(NAMED_COLOR_RE) ?? []).length;
  }
  return n;
}

function styleSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/style\s*=\s*\{\{/g)) {
    const start = text.indexOf("{", m.index);
    let depth = 0;
    let i = start;
    for (; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([start, i]);
  }
  return spans;
}

function countNamedInTs(text) {
  let n = 0;
  const spans = styleSpans(text);
  const objSpans = styleObjectSpans(text);
  for (const m of text.matchAll(/(["']?)([A-Za-z][\w-]*)\1\s*:\s*(["'`])([^"'`]*)\3/g)) {
    const prop = m[2];
    const isColorProp =
      COLOR_CAMEL_PROPS.has(prop) || COLOR_KEBAB_PROPS.has(prop.toLowerCase()) || prop.startsWith("--");
    if (!isColorProp) continue;
    if (!spans.some(([a, b]) => m.index >= a && m.index <= b) && !objSpans.some(([a, b]) => m.index >= a && m.index <= b)) continue;
    n += (m[4].match(NAMED_COLOR_RE) ?? []).length;
  }
  for (const m of text.matchAll(COLOR_JSX_ATTR_RE)) {
    n += (m[2].match(NAMED_COLOR_RE) ?? []).length;
  }
  return n;
}

// Issue #1337: brace-balanced spans of style objects referenced by
// identifier — `style={panelStyle}` / `style={styles.panel}`. A named
// color in a standalone style object escaped the gate (the span check
// only saw direct style={{…}} literals), while a data field like a
// preset's `color: "purple"` must NOT be flagged — so the scan is
// limited to objects actually used as a style value, resolved in-file
// from a direct const/let/var definition. Call expressions, ternaries,
// and cross-file style objects are out of scope for this pass.
function styleObjectSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/style\s*=\s*\{\s*([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?\s*\}/g)) {
    const ident = m[1];
    const defRe = new RegExp(`(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*\\{`, "g");
    for (const d of text.matchAll(defRe)) {
      const start = text.indexOf("{", d.index);
      let depth = 0;
      let i = start;
      for (; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      spans.push([start, i]);
    }
  }
  return spans;
}

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
let totalNamed = 0;
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
  const named = rel.endsWith(".css") ? countNamedInCss(text) : countNamedInTs(text);
  const inlineStyles = rel.endsWith(".tsx") ? (text.match(/style=\{\{/g) ?? []).length : 0;
  if (inlineStyles > 0) inlineStyleFiles += 1;
  if (hex.length === 0 && fn.length === 0 && named === 0 && inlineStyles === 0) continue;
  for (const h of hex) distinctHex.add(h);
  totalHex += hex.length;
  totalFn += fn.length;
  totalNamed += named;
  perFile.push({ file: rel, hex: hex.length, functional: fn.length, named, inlineStyleBlocks: inlineStyles });
}

perFile.sort((a, b) => b.hex + b.functional + b.named - (a.hex + a.functional + a.named));

// Issue #1337: one-off stylesheet report — every stylesheet outside
// the shared ui/ primitives, with its size, so growth shows up per PR
// in this report (the ratchet test pins registration + size, so a PR
// that grows one must bump tests/one_off_stylesheets_1337.json).
const oneOffStylesheets = [];
for (const file of walk(CLIENT_DIR)) {
  const rel = relative(ROOT, file);
  if (!rel.endsWith(".css")) continue;
  if (rel.includes("components/ui/") || TOKEN_SOURCES.has(rel)) continue;
  oneOffStylesheets.push({ file: rel, lines: readFileSync(file, "utf8").split("\n").length });
}
oneOffStylesheets.sort((a, b) => b.lines - a.lines);
const oneOffStylesheetLines = oneOffStylesheets.reduce((sum, f) => sum + f.lines, 0);

const report = {
  generatedAt: new Date().toISOString(),
  scope: "src/client (.css/.ts/.tsx), excluding token sources tokens.css + designTokens.ts",
  totals: {
    rawColorLiterals: totalHex + totalFn + totalNamed,
    hexLiterals: totalHex,
    functionalLiterals: totalFn,
    namedColorLiterals: totalNamed,
    distinctHexValues: distinctHex.size,
    tsxFilesWithInlineStyleBlocks: inlineStyleFiles,
    oneOffStylesheetLines,
    oneOffStylesheetFiles: oneOffStylesheets.length,
  },
  perFile,
  oneOffStylesheets,
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
      `${String(f.hex + f.functional + f.named).padStart(5)}  hex=${String(f.hex).padEnd(5)} fn=${String(f.functional).padEnd(4)} named=${String(f.named).padEnd(4)} inlineStyle=${f.inlineStyleBlocks}  ${f.file}`,
    );
  }
  console.log("-".repeat(72));
  console.log(
    `TOTAL raw=${report.totals.rawColorLiterals} hex=${totalHex} functional=${totalFn} named=${totalNamed} distinctHex=${distinctHex.size} tsxFilesWithInlineStyles=${inlineStyleFiles}`,
  );
  console.log("One-off stylesheets (outside src/client/components/ui/)");
  for (const f of oneOffStylesheets) {
    console.log(`  ${String(f.lines).padStart(6)}  ${f.file}`);
  }
  console.log(`TOTAL one-off stylesheet lines=${oneOffStylesheetLines} files=${oneOffStylesheets.length}`);
}
