/**
 * Issue #540 — floating `latest` dependencies pinned (cloudflare.md §4–5).
 *
 * The conformance baseline (§4) must record declared *and* resolved
 * versions; a `latest` tag makes the declared version meaningless and the
 * build non-reproducible (the installed version silently changes whenever
 * the tag moves). This suite fails if any dependency spec becomes a
 * floating tag again, if the six formerly-floating packages lose their
 * exact pins, or if package.json and the lockfile root entry drift apart.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")
);

const FLOATING_TAGS = new Set(["latest", "*", "next", "canary", "beta", "alpha"]);

/** Packages that floated on `latest` before #540, with their lockfile home. */
const FORMERLY_FLOATING: Array<{ name: string; section: "dependencies" | "devDependencies" }> = [
  { name: "@ai-sdk/react", section: "dependencies" },
  { name: "@cloudflare/ai-chat", section: "dependencies" },
  { name: "ai", section: "dependencies" },
  { name: "workers-ai-provider", section: "dependencies" },
  { name: "@cloudflare/workers-types", section: "devDependencies" },
  { name: "wrangler", section: "devDependencies" },
];

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function allSpecs(): Array<{ section: string; name: string; spec: string }> {
  const out: Array<{ section: string; name: string; spec: string }> = [];
  for (const section of ["dependencies", "devDependencies"] as const) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      out.push({ section, name, spec: String(spec) });
    }
  }
  return out;
}

describe("dependency pinning (issue #540)", () => {
  it("no dependency spec is a floating tag", () => {
    const floating = allSpecs().filter(
      ({ spec }) => FLOATING_TAGS.has(spec.trim().toLowerCase())
    );
    expect(floating).toEqual([]);
  });

  it("the formerly-floating packages are pinned to exact versions", () => {
    for (const { name, section } of FORMERLY_FLOATING) {
      const spec = pkg[section]?.[name];
      expect(spec, `${name} present in ${section}`).toBeTruthy();
      expect(spec, `${name} is an exact version`).toMatch(EXACT_VERSION);
    }
  });

  it("pinned specs equal the versions resolved in the lockfile", () => {
    for (const { name, section } of FORMERLY_FLOATING) {
      const resolved = lock.packages?.[`node_modules/${name}`]?.version;
      expect(resolved, `${name} resolved in lockfile`).toBeTruthy();
      expect(pkg[section][name]).toBe(resolved);
    }
  });

  it("package-lock root entry mirrors package.json dependency specs", () => {
    const rootEntry = lock.packages?.[""] ?? {};
    for (const section of ["dependencies", "devDependencies"] as const) {
      expect(rootEntry[section] ?? {}).toEqual(pkg[section] ?? {});
    }
  });
});
