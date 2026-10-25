#!/usr/bin/env node
/**
 * WCAG contrast audit for the semantic token maps (Phase 0, #468; epic #137).
 *
 * Parses the [data-theme="dark"] and [data-theme="light"] maps in
 * src/client/tokens.css, resolves var() aliases one level, and computes
 * WCAG 2.1 contrast ratios for the semantic foreground/surface pairs that
 * DESIGN.md requires to be paired. AA text threshold = 4.5:1.
 *
 * Usage: node scripts/token-contrast.mjs [--json]
 * Report-only: exit code 0. Enforcement of *new* pairs belongs to reviews;
 * the baseline generated from this script is committed under plans/UX/baseline/.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(ROOT, "src", "client", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function extractBlock(selectorRe) {
  const m = css.match(selectorRe);
  if (!m) return {};
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
  const vars = {};
  for (const decl of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[decl[1]] = decl[2].trim();
  return vars;
}

const themes = {
  dark: extractBlock(/\[data-theme="dark"\]/),
  light: extractBlock(/\[data-theme="light"\]/),
  "high-contrast": extractBlock(/\[data-theme="high-contrast"\]/),
};

function resolve(vars, name, seen = new Set()) {
  let value = vars[name];
  if (value === undefined) return undefined;
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias && !seen.has(alias[1])) {
    seen.add(alias[1]);
    return resolve(vars, alias[1], seen);
  }
  return value;
}

function parseColor(value) {
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

function compositeOver(fg, bg) {
  if (fg.a >= 1) return fg;
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fgValue, bgValue) {
  const bg = parseColor(bgValue);
  let fg = parseColor(fgValue);
  if (!fg || !bg || bg.a < 1) return null;
  fg = compositeOver(fg, bg);
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Semantic pairs that DESIGN.md §2.1 requires to travel together. */
const PAIRS = [
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

const results = [];
const snapshot = {};
for (const [theme, vars] of Object.entries(themes)) {
  snapshot[theme] = vars;
  for (const [fgName, bgName] of PAIRS) {
    const fg = resolve(vars, fgName);
    const bg = resolve(vars, bgName);
    if (fg === undefined || bg === undefined) {
      results.push({ theme, fg: fgName, bg: bgName, status: "missing-token", fgValue: fg ?? null, bgValue: bg ?? null, ratio: null });
      continue;
    }
    const ratio = contrast(fg, bg);
    results.push({
      theme,
      fg: fgName,
      bg: bgName,
      fgValue: fg,
      bgValue: bg,
      ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
      status: ratio === null ? "manual-review" : ratio >= 4.5 ? "pass-aa" : "fail-aa",
    });
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ pairs: results, tokenSnapshot: snapshot }, null, 2));
} else {
  for (const r of results) {
    console.log(
      `${r.theme.padEnd(5)} ${r.status.padEnd(13)} ${r.ratio === null ? "  n/a" : r.ratio.toFixed(2).padStart(6)}  ${r.fg} on ${r.bg}  (${r.fgValue} on ${r.bgValue})`,
    );
  }
  const fails = results.filter((r) => r.status === "fail-aa");
  console.log(`\n${results.length} pairs, ${fails.length} below WCAG AA (4.5:1), ${results.filter((r) => r.status === "manual-review").length} need manual review, ${results.filter((r) => r.status === "missing-token").length} missing tokens.`);
}
