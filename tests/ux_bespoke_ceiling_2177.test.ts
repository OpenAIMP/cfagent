/**
 * Issue #2177 (epic #2150 slice 4) — bespoke-styling ceiling.
 *
 * The sweep is measurable: these counts only ratchet DOWN. A rise means
 * a new bespoke class, a new inline-style layout, or a new raw label
 * landed, and the PR that did it must either convert it or raise the
 * ceiling deliberately with a reason in the PR body — never silently.
 * Data-driven inline styles (per-record colors) are counted here too;
 * the PR body names them as data when they are the reason a count
 * cannot fall further.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "src", "client");

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "components" && dir === clientDir) {
        // components/ui is the primitives' home; its styles are the system,
        // not bespoke. Other components/* files still count.
        for (const sub of readdirSync(full)) {
          if (sub === "ui") continue;
          const subFull = join(full, sub);
          if (statSync(subFull).isDirectory()) walkTsx(subFull, out);
          else if (sub.endsWith(".tsx")) out.push(subFull);
        }
        continue;
      }
      walkTsx(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function walkCss(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkCss(full, out);
    } else if (entry.endsWith(".css")) {
      // tokens.css is the system itself; primitives.css is the system
      // too. Every other client stylesheet is bespoke by definition.
      if (entry === "tokens.css") continue;
      if (full.includes(`${"components"}/ui/primitives.css`)) continue;
      out.push(full);
    }
  }
  return out;
}
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe("bespoke-styling ceiling (issue #2177)", () => {
  it("bespoke stylesheets do not grow", () => {
    // Baseline measured on main 8414089 across every client stylesheet
    // except tokens.css and primitives.css (21 files). The styles.css-only
    // figure (1,847 braces / 1,295 classes) undercounted: per-panel and
    // per-area sheets hold the rest.
    let braces = 0;
    const classes = new Set<string>();
    for (const file of walkCss(clientDir)) {
      const css = readFileSync(file, "utf8");
      braces += countOccurrences(css, "{");
      for (const match of css.match(/\.[a-z][a-z0-9-]+/g) ?? []) {
        classes.add(match);
      }
    }
    expect(braces).toBeLessThanOrEqual(3828);
    expect(classes.size).toBeLessThanOrEqual(2582);
  });

  it("inline styles and raw labels outside the primitives do not grow", () => {
    let inlineStyles = 0;
    let rawLabels = 0;
    for (const file of walkTsx(clientDir)) {
      const src = readFileSync(file, "utf8");
      inlineStyles += countOccurrences(src, "style={{");
      rawLabels += countOccurrences(src, "<label");
    }
    // Baselines are occurrence counts measured by this test on main
    // 8414089 (the earlier 839 figure was a grep line count; four lines
    // hold two style props each, hence 843 occurrences). The label
    // baseline is 223, not 222: the c66332c advance (checkout UI
    // rebuild, the branch base) added one raw <label> in
    // CheckoutPanel.tsx after the 8414089 measurement. That label is
    // pre-existing on the base, not growth from this change.
    expect(inlineStyles).toBeLessThanOrEqual(843);
    expect(rawLabels).toBeLessThanOrEqual(223);
  });
});
