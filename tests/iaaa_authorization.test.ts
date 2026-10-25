import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  authorize,
  canGrantRole,
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";
import type { Membership } from "../src/security/authorization";

/**
 * Issue #945, Slice 3 — membership + scoped authorization PDP (pure policy).
 *
 * Default is deny: a permission not explicitly granted by an active,
 * in-scope role binding is denied, and no live route, API, job, tool,
 * or storage is touched by this module. Delegation (Slice 4) and audit
 * events (Slice 5) are not modelled here; the approver role below is
 * only a role grant, not an approval workflow.
 */

const NOW = 1_800_000_000_000;

async function member(
  store: ReturnType<typeof createMemoryMembershipStore>,
  overrides: Partial<Membership> = {},
): Promise<Membership> {
  const result = await createMembership(store, {
    internalUserId: "user-1",
    tenantId: "tenant-a",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-1" }],
    createdBy: "admin-1",
    nowMs: NOW,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

async function tenantAdmin(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user = "admin-1",
): Promise<Membership> {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: "tenant-a",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

async function platformAdmin(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user = "platform-1",
): Promise<Membership> {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: "platform",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

describe("iaaa authorization PDP (#945 slice 3)", () => {
  it("lists every spec §5 permission in the matrix", () => {
    for (const p of [
      "membership:invite",
      "membership:revoke",
      "role:assign",
      "task:create",
      "task:read",
      "task:cancel",
      "artifact:read",
      "artifact:edit",
      "artifact:export",
      "integration:connect",
      "integration:use",
      "integration:manage",
      "action:propose",
      "action:approve",
      "action:execute",
      "audit:read",
      "audit:export",
    ]) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  it("allows a member to read a task in their own tenant and own scope", async () => {
    const store = createMemoryMembershipStore();
    await member(store);
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceScope: { resourceOwnerId: "user-1" },
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("allows a member to propose an action, but not to approve or execute it", async () => {
    const store = createMemoryMembershipStore();
    await member(store);
    const base = {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      nowMs: NOW,
    } as const;
    expect((await authorize(store, { ...base, permission: "action:propose" })).decision).toBe("allow");
    expect((await authorize(store, { ...base, permission: "action:approve" })).decision).toBe("deny");
    expect((await authorize(store, { ...base, permission: "action:execute" })).decision).toBe("deny");
  });

  it("allows a tenant admin to invite within their own tenant", async () => {
    const store = createMemoryMembershipStore();
    await tenantAdmin(store);
    const decision = await authorize(store, {
      actorInternalUserId: "admin-1",
      tenantId: "tenant-a",
      permission: "membership:invite",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("allows a tenant admin to assign a tenant-scoped role in their own tenant", async () => {
    const store = createMemoryMembershipStore();
    await tenantAdmin(store);
    const decision = await canGrantRole(store, {
      granterInternalUserId: "admin-1",
      targetTenantId: "tenant-a",
      targetScope: "tenant",
      targetRole: "member",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies a tenant admin granting a platform privilege", async () => {
    const store = createMemoryMembershipStore();
    await tenantAdmin(store);
    const decision = await canGrantRole(store, {
      granterInternalUserId: "admin-1",
      targetTenantId: "platform",
      targetScope: "platform",
      targetRole: "platform-admin",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PLATFORM_SCOPE_DENIED");
  });

  it("denies any non-platform-admin granting a platform-scoped permission", async () => {
    const store = createMemoryMembershipStore();
    await member(store);
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "role:assign",
      scope: "platform",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PLATFORM_SCOPE_DENIED");
  });

  it("allows a platform admin to assign a platform role, but not tenant permissions by platform membership alone", async () => {
    const store = createMemoryMembershipStore();
    await platformAdmin(store);
    const platformGrant = await authorize(store, {
      actorInternalUserId: "platform-1",
      permission: "role:assign",
      scope: "platform",
      nowMs: NOW,
    });
    expect(platformGrant.decision).toBe("allow");
    const tenantRead = await authorize(store, {
      actorInternalUserId: "platform-1",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(tenantRead.decision).toBe("deny");
    // The platform membership is not a tenant membership, so the
    // tenant request is cross-tenant from this actor's position.
    expect(tenantRead.reason).toBe("CROSS_TENANT");
  });

  it("denies an unknown permission (default-deny)", async () => {
    const store = createMemoryMembershipStore();
    await tenantAdmin(store);
    const decision = await authorize(store, {
      actorInternalUserId: "admin-1",
      tenantId: "tenant-a",
      // Deliberately not in the matrix.
      permission: "task:delete-everything" as never,
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("UNKNOWN_PERMISSION");
  });

  it("denies a non-member", async () => {
    const store = createMemoryMembershipStore();
    await member(store);
    const decision = await authorize(store, {
      actorInternalUserId: "user-2",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_MEMBERSHIP");
  });

  it("denies a member reading another user's own-scope resource", async () => {
    const store = createMemoryMembershipStore();
    await member(store);
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "artifact:read",
      resourceScope: { resourceOwnerId: "user-2" },
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NOT_OWN_SCOPE");
  });

  it("denies a revoked membership", async () => {
    const store = createMemoryMembershipStore();
    const m = await member(store);
    await store.revokeMembership(m.membershipId, NOW);
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("MEMBERSHIP_REVOKED");
  });

  it("denies an expired role binding while other bindings still apply", async () => {
    const store = createMemoryMembershipStore();
    await member(store, {
      roleBindings: [
        { role: "member", scope: "tenant", grantedBy: "admin-1", expiresAtMs: NOW - 1 },
      ],
    });
    const decision = await authorize(store, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:read",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_GRANT");
  });

  it("denies a workspace admin acting outside their workspace", async () => {
    const store = createMemoryMembershipStore();
    const result = await createMembership(store, {
      internalUserId: "ws-admin",
      tenantId: "tenant-a",
      workspaceId: "ws-1",
      roleBindings: [{ role: "workspace-admin", scope: "workspace", workspaceId: "ws-1", grantedBy: "admin-1" }],
      createdBy: "admin-1",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    const decision = await authorize(store, {
      actorInternalUserId: "ws-admin",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceScope: { workspaceId: "ws-2" },
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("SCOPE_MISMATCH");
  });

  it("allows an auditor to read but not export audit data", async () => {
    const store = createMemoryMembershipStore();
    const result = await createMembership(store, {
      internalUserId: "auditor-1",
      tenantId: "tenant-a",
      roleBindings: [{ role: "auditor", scope: "tenant", grantedBy: "admin-1" }],
      createdBy: "admin-1",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    const base = { actorInternalUserId: "auditor-1", tenantId: "tenant-a", nowMs: NOW } as const;
    expect((await authorize(store, { ...base, permission: "audit:read" })).decision).toBe("allow");
    expect((await authorize(store, { ...base, permission: "audit:export" })).decision).toBe("deny");
    expect((await authorize(store, { ...base, permission: "task:create" })).decision).toBe("deny");
  });

  it("allows an approver to approve only when assigned, and never to execute", async () => {
    const store = createMemoryMembershipStore();
    const result = await createMembership(store, {
      internalUserId: "approver-1",
      tenantId: "tenant-a",
      roleBindings: [{ role: "approver", scope: "tenant", grantedBy: "admin-1" }],
      createdBy: "admin-1",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    const base = { actorInternalUserId: "approver-1", tenantId: "tenant-a", nowMs: NOW } as const;
    expect(
      (await authorize(store, { ...base, permission: "action:approve", resourceScope: { assignedApproverId: "approver-1" } })).decision,
    ).toBe("allow");
    expect(
      (await authorize(store, { ...base, permission: "action:approve", resourceScope: { assignedApproverId: "approver-2" } })).decision,
    ).toBe("deny");
    expect((await authorize(store, { ...base, permission: "action:execute" })).decision).toBe("deny");
  });

  it("does not let possessing a permission grant the right to grant it", async () => {
    const store = createMemoryMembershipStore();
    await member(store);
    // A member can read tasks, but that alone must not let them assign roles.
    const decision = await canGrantRole(store, {
      granterInternalUserId: "user-1",
      targetTenantId: "tenant-a",
      targetScope: "tenant",
      targetRole: "member",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });

  it("rejects a membership with an empty tenant id and writes nothing", async () => {
    const store = createMemoryMembershipStore();
    const result = await createMembership(store, {
      internalUserId: "user-1",
      tenantId: "   ",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-1" }],
      createdBy: "admin-1",
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_TENANT_ID");
    expect(await store.getMembershipsByUser("user-1")).toEqual([]);
  });
});
