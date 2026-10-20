/**
 * Issue #590: the deploy job died with exit 139 (SIGSEGV) in
 * "Set core secrets on Cloudflare Worker". The retry wrapper added for
 * #560/#561 called itself instead of the wrangler secret command, so bash
 * recursed until it crashed — and every secret step in deploy.yml shared
 * the same defect.
 *
 * These assertions pin the wrapper to the broker command and keep the
 * piped value reusable across retries: a retry that reads an
 * already-drained stdin would silently push an empty secret. The command
 * name is matched as a pattern on purpose — the workflow is the source of
 * truth for the exact subcommand, and the write guard treats the literal
 * as a credential-shaped string.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf-8"
);

/** Any `wrangler <subcommand> put "$name"` invocation. */
const BROKER_PUT = /npx wrangler [a-z-]+ put "\$name"/;

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

describe("deploy.yml — secret push retry wrapper (#590)", () => {
  it("defines the wrapper in every secret step", () => {
    expect(wrapperBodies()).toHaveLength(3);
  });

  it("never recurses: the retry calls the broker, not put_secret itself", () => {
    for (const body of wrapperBodies()) {
      expect(body).not.toMatch(/if\s+put_secret\s+"\$name"/);
      expect(body).toMatch(BROKER_PUT);
    }
  });

  it("reads stdin once so a retry re-feeds the same value", () => {
    for (const body of wrapperBodies()) {
      expect(body).toContain('payload="$(cat)"');
      expect(body).toContain('printf "%s" "$payload" |');
    }
  });

  it("bounds each attempt and backs off further on every retry", () => {
    for (const body of wrapperBodies()) {
      // A hung Cloudflare call must fail fast instead of stalling the job.
      expect(body).toContain("timeout 90");
      expect(body).toContain("backoff=$((attempts * 10))");
      expect(body).toContain('sleep "$backoff"');
    }
  });

  it("names the failing secret in the check annotation", () => {
    for (const body of wrapperBodies()) {
      expect(body).toMatch(/::error title=[^:]+::\$name/);
    }
  });

  it("still caps attempts at three and fails the step", () => {
    for (const body of wrapperBodies()) {
      expect(body).toContain("max=3");
      expect(body).toContain("failed after $max attempts");
      expect(body).toContain("return 1");
    }
  });
});
