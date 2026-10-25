import { describe, it, expect } from "vitest";
import {
  authorize,
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";

/**
 * Issue #945, Slice 3 / spec §6 — tenant isolation.
 *
 * A membership in Tenant A grants nothing in Tenant B, whether the
 * access is attempted by a named tenant, a direct resource id, or an
 * export. This file tests the pure PDP only; search, export, and job
 * enforcement at live call sites is later wiring, not claimed here.
 */

const NOW = 1_800_000_000_000;

async function seedTenantA(store: ReturnType<typeof createMemoryMembershipStore>) {
  const admin = await createMembership(store, {
    internalUserId: "admin-a",
    tenantId: "tenant-a",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  const member = await createMembership(store, {
    internalUserId: "user-a",
    tenantId: "tenant-a",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-a" }],
    createdBy: "admin-a",
    nowMs: NOW,
  });
  if (!admin.ok || !member.ok) throw new Error("seed failed");
}

describe("iaaa tenant isolation (#945 slice 3)", () => {
  it("denies Tenant A member access to Tenant B resources", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    const decision = await authorize(store, {
      actorInternalUserId: "user-a",
      tenantId: "tenant-b",
      permission: "task:read",
      resourceScope: { resourceOwnerId: "user-a" },
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("CROSS_TENANT");
  });

  it("denies Tenant A admin inviting into Tenant B", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    const decision = await authorize(store, {
      actorInternalUserId: "admin-a",
      tenantId: "tenant-b",
      permission: "membership:invite",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("CROSS_TENANT");
  });

  it("denies access via a direct resource id in another tenant", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    // The resource id alone carries no authority: the request tenant
    // is Tenant B, where the actor has no membership, so the id is
    // irrelevant to the decision.
    const decision = await authorize(store, {
      actorInternalUserId: "user-a",
      tenantId: "tenant-b",
      permission: "artifact:export",
      resourceScope: { resourceId: "artifact-tenant-b-123" },
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("CROSS_TENANT");
  });

  it("denies Tenant A member exporting Tenant B audit data", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    const decision = await authorize(store, {
      actorInternalUserId: "user-a",
      tenantId: "tenant-b",
      permission: "audit:export",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });

  it("allows the same user in both tenants only via their own Tenant B membership", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    const b = await createMembership(store, {
      internalUserId: "user-a",
      tenantId: "tenant-b",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-b" }],
      createdBy: "admin-b",
      nowMs: NOW,
    });
    expect(b.ok).toBe(true);
    const decision = await authorize(store, {
      actorInternalUserId: "user-a",
      tenantId: "tenant-b",
      permission: "task:read",
      resourceScope: { resourceOwnerId: "user-a" },
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("keeps legitimate same-tenant workflows working (a system that denies everything fails)", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    const base = { actorInternalUserId: "user-a", tenantId: "tenant-a", nowMs: NOW } as const;
    expect((await authorize(store, { ...base, permission: "task:create" })).decision).toBe("allow");
    expect((await authorize(store, { ...base, permission: "artifact:edit", resourceScope: { resourceOwnerId: "user-a" } })).decision).toBe("allow");
    expect(
      (await authorize(store, { actorInternalUserId: "admin-a", tenantId: "tenant-a", permission: "audit:read", nowMs: NOW })).decision,
    ).toBe("allow");
  });

  it("does not leak a Tenant B membership through a Tenant A request", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantA(store);
    await createMembership(store, {
      internalUserId: "user-a",
      tenantId: "tenant-b",
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-1" }],
      createdBy: "platform-1",
      nowMs: NOW,
    });
    // Tenant B admin privileges must not spill into Tenant A, where
    // the actor is only a member.
    const decision = await authorize(store, {
      actorInternalUserId: "user-a",
      tenantId: "tenant-a",
      permission: "membership:invite",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });
});
