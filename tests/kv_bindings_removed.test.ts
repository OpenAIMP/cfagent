/**
 * Issue #606 (phase 4 of #415): KV bindings are gone.
 *
 * Sessions and E*TRADE credentials live in the SessionStore DO (#329);
 * the fallback code was removed in #604 and PDFs moved to R2 in #605.
 * What remains is config hygiene: wrangler.jsonc must declare no KV
 * namespaces, and no src code may reference the old bindings.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) yield p;
  }
}

describe("#606 KV bindings removed", () => {
  it("wrangler.jsonc declares no kv_namespaces and no SESSIONS_KV_FALLBACK var", () => {
    const cfg = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as Record<string, any>;
    expect(cfg.kv_namespaces).toBeUndefined();
    expect(cfg.vars?.SESSIONS_KV_FALLBACK).toBeUndefined();
    // The DO + R2 replacements stay declared.
    expect(JSON.stringify(cfg.durable_objects)).toContain("SESSION_STORE");
    expect(JSON.stringify(cfg.r2_buckets)).toContain("REPORTS_BUCKET");
  });

  it("no src code references env.SESSIONS or env.ETRADE_KV", () => {
    const offenders: string[] = [];
    for (const file of tsFiles("src")) {
      const text = readFileSync(file, "utf8");
      if (/env\.SESSIONS\b|env\.ETRADE_KV\b|\benv\[["']SESSIONS["']\]|\benv\[["']ETRADE_KV["']\]/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
