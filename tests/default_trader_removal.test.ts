/**
 * Issue #1185 (design #1066): the legacy shared identity is gone.
 *
 * The literal may survive in exactly one place in src/ —
 * src/security/serviceIdentity.ts, where it is kept ONLY as the
 * SHARED_ORCHESTRATOR_INSTANCE *address* (the Durable Object instance
 * name where pre-removal shared state lives). It must never again
 * appear as a fallback login, a default parameter, a token key, an
 * audit identity, or a payer anywhere in src/.
 *
 * Test files are out of scope: fixtures may use the string as an
 * explicit owner login (a fixture choice, not a fallback).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "..", "src");
const ALLOWED = join("src", "security", "serviceIdentity.ts");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

describe("issue #1185: default_trader removal pin", () => {
  it("the literal survives only as the shared-instance address in serviceIdentity.ts", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = join("src", file.slice(SRC_ROOT.length + 1));
      if (rel === ALLOWED) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("default_trader")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("serviceIdentity.ts keeps the literal only in the address constant", () => {
    const text = readFileSync(join(SRC_ROOT, "security", "serviceIdentity.ts"), "utf8");
    const lines = text.split("\n").filter((l) => l.includes("default_trader"));
    // The constant definition (and any comment line referencing the
    // constant's history) — no code path may use it as a login.
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/SHARED_ORCHESTRATOR_INSTANCE|legacy|address/i);
    }
    expect(text).toContain('export const SHARED_ORCHESTRATOR_INSTANCE = "default_trader";');
  });
});
