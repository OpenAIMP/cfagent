import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * UX token contrast + mirror-drift enforcement (#677, slice 2).
 *
 * Two design-token invariants used to run only when a human remembered:
 *   - `node scripts/token-contrast.mjs` — the WCAG AA audit of the
 *     semantic foreground/surface pairs in src/client/tokens.css. It is
 *     report-only (exit 0 even with failures), so an AA regression could
 *     land silently.
 *   - `node scripts/gen-design-tokens.mjs --check` — the check that
 *     src/client/designTokens.ts mirrors tokens.css. It ran only inside
 *     the local `npm run check`; CI never invoked it, so the mirror
 *     could drift silently.
 * These tests enforce both invariants in the suite (and therefore CI).
 *
 * The computation mirrors the two scripts — the same pattern the
 * coverage gate (#470/#476/#677 slice 1) uses with
 * scripts/token-coverage.mjs: the suite reimplements rather than shells
 * out (no test in this repo spawns a process). Mirror drift between
 * test and script is itself pinned: the pair list is extracted from
 * scripts/token-contrast.mjs and the section markers from
 * scripts/gen-design-tokens.mjs, and any divergence fails here loudly.
 *
 * Manual review: the audit cannot compute a ratio when the background
 * token is translucent (bg alpha < 1 yields no ratio), so those pairs
 * are NOT failures, exactly as the script treats them — but their
 * identities are pinned below so a new translucent pair cannot
 * silently join the exemption.
 */

const ROOT = join(__dirname, "..");
const CSS_PATH = join(ROOT, "src", "client", "tokens.css");
const TS_PATH = join(ROOT, "src", "client", "designTokens.ts");
const CONTRAST_SCRIPT = join(ROOT, "scripts", "token-contrast.mjs");
const GEN_SCRIPT = join(ROOT, "scripts", "gen-design-tokens.mjs");

const AA_TEXT_RATIO = 4.5; // WCAG 2.1 AA for normal text; mirrors token-contrast.mjs

const cssText = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/* ------------------------------------------------------------------ */
/* Contrast audit — mirrors scripts/token-contrast.mjs                 */
/* ------------------------------------------------------------------ */

function extractBlock(css: string, selectorRe: RegExp): Record<string, string> {
  const m = css.match(selectorRe);
  if (!m || m.index === undefined) return {};
  const start = css.indexOf("{", m.index);
  let depth = 0;
  let end = start;
  for (; end < css.length; end += 1) {
    if (css[end] === "{") depth += 1;
    else if (css[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = css.slice(start + 1, end);
  const vars: Record<string, string> = {};
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[decl[1]] = decl[2].trim();
  return vars;
}

const THEMES: Record<string, Record<string, string>> = {
  dark: extractBlock(cssText, /\[data-theme="dark"\]/),
  light: extractBlock(cssText, /\[data-theme="light"\]/),
  "high-contrast": extractBlock(cssText, /\[data-theme="high-contrast"\]/),
};

function resolve(vars: Record<string, string>, name: string, seen = new Set<string>()): string | undefined {
  const value = vars[name];
  if (value === undefined) return undefined;
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias && !seen.has(alias[1])) {
    seen.add(alias[1]);
    return resolve(vars, alias[1], seen);
  }
  return value;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const hex = value.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const fn = value.match(/^rgba?\(([^)]*)\)$/);
  if (fn) {
    const parts = fn[1].split(",").map((s) => s.trim());
    return { r: +parts[0], g: +parts[1], b: +parts[2], a: parts[3] === undefined ? 1 : parseFloat(parts[3]) };
  }
  return null;
}

function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  if (fg.a >= 1) return fg;
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(fgValue: string | undefined, bgValue: string | undefined): number | null {
  const bg = parseColor(bgValue);
  let fg = parseColor(fgValue);
  if (!fg || !bg || bg.a < 1) return null;
  fg = compositeOver(fg, bg);
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Semantic pairs that DESIGN.md §2.1 requires to travel together.
 *  Mirrors PAIRS in scripts/token-contrast.mjs — the sync test below
 *  extracts the script's list and fails if the two diverge. */
const PAIRS: Array<[string, string]> = [
  ["--color-surface-foreground", "--color-surface"],
  ["--color-surface-raised-foreground", "--color-surface-raised"],
  ["--color-surface-sunken-foreground", "--color-surface-sunken"],
  ["--color-card-foreground", "--color-card"],
  ["--color-muted-foreground", "--color-muted"],
  ["--color-text-primary", "--color-surface"],
  ["--color-text-primary", "--color-card"],
  ["--color-text-primary", "--color-surface-sunken"],
  ["--color-text-secondary", "--color-surface"],
  ["--color-text-secondary", "--color-card"],
  ["--color-text-muted", "--color-surface"],
  ["--color-text-muted", "--color-card"],
  ["--color-text-dim", "--color-surface"],
  ["--color-text-dim", "--color-card"],
  ["--color-primary-foreground", "--color-primary"],
  ["--color-success-foreground", "--color-success"],
  ["--color-danger-foreground", "--color-danger"],
  ["--color-warning-foreground", "--color-warning"],
  ["--color-info-foreground", "--color-info"],
  ["--color-accent-contrast", "--color-accent"],
  ["--color-accent", "--color-surface"],
  ["--color-success", "--color-surface"],
  ["--color-danger", "--color-surface"],
  ["--color-warning", "--color-surface"],
  ["--color-info", "--color-surface"],
];

type PairStatus = "pass-aa" | "fail-aa" | "manual-review" | "missing-token";

interface PairResult {
  theme: string;
  fg: string;
  bg: string;
  fgValue: string | null;
  bgValue: string | null;
  ratio: number | null;
  status: PairStatus;
}

function auditPairs(): PairResult[] {
  const results: PairResult[] = [];
  for (const [theme, vars] of Object.entries(THEMES)) {
    for (const [fgName, bgName] of PAIRS) {
      const fg = resolve(vars, fgName);
      const bg = resolve(vars, bgName);
      if (fg === undefined || bg === undefined) {
        results.push({ theme, fg: fgName, bg: bgName, status: "missing-token", fgValue: fg ?? null, bgValue: bg ?? null, ratio: null });
        continue;
      }
      const ratio = contrastRatio(fg, bg);
      results.push({
        theme,
        fg: fgName,
        bg: bgName,
        fgValue: fg,
        bgValue: bg,
        ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
        status: ratio === null ? "manual-review" : ratio >= AA_TEXT_RATIO ? "pass-aa" : "fail-aa",
      });
    }
  }
  return results;
}

/** The only pairs exempt from the AA gate: their background token is
 *  translucent, so no ratio exists (the audit's "manual-review"). Any
 *  change to this set is a deliberate, reviewed act — edit here AND be
 *  ready to justify it in the PR. */
const MANUAL_REVIEW_PAIRS = [
  "dark --color-muted-foreground on --color-muted",
  "high-contrast --color-muted-foreground on --color-muted",
];

describe("UX token contrast audit (#677 slice 2; mirrors scripts/token-contrast.mjs)", () => {
  it("pair list is in sync with scripts/token-contrast.mjs", () => {
    const src = readFileSync(CONTRAST_SCRIPT, "utf8");
    const block = src.match(/const PAIRS = \[([\s\S]*?)\];/);
    expect(block, "PAIRS block not found in scripts/token-contrast.mjs — the audit's shape changed; re-mirror it here").not.toBeNull();
    const scriptPairs = [...block![1].matchAll(/\["(--[\w-]+)", "(--[\w-]+)"\]/g)].map((m) => [m[1], m[2]] as [string, string]);
    expect(scriptPairs).toEqual(PAIRS);
    // The audit covers every pair in every theme: 25 pairs × 3 themes.
    expect(PAIRS.length * Object.keys(THEMES).length).toBe(75);
  });

  it("every audited foreground/surface pair meets WCAG AA (4.5:1)", () => {
    const results = auditPairs();
    expect(results.length).toBe(75);
    const violations = results
      .filter((r) => r.status === "fail-aa" || r.status === "missing-token")
      .map((r) =>
        r.status === "missing-token"
          ? `${r.theme}: ${r.fg} on ${r.bg} — token missing from the theme map`
          : `${r.theme}: ${r.fg} on ${r.bg} is ${r.ratio?.toFixed(2)}:1 (${r.fgValue} on ${r.bgValue}), below AA 4.5:1 — fix the token in tokens.css, not this test`,
      );
    expect(violations).toEqual([]);
  });

  it("manual-review (translucent background) pairs are exactly the pinned set", () => {
    const manual = auditPairs()
      .filter((r) => r.status === "manual-review")
      .map((r) => `${r.theme} ${r.fg} on ${r.bg}`)
      .sort();
    expect(manual).toEqual([...MANUAL_REVIEW_PAIRS].sort());
  });
});

/* ------------------------------------------------------------------ */
/* Mirror drift — mirrors scripts/gen-design-tokens.mjs --check      */
/* ------------------------------------------------------------------ */

/** Extract a `const NAME = "..."` string literal from a script's source. */
function scriptStringConst(path: string, name: string): string {
  const src = readFileSync(path, "utf8");
  const m = src.match(new RegExp(`const ${name} = "([^"]*)"`));
  if (!m) throw new Error(`${name} not found in ${path} — the generator's shape changed; re-mirror it here`);
  return m[1];
}

function extractColorMap(css: string, marker: string): Record<string, string> {
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
  const map: Record<string, string> = {};
  for (const decl of body.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) map[decl[1]] = decl[2].trim();
  return map;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Recompute what scripts/gen-design-tokens.mjs would write, byte for
 *  byte, and return the file content it would produce. */
function regenerate(ts: string): string {
  const BEGIN = scriptStringConst(GEN_SCRIPT, "BEGIN");
  const END = scriptStringConst(GEN_SCRIPT, "END");
  const generated = {
    dark: extractColorMap(cssText, '[data-theme="dark"]'),
    light: extractColorMap(cssText, '[data-theme="light"]'),
    "high-contrast": extractColorMap(cssText, '[data-theme="high-contrast"]'),
  };
  const section = [
    BEGIN,
    "/** Semantic --color-* values per theme, generated from tokens.css. */",
    `export const generatedThemeTokens: Record<"dark" | "light" | "high-contrast", Record<string, string>> = ${JSON.stringify(generated, null, 2)};`,
    END,
  ].join("\n");
  if (ts.includes(BEGIN)) {
    return ts.replace(new RegExp(`${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}`), section);
  }
  return ts.replace(/\n*$/, "\n") + "\n" + section + "\n";
}

describe("designTokens.ts mirror drift (#677 slice 2; mirrors gen-design-tokens.mjs --check)", () => {
  it("designTokens.ts is in sync with tokens.css", () => {
    const ts = readFileSync(TS_PATH, "utf8");
    const BEGIN = scriptStringConst(GEN_SCRIPT, "BEGIN");
    expect(ts.includes(BEGIN), "generated section markers missing from designTokens.ts — run: npm run tokens:gen").toBe(true);
    expect(
      regenerate(ts) === ts,
      "designTokens.ts is stale relative to tokens.css — run: npm run tokens:gen (and never hand-edit the generated section)",
    ).toBe(true);
  });
});
