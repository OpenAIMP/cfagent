/**
 * Issue #2450 — member self-connect with admin per-user revoke.
 *
 * TDD Red-first: the blanket member grant (integration:connect in
 * the member role) plus the per-user permission-denial layer.
 *
 * The denial layer is a NEW deny/override authority, consulted by
 * authorizeWithPolicy BEFORE role grants (deny-beats-grant). No
 * per-user permission path exists today: RoleBinding has no
 * per-permission field, the PIP reads memberships only, and
 * revoking a membership kills ALL of that user's permissions, not
 * just connect. So a denial is its own record, not a membership
 * edit, and clearing it restores exactly the denied permission.
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizeWithPolicy,
  createMembership,
  createMemoryMembershipStore,
  getCompiledPolicySnapshot,
  membershipStoreToAttributeProvider,
} from "../src/security/authorization";
import {
  MANAGEABLE_DENIED_PERMISSIONS,
  canManagePermissionDenial,
  createMemoryPermissionDenialStore,
} from "../src/security/permissionDenials";

const NOW = 1_800_000_000_000;

async function seedMember(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user = "user-1",
  tenant = "tenant-a",
) {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: tenant,
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-1" }],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

async function seedTenantAdmin(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user = "admin-1",
  tenant = "tenant-a",
) {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: tenant,
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

async function seedWorkspaceAdmin(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user = "ws-admin-1",
  tenant = "tenant-a",
) {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: tenant,
    roleBindings: [{ role: "workspace-admin", scope: "workspace", workspaceId: "ws-1", grantedBy: "admin-1" }],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

async function seedPlatformAdmin(
  store: ReturnType<typeof createMemoryMembershipStore>,
  user = "platform-1",
) {
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

function connectRequest(actor: string, tenant = "tenant-a") {
  return {
    actorInternalUserId: actor,
    tenantId: tenant,
    permission: "integration:connect" as const,
    nowMs: NOW,
  };
}

describe("member self-connect grant (#2450)", () => {
  it("member role includes integration:connect but not use/manage", () => {
    const snapshot = getCompiledPolicySnapshot();
    expect(snapshot.roleGrants.member).toContain("integration:connect");
    expect(snapshot.roleGrants.member).not.toContain("integration:use");
    expect(snapshot.roleGrants.member).not.toContain("integration:manage");
  });

  it("a member can connect by default (no denial)", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const decision = await authorize(store, connectRequest("user-1"));
    expect(decision.decision).toBe("allow");
  });

  it("only integration:connect is manageable as a denial in this slice", () => {
    expect([...MANAGEABLE_DENIED_PERMISSIONS]).toEqual(["integration:connect"]);
  });
});

describe("permission-denial layer (#2450)", () => {
  it("a denied member cannot connect: PERMISSION_DENIED, deny-beats-grant", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      connectRequest("user-1"),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PERMISSION_DENIED");
  });

  it("a denial beats even a tenant-admin grant", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantAdmin(store, "admin-1");
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "admin-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-2",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      connectRequest("admin-1"),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PERMISSION_DENIED");
  });

  it("a denial for another permission does not block connect", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:create",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      connectRequest("user-1"),
    );
    expect(decision.decision).toBe("allow");
  });

  it("a denial in another tenant does not block", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-b",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      connectRequest("user-1"),
    );
    expect(decision.decision).toBe("allow");
  });

  it("other members are unaffected by one member's denial", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store, "user-1");
    await seedMember(store, "user-2");
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const provider = membershipStoreToAttributeProvider(store, denials);
    const denied = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      provider,
      connectRequest("user-1"),
    );
    const allowed = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      provider,
      connectRequest("user-2"),
    );
    expect(denied.decision).toBe("deny");
    expect(allowed.decision).toBe("allow");
  });

  it("clearing a denial restores connect exactly", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const provider = membershipStoreToAttributeProvider(store, denials);
    const before = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      provider,
      connectRequest("user-1"),
    );
    expect(before.decision).toBe("deny");
    expect(await denials.clearDenial("deny-1")).toBe(true);
    const after = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      provider,
      connectRequest("user-1"),
    );
    expect(after.decision).toBe("allow");
  });

  it("no membership still reports NO_MEMBERSHIP, not the denial", async () => {
    const store = createMemoryMembershipStore();
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "ghost-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      connectRequest("ghost-1"),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("NO_MEMBERSHIP");
  });

  it("a revoked membership still reports MEMBERSHIP_REVOKED, not the denial", async () => {
    const store = createMemoryMembershipStore();
    const membership = await seedMember(store);
    await store.revokeMembership(membership.membershipId, NOW);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      connectRequest("user-1"),
    );
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("MEMBERSHIP_REVOKED");
  });

  it("a provider without denials behaves exactly as before", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store),
      connectRequest("user-1"),
    );
    expect(decision.decision).toBe("allow");
  });

  it("authorize() accepts an optional denial store", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorize(store, connectRequest("user-1"), denials);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PERMISSION_DENIED");
  });

  it("platform scope is untouched by tenant denials", async () => {
    const store = createMemoryMembershipStore();
    await seedPlatformAdmin(store);
    const denials = createMemoryPermissionDenialStore();
    await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "platform-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const decision = await authorizeWithPolicy(
      getCompiledPolicySnapshot(),
      membershipStoreToAttributeProvider(store, denials),
      {
        actorInternalUserId: "platform-1",
        permission: "audit:read",
        scope: "platform",
        nowMs: NOW,
      },
    );
    expect(decision.decision).toBe("allow");
  });

  it("a second put for the same user/tenant/permission keeps the first denial", async () => {
    const denials = createMemoryPermissionDenialStore();
    const first = await denials.putDenial({
      denialId: "deny-1",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-1",
      deniedAtMs: NOW,
    });
    const second = await denials.putDenial({
      denialId: "deny-2",
      internalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "integration:connect",
      deniedBy: "admin-2",
      deniedAtMs: NOW + 1000,
    });
    expect(second.denialId).toBe(first.denialId);
    expect(second.deniedBy).toBe("admin-1");
    expect((await denials.getDenialsByUser("user-1")).length).toBe(1);
  });

  it("clearing a missing denial returns false", async () => {
    const denials = createMemoryPermissionDenialStore();
    expect(await denials.clearDenial("no-such-denial")).toBe(false);
  });
});

describe("who may manage denials (#2450)", () => {
  it("a tenant-admin in the tenant may manage", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantAdmin(store);
    const decision = await canManagePermissionDenial(store, {
      managerInternalUserId: "admin-1",
      targetTenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("a member may not manage", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const decision = await canManagePermissionDenial(store, {
      managerInternalUserId: "user-1",
      targetTenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });

  it("a tenant-admin in another tenant may not manage here", async () => {
    const store = createMemoryMembershipStore();
    await seedTenantAdmin(store, "admin-1", "tenant-b");
    const decision = await canManagePermissionDenial(store, {
      managerInternalUserId: "admin-1",
      targetTenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });

  it("a platform-admin gains no tenant denial authority from platform scope", async () => {
    const store = createMemoryMembershipStore();
    await seedPlatformAdmin(store);
    const decision = await canManagePermissionDenial(store, {
      managerInternalUserId: "platform-1",
      targetTenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });

  it("a workspace-admin may not manage tenant-wide denials", async () => {
    const store = createMemoryMembershipStore();
    await seedWorkspaceAdmin(store);
    const decision = await canManagePermissionDenial(store, {
      managerInternalUserId: "ws-admin-1",
      targetTenantId: "tenant-a",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
  });
});
