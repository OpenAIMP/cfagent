import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Badge / Notice indicator contrast (#1578, A2).
 *
 * The 25-pair audit in tests/ux_token_contrast_drift.test.ts covers
 * foreground text on surfaces — but the Badge and Notice primitives
 * render a second family of text: tone text on its own tinted subtle
 * background (--color-success-text on --color-success-subtle, and so
 * on). Those indicator pairs were unaudited, and in the light theme
 * four of them fell below WCAG AA 4.5:1 (success 4.08, warning 4.09,
 * danger 3.85, trade 4.31) — the "secondary indicators" gap in
 * assessment-01 finding 3.
 *
 * Methodology: badges and notices render on default surfaces, so a
 * translucent subtle background is composited over --color-surface
 * to get its effective background — the color the user actually sees
 * — before the ratio is computed. Opaque backgrounds are used as-is.
 * The light-theme text tokens were darkened until every pair clears
 * AA with margin; this test pins all eight pairs in all three themes.
 */

const ROOT = join(__dirname, "..");
const CSS_PATH = join(ROOT, "src", "client", "tokens.css");

const AA_TEXT_RATIO = 4.5;

const cssText = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

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

/** Badge / Notice tone pairs, as rendered: tone text on tone subtle. */
const INDICATOR_PAIRS: Array<[string, string]> = [
  ["--color-text-secondary", "--color-muted"],
  ["--color-accent", "--color-accent-subtle"],
  ["--color-success-text", "--color-success-subtle"],
  ["--color-warning-text", "--color-warning-subtle"],
  ["--color-danger-text", "--color-danger-subtle"],
  ["--color-info-text", "--color-info-subtle"],
  ["--color-purple-text", "--color-purple-subtle"],
  ["--color-trade", "--color-trade-subtle"],
];

describe("indicator contrast audit (#1578, A2)", () => {
  it("every Badge/Notice tone pair meets WCAG AA (4.5:1) in every theme", () => {
    const violations: string[] = [];
    for (const [theme, vars] of Object.entries(THEMES)) {
      const surface = parseColor(resolve(vars, "--color-surface"));
      for (const [fgName, bgName] of INDICATOR_PAIRS) {
        const fgValue = resolve(vars, fgName);
        const bgValue = resolve(vars, bgName);
        const fg = parseColor(fgValue);
        let bg = parseColor(bgValue);
        if (!fg || !bg) {
          violations.push(`${theme}: ${fgName} on ${bgName} — unparseable token (${fgValue} on ${bgValue})`);
          continue;
        }
        // Translucent subtle backgrounds render over the surface.
        if (bg.a < 1 && surface) bg = compositeOver(bg, surface);
        if (bg.a < 1) {
          violations.push(`${theme}: ${fgName} on ${bgName} — background still translucent after compositing`);
          continue;
        }
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < AA_TEXT_RATIO) {
          violations.push(`${theme}: ${fgName} on ${bgName} is ${ratio.toFixed(2)}:1 (${fgValue} on ${bgValue}), below AA 4.5:1`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
