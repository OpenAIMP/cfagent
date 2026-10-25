import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";

/**
 * Primitive-usage freeze gate (#1580 Stage 1, part of #1519).
 *
 * The UX drift root cause: the primitives-only rule lived in prose while CI
 * enforced only raw colors and primitive exports, so raw controls accumulated
 * with green CI. This pin turns the rule into a gate.
 *
 * It walks src/client (excluding components/ui itself, where primitives
 * legitimately render raw elements) with the TypeScript AST and counts raw
 * JSX controls per file. A file outside the allowlist with any raw control
 * fails; an allowlisted file above its pinned count fails; a stale
 * allowlist entry (file deleted, or count dropped below its pin) fails with
 * instructions to ratchet the allowlist down. That is the ratchet: counts
 * only ever decrease, in the same PR that remediates the file.
 *
 * Counted controls (the anti-drift docs' set): button, input, select,
 * textarea, table. th/td/tr are subsumed by table detection. form (a
 * semantic wrapper, present even in compliant files) and dialog are NOT
 * counted in v1 — see #1580 Stage 2/3 notes.
 */

const ROOT = process.cwd();
const CLIENT_DIR = join(ROOT, "src/client");
const UI_DIR = join(CLIENT_DIR, "components", "ui");
const ALLOWLIST_PATH = join(ROOT, "tests", "ux_primitive_usage_allowlist_1580.json");

const RAW_CONTROLS = new Set(["button", "input", "select", "textarea", "table"]);

/** Count raw JSX controls in one source file, via the TypeScript AST. */
export function countRawControls(source: string, fileName: string): number {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (RAW_CONTROLS.has(node.tagName.getText(sourceFile))) {
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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

describe("countRawControls (#1580)", () => {
  it("counts raw controls, including self-closing elements", () => {
    const source = `export const A = () => (<><button>Go</button><input type="text" /></>);`;
    expect(countRawControls(source, "A.tsx")).toBe(2);
  });

  it("does not count primitive components", () => {
    const source = `import { Button, TextInput } from "./components/ui";
      export const A = () => (<><Button>Go</Button><TextInput /></>);`;
    expect(countRawControls(source, "A.tsx")).toBe(0);
  });

  it("does not count tags inside comments or string literals", () => {
    const source = `// <button> not rendered
      const label = "<input> not rendered";
      export const A = () => (<div>{label}</div>);`;
    expect(countRawControls(source, "A.tsx")).toBe(0);
  });

  it("counts a table once, not its th/td/tr children", () => {
    const source = `export const A = () => (<table><tr><th>H</th><td>V</td></tr></table>);`;
    expect(countRawControls(source, "A.tsx")).toBe(1);
  });

  it("counts opening tags whose props start on the next line", () => {
    // Regression note: a line-based grep misses `<button` at end of line;
    // the AST does not. This case pins that behavior.
    const source = `export const A = () => (<button
      type="button"
      onClick={() => undefined}
    >Go</button>);`;
    expect(countRawControls(source, "A.tsx")).toBe(1);
  });

  it("does not count form or dialog in v1 scope", () => {
    const source = `export const A = () => (<form><dialog>Hi</dialog></form>);`;
    expect(countRawControls(source, "A.tsx")).toBe(0);
  });
});

describe("primitive usage freeze (#1580 Stage 1)", () => {
  it("no new raw controls, no count growth, no stale allowlist entries", () => {
    expect(existsSync(CLIENT_DIR), `src/client not found under ${ROOT}`).toBe(true);
    const allowlist = loadAllowlist();
    const scanned = new Map<string, number>();
    for (const full of collectClientFiles(CLIENT_DIR, UI_DIR)) {
      const count = countRawControls(readFileSync(full, "utf8"), full);
      if (count > 0) {
        scanned.set(relative(ROOT, full).split(sep).join("/"), count);
      }
    }

    const violations: string[] = [];
    for (const [file, count] of scanned) {
      const pinned = allowlist[file];
      if (pinned === undefined) {
        violations.push(
          `NEW raw controls: ${file} renders ${count} raw control(s) but is not in the allowlist. ` +
            `Rebuild it from src/client/components/ui/ primitives instead of adding it to the allowlist.`,
        );
      } else if (count > pinned) {
        violations.push(
          `COUNT GROWTH: ${file} renders ${count} raw controls, above its pinned ${pinned}. ` +
            `Remove raw controls; never raise a pin.`,
        );
      }
    }
    for (const [file, pinned] of Object.entries(allowlist)) {
      const current = scanned.get(file) ?? 0;
      if (current < pinned) {
        violations.push(
          `STALE allowlist entry: ${file} now renders ${current} raw control(s), below its pinned ${pinned}. ` +
            `Ratchet the allowlist down to ${current} (or remove the entry) in the same PR that remediated it.`,
        );
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
