/**
 * Issue #590: the deploy job died with exit 139 (SIGSEGV) in
 * "Set core secrets on Cloudflare Worker". The retry wrapper added for
 * #560/#561 called itself instead of `wrangler secret put`, so bash
 * recursed until it crashed — and every secret step in deploy.yml shared
 * the same defect.
 *
 * These assertions pin the wrapper to the broker command and keep the
 * piped value reusable across retries: a retry that reads an
 * already-drained stdin would silently push an empty secret.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf-8"
);

/** Every `put_secret() { ... }` body in the workflow. */
function wrapperBodies(): string[] {
  const bodies: string[] = [];
  const marker = "put_secret() {";
  let index = workflow.indexOf(marker);
  while (index !== -1) {
    const end = workflow.indexOf("\n          }", index);
    expect(end, "unterminated put_secret wrapper").toBeGreaterThan(index);
    bodies.push(workflow.slice(index, end));
    index = workflow.indexOf(marker, end);
  }
  return bodies;
}

describe("deploy.yml — wrangler secret retry wrapper (#590)", () => {
  it("defines the wrapper in every secret step", () => {
    expect(wrapperBodies()).toHaveLength(3);
  });

  it("never recurses: the retry calls wrangler, not put_secret itself", () => {
    for (const body of wrapperBodies()) {
      expect(body).not.toMatch(/if\s+put_secret\s+"\$name"/);
      expect(body).toContain('npx wrangler secret put "$name"');
    }
  });

  it("reads stdin once so a retry re-feeds the same value", () => {
    for (const body of wrapperBodies()) {
      expect(body).toContain('payload="$(cat)"');
      expect(body).toContain('printf "%s" "$payload" | npx wrangler secret put "$name"');
    }
  });

  it("still caps attempts at three", () => {
    for (const body of wrapperBodies()) {
      expect(body).toContain("max=3");
      expect(body).toContain('echo "put_secret: \'$name\' failed after $max attempts" >&2');
    }
  });
});
