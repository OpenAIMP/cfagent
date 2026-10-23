/**
 * Issue #606 (part of #415, phase 4): the KV bindings are gone.
 *
 * #604 removed the dormant KV fallback code (sessions + E*TRADE tokens now
 * live in the SessionStore DO), and #605 moved report blobs to R2. What
 * remained was the `kv_namespaces` declaration itself. These pins keep it
 * from creeping back: no KV bindings in wrangler.jsonc, and no production
 * code reading `env.SESSIONS` / `env.ETRADE_KV`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("#606 KV bindings removed", () => {
  it("wrangler.jsonc declares no kv_namespaces", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).not.toContain('"kv_namespaces"');
    expect(wrangler).not.toContain('"binding": "SESSIONS"');
    expect(wrangler).not.toContain('"binding": "ETRADE_KV"');
  });

  it("no production source reads env.SESSIONS or env.ETRADE_KV", () => {
    const offenders: string[] = [];
    for (const file of listTs(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      if (/\b\w+\.(SESSIONS|ETRADE_KV)\b/.test(text)) {
        offenders.push(file.replace(ROOT + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
