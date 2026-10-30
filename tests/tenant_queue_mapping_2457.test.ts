/**
 * Issue #2457 — tenant-to-login mapping for cross-tenant queue management.
 *
 * The mapping is the prerequisite design made executable: a tenant resolves
 * to login instances through stored records only — memberships for tenancy,
 * the wired-login alias record plus live session records for logins. Nothing
 * is derived from a login name, and a tenantId is never used to construct
 * an instance name.
 */
import { describe, it, expect } from "vitest";
import {
  isTenantIdShaped,
  listTenantIds,
  resolveTenantLogins,
  tenantMemberIds,
} from "../src/security/tenantQueueMapping";
import type { Membership } from "../src/security/authorization";

function membership(
  membershipId: string,
  internalUserId: string,
  tenantId: string,
  overrides: Partial<Membership> = {},
): Membership {
  return {
    membershipId,
    internalUserId,
    tenantId,
    roleBindings: [
      { role: "member", scope: "tenant", grantedBy: "test" },
    ],
    createdBy: "test",
    createdAtMs: 1,
    ...overrides,
  };
}

const SESSION_ENTRIES = [
  {
    key: "11111111-1111-4111-8111-111111111111",
    value: JSON.stringify({ githubLogin: "alice", internalUserId: "user-alice" }),
  },
  {
    key: "22222222-2222-4222-8222-222222222222",
    value: JSON.stringify({ githubLogin: "bob-alt", internalUserId: "user-bob" }),
  },
];

describe("tenantQueueMapping (#2457)", () => {
  it("lists distinct tenant ids, sorted", () => {
    const memberships = [
      membership("m1", "u1", "tenant-b"),
      membership("m2", "u2", "tenant-a"),
      membership("m3", "u3", "tenant-b"),
    ];
    expect(listTenantIds(memberships)).toEqual(["tenant-a", "tenant-b"]);
  });

  it("tenant members are distinct internalUserIds with a non-revoked record", () => {
    const memberships = [
      membership("m1", "u1", "tenant-a"),
      membership("m2", "u1", "tenant-a"),
      membership("m3", "u2", "tenant-a", { revokedAtMs: 5 }),
      membership("m4", "u3", "tenant-b"),
    ];
    expect(tenantMemberIds(memberships, "tenant-a")).toEqual(["u1"]);
  });

  it("binding expiry does not remove tenancy (expiry governs permission, revocation governs membership)", () => {
    const memberships = [
      membership("m1", "u1", "tenant-a", {
        roleBindings: [
          { role: "member", scope: "tenant", grantedBy: "test", expiresAtMs: 1 },
        ],
      }),
    ];
    expect(tenantMemberIds(memberships, "tenant-a")).toEqual(["u1"]);
  });

  it("resolves logins from the alias record first", async () => {
    const memberships = [membership("m1", "user-alice", "tenant-a")];
    const resolution = await resolveTenantLogins({
      memberships,
      tenantId: "tenant-a",
      lookupLogin: async (id) => (id === "user-alice" ? "alice" : null),
      sessionEntries: SESSION_ENTRIES,
    });
    expect(resolution.zeroResolved).toBe(false);
    expect(resolution.resolvedLogins).toEqual(["alice"]);
    expect(resolution.unmappedMembers).toEqual([]);
    expect(resolution.members).toEqual([
      { internalUserId: "user-alice", logins: ["alice"], unmapped: false },
    ]);
  });

  it("unions alias logins with session logins for one member", async () => {
    const memberships = [membership("m1", "user-bob", "tenant-a")];
    const resolution = await resolveTenantLogins({
      memberships,
      tenantId: "tenant-a",
      lookupLogin: async (id) => (id === "user-bob" ? "bob" : null),
      sessionEntries: SESSION_ENTRIES,
    });
    expect(resolution.resolvedLogins).toEqual(["bob", "bob-alt"]);
  });

  it("falls back to session records when no alias exists", async () => {
    const memberships = [membership("m1", "user-alice", "tenant-a")];
    const resolution = await resolveTenantLogins({
      memberships,
      tenantId: "tenant-a",
      lookupLogin: async () => null,
      sessionEntries: SESSION_ENTRIES,
    });
    expect(resolution.resolvedLogins).toEqual(["alice"]);
  });

  it("reports members with neither alias nor session as unmapped, never guessed", async () => {
    const memberships = [
      membership("m1", "user-alice", "tenant-a"),
      membership("m2", "user-ghost", "tenant-a"),
    ];
    const resolution = await resolveTenantLogins({
      memberships,
      tenantId: "tenant-a",
      lookupLogin: async (id) => (id === "user-alice" ? "alice" : null),
      sessionEntries: SESSION_ENTRIES,
    });
    expect(resolution.resolvedLogins).toEqual(["alice"]);
    expect(resolution.unmappedMembers).toEqual(["user-ghost"]);
    expect(resolution.zeroResolved).toBe(false);
    expect(
      resolution.members.find((m) => m.internalUserId === "user-ghost"),
    ).toEqual({ internalUserId: "user-ghost", logins: [], unmapped: true });
  });

  it("zero resolved logins is a fail-closed outcome, not an empty success", async () => {
    const memberships = [membership("m1", "user-ghost", "tenant-a")];
    const resolution = await resolveTenantLogins({
      memberships,
      tenantId: "tenant-a",
      lookupLogin: async () => null,
      sessionEntries: [],
    });
    expect(resolution.zeroResolved).toBe(true);
    expect(resolution.resolvedLogins).toEqual([]);
    expect(resolution.unmappedMembers).toEqual(["user-ghost"]);
  });

  it("a tenant with no members at all is zero-resolved", async () => {
    const resolution = await resolveTenantLogins({
      memberships: [],
      tenantId: "tenant-empty",
      lookupLogin: async () => null,
      sessionEntries: [],
    });
    expect(resolution.zeroResolved).toBe(true);
    expect(resolution.members).toEqual([]);
  });

  it("rejects malformed tenant ids", () => {
    expect(isTenantIdShaped("")).toBe(false);
    expect(isTenantIdShaped("   ")).toBe(false);
    expect(isTenantIdShaped("has space")).toBe(false);
    expect(isTenantIdShaped("tenant-a")).toBe(true);
    expect(isTenantIdShaped(42)).toBe(false);
  });
});
