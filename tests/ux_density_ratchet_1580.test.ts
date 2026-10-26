import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Density-token ratchet (#1580 Stage 2, part of #1519).
 *
 * Finding 4 of assessment-01: ad-hoc inline styles such as
 * `style={{ padding: "12px", gap: "8px" }}` bypass the tokenized density
 * variables (`--control-height`, `--input-padding`, `--card-padding`,
 * `--table-row-height`, `--space-*`). This pin turns that rule into a
 * gate, mirroring the Stage 1 raw-control freeze gate: it scans inline
 * style values in .tsx/.jsx under src/client (excluding components/ui/
 * itself) and counts hardcoded density literals per file. A file outside
 * the allowlist with any such literal fails; an allowlisted file above
 * its pinned count fails; a stale allowlist entry (file deleted, or
 * count dropped below its pin) fails with instructions to ratchet the
 * allowlist down. Counts only ever decrease, in the same PR that
 * remediates the file.
 *
 * Counted (v1 scope): `padding*` and `gap*` props (camelCase and
 * kebab-case) whose value is a px/rem/em string literal or a nonzero
 * bare number (React treats bare numbers as px), inside a direct
 * `style={{ ... }}` literal or an in-file style object referenced by
 * identifier (`style={panelStyle}` / `style={styles.panel}`).
 *
 * NOT counted in v1 (documented, not hidden):
 * - `var(...)` values: tokenized density, the compliant form.
 * - Zero (`"0"`, `0`): not a density bypass.
 * - `margin*`: spacing, but not one of the density variables; a
 *   separate pass if it ever needs one.
 * - CSS files: one-off stylesheets carry their own line pin
 *   (tests/one_off_stylesheets_1337.json); primitives.css is the
 *   primitive source. A CSS density pass is follow-up, not this gate.
 * - Style objects from another file, call expressions, ternaries, and
 *   template-literal interpolations: not resolved, the same limitation
 *   the token ratchet documents for its style-object scan.
 */

const ROOT = process.cwd();
const CLIENT_DIR = join(ROOT, "src/client");
const UI_DIR = join(CLIENT_DIR, "components", "ui");
const ALLOWLIST_PATH = join(ROOT, "tests", "ux_density_allowlist_1580.json");

const DENSITY_PROPS = new Set([
  "padding", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight",
  "paddingBlock", "paddingInline", "paddingBlockStart", "paddingBlockEnd",
  "paddingInlineStart", "paddingInlineEnd",
  "padding-top", "padding-bottom", "padding-left", "padding-right",
  "padding-block", "padding-inline", "padding-block-start", "padding-block-end",
  "padding-inline-start", "padding-inline-end",
  "gap", "rowGap", "columnGap", "row-gap", "column-gap",
]);

// Comments are prose, not styles. Mirrors stripComments in the token
// ratchet test; keep the two implementations in sync.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[\s;{(])\/\/[^\n]*/g, "$1 ");
}

/** Brace-balanced spans of inline style values, on already-stripped text. */
function styleSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const pushSpan = (start: number): void => {
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
  };
  for (const m of text.matchAll(/style\s*=\s*\{\{/g)) {
    pushSpan(text.indexOf("{", m.index));
  }
  for (const m of text.matchAll(/style\s*=\s*\{\s*([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)?\s*\}/g)) {
    const ident = m[1];
    const defRe = new RegExp(`(?:const|let|var)\\s+${ident}\\s*(?::[^=]+)?=\\s*\\{`, "g");
    for (const d of text.matchAll(defRe)) {
      pushSpan(text.indexOf("{", d.index));
    }
  }
  return spans;
}

const LENGTH_RE = /\d+(\.\d+)?(px|rem|em)\b/;

/** Count hardcoded density literals in one source file's style values. */
export function countDensityLiterals(source: string): number {
  const text = stripComments(source);
  const spans = styleSpans(text);
  let count = 0;
  for (const m of text.matchAll(/(["']?)([A-Za-z][\w-]*)\1\s*:\s*("[^"]*"|'[^']*'|`[^`]*`|-?\d+(?:\.\d+)?)/g)) {
    const prop = m[2];
    if (!DENSITY_PROPS.has(prop)) continue;
    if (!spans.some(([a, b]) => m.index >= a && m.index <= b)) continue;
    const value = m[3];
    if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) {
      if (value.includes("var(")) continue;
      if (LENGTH_RE.test(value)) count += 1;
    } else {
      if (parseFloat(value) > 0) count += 1;
    }
  }
  return count;
}

/** All .tsx/.jsx files under src/client except the primitives directory. */
export function collectClientFiles(clientDir: string, uiDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full === uiDir || full.startsWith(uiDir + sep)) {
          continue;
        }
        walk(full);
      } else if (/\.(tsx|jsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(clientDir);
  return files;
}

function loadAllowlist(): Record<string, number> {
  const parsed: unknown = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Allowlist ${ALLOWLIST_PATH} must be a JSON object with a "files" map.`);
  }
  const files = (parsed as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(`Allowlist ${ALLOWLIST_PATH} is missing its "files" map.`);
  }
  for (const [file, count] of Object.entries(files as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
      throw new Error(`Allowlist entry ${file} must pin a positive integer count, got ${String(count)}.`);
    }
  }
  return files as Record<string, number>;
}

describe("countDensityLiterals (#1580 Stage 2)", () => {
  it("counts px padding and rem gap in a direct style literal", () => {
    const source = `export const A = () => (<div style={{ padding: "12px", gap: "0.5rem" }}>x</div>);`;
    expect(countDensityLiterals(source)).toBe(2);
  });

  it("counts a shorthand value once per declaration", () => {
    const source = `export const A = () => (<div style={{ padding: "0.75rem 1.5rem" }}>x</div>);`;
    expect(countDensityLiterals(source)).toBe(1);
  });

  it("counts a bare number (React px) and skips zero", () => {
    const source = `export const A = () => (<div style={{ gap: 8, padding: 0 }}>x</div>);`;
    expect(countDensityLiterals(source)).toBe(1);
  });

  it("does not count tokenized var() values", () => {
    const source = `export const A = () => (<div style={{ padding: "var(--card-padding)", gap: "var(--space-2)" }}>x</div>);`;
    expect(countDensityLiterals(source)).toBe(0);
  });

  it("does not count non-style data fields", () => {
    const source = `const preset = { id: "custom_1", padding: "12px" };\n      export const A = () => (<div>{preset.id}</div>);`;
    expect(countDensityLiterals(source)).toBe(0);
  });

  it("counts identifier-resolved and member style objects", () => {
    const planted = [
      `const panelStyle = { padding: "8px" };`,
      `export const P = () => <div style={panelStyle}>x</div>;`,
    ].join("\n");
    expect(countDensityLiterals(planted)).toBe(1);
    const memberPlanted = [
      `const styles = { panel: { gap: "1rem" } };`,
      `export const Q = () => <div style={styles.panel}>x</div>;`,
    ].join("\n");
    expect(countDensityLiterals(memberPlanted)).toBe(1);
  });

  it("does not count margin in v1 scope", () => {
    const source = `export const A = () => (<div style={{ margin: "8px", marginTop: "4px" }}>x</div>);`;
    expect(countDensityLiterals(source)).toBe(0);
  });

  it("does not count commented-out style text", () => {
    const source = `// <div style={{ padding: "12px" }}>\n      export const A = () => (<div>x</div>);`;
    expect(countDensityLiterals(source)).toBe(0);
  });
});

describe("density-token ratchet (#1580 Stage 2)", () => {
  it("no new hardcoded density literals, no count growth, no stale allowlist entries", () => {
    expect(existsSync(CLIENT_DIR), `src/client not found under ${ROOT}`).toBe(true);
    const allowlist = loadAllowlist();
    const scanned = new Map<string, number>();
    for (const full of collectClientFiles(CLIENT_DIR, UI_DIR)) {
      const count = countDensityLiterals(readFileSync(full, "utf8"));
      if (count > 0) {
        scanned.set(relative(ROOT, full).split(sep).join("/"), count);
      }
    }

    const violations: string[] = [];
    for (const [file, count] of scanned) {
      const pinned = allowlist[file];
      if (pinned === undefined) {
        violations.push(
          `NEW hardcoded density: ${file} uses ${count} hardcoded density literal(s) but is not in the allowlist. ` +
            `Use a density token (var(--card-padding), var(--space-*), ...) instead of adding it to the allowlist.`,
        );
      } else if (count > pinned) {
        violations.push(
          `COUNT GROWTH: ${file} uses ${count} hardcoded density literals, above its pinned ${pinned}. ` +
            `Replace literals with density tokens; never raise a pin.`,
        );
      }
    }
    for (const [file, pinned] of Object.entries(allowlist)) {
      const current = scanned.get(file) ?? 0;
      if (current < pinned) {
        violations.push(
          `STALE allowlist entry: ${file} now uses ${current} hardcoded density literal(s), below its pinned ${pinned}. ` +
            `Ratchet the allowlist down to ${current} (or remove the entry) in the same PR that remediated it.`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
