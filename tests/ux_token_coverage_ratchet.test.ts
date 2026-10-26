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
 *
 * Named colors (#677): CSS named-color keywords (white, crimson, …) are
 * raw literals too, but unlike hex they collide with ordinary words, so
 * the scan is scoped to where style values are actually written:
 *   - CSS files: declaration values of color-bearing properties (plus
 *     custom-property definitions, whose values are style values);
 *   - TS/TSX: string values of color-bearing properties inside inline
 *     `style={{ … }}` objects, and SVG presentation attributes
 *     (fill/stroke/stop-color/…).
 * A name counts only as a standalone value word (identifier boundaries on
 * both sides), so token names (var(--color-purple-subtle)), class names,
 * and tone identifiers never match. Value keywords that are not named
 * colors — transparent, currentColor, inherit, unset, none — are absent
 * from the keyword list by design and are never flagged. Detached object
 * literals are NOT scanned in TS/TSX: a data record's `color: "purple"`
 * field (e.g. a saved-filter preset naming a tone) is syntactically
 * identical to a style entry, and the hex gate's bluntness is not safe
 * to repeat here — style values enter TS/TSX through the style prop.
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

// The CSS named-color keywords (CSS Color 4), minus `transparent` — a
// <color> keyword the gate treats as a value keyword, not a literal (see
// the header comment). Mirrors NAMED_COLORS in scripts/token-coverage.mjs.
const NAMED_COLORS =
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
    " ",
  );
const NAMED_COLOR_RE = new RegExp(`(?<![\\w-])(?:${NAMED_COLORS.join("|")})(?![\\w-])`, "gi");

// Color-bearing properties whose values may carry a named color. Shorthand
// properties (border, background, box-shadow, …) are included: the value
// scan looks for standalone named-color words anywhere in the value.
const COLOR_KEBAB_PROPS = new Set(
  "color background background-color border-color border-top-color border-right-color border-bottom-color border-left-color outline-color text-decoration-color caret-color accent-color column-rule-color fill stroke stop-color flood-color lighting-color box-shadow text-shadow border border-top border-right border-bottom border-left outline column-rule".split(" "),
);
const COLOR_CAMEL_PROPS = new Set(
  "color background backgroundColor borderColor borderTopColor borderRightColor borderBottomColor borderLeftColor outlineColor textDecorationColor caretColor accentColor columnRuleColor fill stroke stopColor floodColor lightingColor boxShadow textShadow border borderTop borderRight borderBottom borderLeft outline columnRule".split(" "),
);
const COLOR_JSX_ATTR_RE =
  /\b(?:fill|stroke|stop-color|stopColor|flood-color|floodColor|lighting-color|lightingColor)\s*=\s*(?:\{\s*)?(["'])([^"']*)\1/g;

function countNamedInCss(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;{}]+)[;}]/g)) {
    const prop = m[1].toLowerCase();
    if (!(prop.startsWith("--") || COLOR_KEBAB_PROPS.has(prop))) continue;
    n += (m[2].match(NAMED_COLOR_RE) ?? []).length;
  }
  return n;
}

// Brace-balanced spans of inline `style={{ … }}` objects in TS/TSX source.
function styleSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
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

function countNamedInTs(text: string): number {
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

// Brace-balanced spans of style objects referenced by identifier:
// `style={panelStyle}` / `style={styles.panel}`. A named color in a
// standalone style object escaped the gate (#1337: the span check only
// saw direct style={{…}} literals), while a data field like a preset's
// `color: "purple"` must NOT be flagged — so the scan is limited to
// objects actually used as a style value, resolved in-file from a
// direct const/let/var definition. Call expressions, ternaries, and
// cross-file style objects are out of scope for this pass.
// Mirrors scripts/token-coverage.mjs; keep the two in sync.
function styleObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
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

function scanNamedColors(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walk(CLIENT_DIR)) {
    const rel = relative(ROOT, file).split("\\").join("/");
    if (TOKEN_SOURCES.has(rel)) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    const n = rel.endsWith(".css") ? countNamedInCss(text) : countNamedInTs(text);
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

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

  it("no CSS named-color literals as style values in src/client outside the token sources", () => {
    const counts = scanNamedColors();
    const violations: string[] = [];
    for (const [file, n] of counts) {
      violations.push(`${file}: ${n} named-color literals (use the paired token, not a named color)`);
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

describe("no dangling var() references (#492 follow-up)", () => {
  it("every var(--x) used in src/client names a defined custom property", () => {
    // A var() pointing at an undefined custom property silently invalidates
    // the declaration in every theme (the legacy --theme-* family and
    // --color-border/--shadow-xl strays purged in the #492 Table slice).
    // Definitions are collected from CSS files and from TS/TSX inline
    // style objects ("--x": value). Names ending in "-" are dynamic
    // template prefixes (var(--color-${tone})) and are skipped.
    const defined = new Set<string>();
    const used = new Map<string, string[]>();
    const DEF_RE = /(--[a-z0-9-]+)\s*:/g;
    const USE_RE = /var\((--[a-z0-9-]+)/g;
    for (const file of walk(CLIENT_DIR)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      const raw = readFileSync(file, "utf8");
      if (rel.endsWith(".css")) {
        for (const m of raw.matchAll(DEF_RE)) defined.add(m[1]);
      } else {
        for (const m of raw.matchAll(/["'](--[a-z0-9-]+)["']\s*:/g)) defined.add(m[1]);
      }
      const text = stripComments(raw);
      for (const m of text.matchAll(USE_RE)) {
        const name = m[1];
        if (name.endsWith("-")) continue;
        const list = used.get(name) ?? [];
        list.push(rel);
        used.set(name, list);
      }
    }
    const dangling: string[] = [];
    for (const [name, files] of used) {
      if (!defined.has(name)) dangling.push(`${name} (used in ${[...new Set(files)].slice(0, 3).join(", ")})`);
    }
    expect(dangling).toEqual([]);
  });
});

describe("token governance (#1337)", () => {
  it("catches a planted non-token color in a standalone style object", () => {
    // The demonstrated gap: a named color in `const s = { color }`
    // used as style={s} escaped the style={{…}} span check.
    const planted = [
      `const panelStyle = { color: "blue", padding: 4 };`,
      `export const P = () => <div style={panelStyle}>x</div>;`,
    ].join("\n");
    expect(countNamedInTs(planted)).toBeGreaterThan(0);
    const memberPlanted = [
      `const styles = { panel: { backgroundColor: "red" } };`,
      `export const Q = () => <div style={styles.panel}>x</div>;`,
    ].join("\n");
    expect(countNamedInTs(memberPlanted)).toBeGreaterThan(0);
  });

  it("does not flag token references or non-style data fields", () => {
    const tokenRef = [
      `const panelStyle = { color: "var(--color-text-primary)" };`,
      `export const P = () => <div style={panelStyle}>x</div>;`,
    ].join("\n");
    expect(countNamedInTs(tokenRef)).toBe(0);
    // A preset's `color: "purple"` is a data field, not a style
    // value — the identifier-tracking scan must not flag it.
    const dataField = [
      `const preset = { id: "custom_1", name: "Custom", color: "purple" };`,
      `export const P = () => <div>{preset.name}</div>;`,
    ].join("\n");
    expect(countNamedInTs(dataField)).toBe(0);
  });

  it("one-off stylesheets are registered, and growth is explicit", () => {
    // Every stylesheet outside src/client/components/ui/ (tokens.css
    // excepted — it is the token source, not a one-off) must be
    // registered in tests/one_off_stylesheets_1337.json with a reason,
    // and must not exceed its registered size: a PR that grows one
    // bumps the baseline in-PR, so growth is visible in the diff.
    const baseline = JSON.parse(
      readFileSync(join(ROOT, "tests", "one_off_stylesheets_1337.json"), "utf8")
    ) as Array<{ path: string; lines: number; reason: string }>;
    const registered = new Map(baseline.map((b) => [b.path, b]));
    const violations: string[] = [];
    for (const file of walk(CLIENT_DIR)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (!rel.endsWith(".css")) continue;
      if (rel.includes("components/ui/") || TOKEN_SOURCES.has(rel)) continue;
      const entry = registered.get(rel);
      if (!entry) {
        violations.push(`${rel}: unregistered one-off stylesheet (add it to tests/one_off_stylesheets_1337.json with a reason)`);
        continue;
      }
      if (!entry.reason) violations.push(`${rel}: registered without a reason`);
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines > entry.lines) {
        violations.push(`${rel}: grew ${entry.lines} → ${lines} lines (bump the baseline in-PR)`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("new surfaces compose from ui/ primitives (no exemptions, ADR-0004)", () => {
    // A .tsx file under src/client that is NOT in the grandfather
    // baseline, renders JSX, and imports nothing from
    // src/client/components/ui/ fails. The exemptions list of
    // tests/ui_primitives_1337.json is pinned empty by the ADR-0004
    // test below (compliance is mandatory, no exemptions); the
    // exemption lookup below stays only because removing the
    // mechanism is follow-up, not decided.
    // Primitives themselves (components/ui/**) are exempt by
    // definition. Baseline files are grandfathered, not pinned:
    // deleting one needs no baseline edit.
    const gov = JSON.parse(
      readFileSync(join(ROOT, "tests", "ui_primitives_1337.json"), "utf8")
    ) as { baseline: string[]; exemptions: Array<{ path: string; reason: string }> };
    const baseline = new Set(gov.baseline);
    const exempted = new Map(gov.exemptions.map((e) => [e.path, e]));
    const violations: string[] = [];
    const DOM_TAGS = new Set("div span p button table section h1 h2 h3 h4 h5 h6 ul ol li input select form a img tr td th thead tbody header footer nav main label textarea".split(" "));
    for (const file of walk(CLIENT_DIR)) {
      const rel = relative(ROOT, file).split("\\").join("/");
      if (!rel.endsWith(".tsx")) continue;
      if (rel.includes("components/ui/")) continue;
      if (baseline.has(rel)) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      const rendersJsx =
        /<[A-Z][\w.]*[\s/>]/.test(text) ||
        [...text.matchAll(/<([a-z][\w]*)[\s/>]/g)].some((m) => DOM_TAGS.has(m[1]));
      if (!rendersJsx) continue;
      // Accept the barrel import (./components/ui) as well as a
      // submodule import (./components/ui/Button): the barrel is the
      // repo's dominant idiom (29 barrel vs 0 submodule imports), so
      // requiring the trailing slash false-positived on it.
      const usesPrimitive =
        /from\s+["'][^"']*components\/ui(\/|["'])/.test(text) ||
        /import\s+["'][^"']*components\/ui(\/|["'])/.test(text);
      if (usesPrimitive) continue;
      const exemption = exempted.get(rel);
      if (exemption?.reason) continue;
      violations.push(`${rel}: new surface renders JSX without importing a ui/ primitive (import one; exemptions are prohibited by ADR-0004)`);
    }
    expect(violations).toEqual([]);
  });

  it("no exemptions to the primitive rule (ADR-0004)", () => {
    // UX token architecture compliance is mandatory with NO
    // exemptions — all or none (ADR-0004, #1705). A surface that
    // cannot comply must be reworked until it complies; it must
    // not be added here. This pin fails CI the moment any entry
    // appears in the exemptions list.
    const gov = JSON.parse(
      readFileSync(join(ROOT, "tests", "ui_primitives_1337.json"), "utf8")
    ) as { baseline: string[]; exemptions: Array<{ path: string; reason: string }> };
    expect(gov.exemptions).toEqual([]);
  });
});
