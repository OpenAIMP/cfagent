/**
 * #1197 — bare bootstrap entries may be derived internal ids.
 *
 * Since #1182, internal ids are derived: `v1:` + SHA-256 hex of the
 * normalized (issuer, subject) pair. The bootstrap parser previously
 * accepted a bare entry only as a UUID, so a bare derived id was
 * rejected. This file pins the widened rule: a bare entry is accepted
 * iff it matches the UUID pattern OR exactly `v1:` + 64 lowercase
 * hex characters. Everything else is rejected with the existing
 * error. Issuer:subject parsing and the `platform:` prefix path
 * (which delegates its remainder to the same parser) are unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  parseBootstrapAdmins,
  resolveBootstrapEntries,
} from "../src/security/iaaaBootstrap";
import { createMemoryIdentityBindingStore } from "../src/security/identityBinding";

// Golden vector from #1182 (SHA-256 of "https://github.com\0" + "42").
const V1_ID =
  "v1:0962030c695d4b7f3a855132a8d14e814ede67f43f538a4e67bf68a59f99b72a";
const UUID_A = "11111111-1111-4111-8111-111111111111";

describe("bootstrap parsing of derived v1: ids (#1197)", () => {
  it("accepts a bare derived v1: id as an internalUserId entry", () => {
    const parsed = parseBootstrapAdmins(V1_ID);
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.entries).toEqual([
      { kind: "internalUserId", internalUserId: V1_ID },
    ]);
  });

  it("accepts a mixed list of UUID, v1:, and issuer:subject entries in order", () => {
    const parsed = parseBootstrapAdmins(
      `${UUID_A}, ${V1_ID}, https://github.com:424242`,
    );
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.entries).toEqual([
      { kind: "internalUserId", internalUserId: UUID_A },
      { kind: "internalUserId", internalUserId: V1_ID },
      {
        kind: "providerSubject",
        providerIssuer: "https://github.com",
        providerSubject: "424242",
      },
    ]);
  });

  it("rejects a v1: id with the wrong hex length", () => {
    const short = `v1:${"0".repeat(63)}`;
    const long = `v1:${"0".repeat(65)}`;
    for (const entry of [short, long]) {
      const parsed = parseBootstrapAdmins(entry);
      expect(parsed.entries).toHaveLength(0);
      expect(parsed.rejected).toHaveLength(1);
      expect(parsed.rejected[0]!.entry).toBe(entry);
    }
  });

  it("rejects a v1: id with non-hex characters", () => {
    const entry = `v1:${"g"}${"0".repeat(63)}`;
    const parsed = parseBootstrapAdmins(entry);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
  });

  it("rejects a v1: id with uppercase hex", () => {
    const entry = `v1:${V1_ID.slice(3).toUpperCase()}`;
    expect(entry).toMatch(/^v1:[0-9A-F]{64}$/);
    const parsed = parseBootstrapAdmins(entry);
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
  });

  it("rejects a bare v1: prefix with no hex", () => {
    const parsed = parseBootstrapAdmins("v1:");
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
  });

  it("still rejects a pasted login handle", () => {
    const parsed = parseBootstrapAdmins("octocat");
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]!.entry).toBe("octocat");
  });

  it("passes a parsed v1: id through resolution unchanged", async () => {
    const parsed = parseBootstrapAdmins(V1_ID);
    const resolved = await resolveBootstrapEntries(
      createMemoryIdentityBindingStore(),
      parsed.entries,
    );
    expect(resolved.internalUserIds).toEqual([V1_ID]);
    expect(resolved.unresolved).toHaveLength(0);
  });
});
