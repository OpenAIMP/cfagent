import { describe, it, expect } from "vitest";
import {
  createDelegation,
  createMemoryDelegationStore,
  createRedelegation,
  authorizeDelegatedAction,
  recheckDelegation,
  revokeDelegation,
  revokeAllForUser,
} from "../src/security/delegation";
import type { Delegation } from "../src/security/delegation";
import {
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";

/**
 * Issue #945, Slice 4 — bounded, revocable agent delegation (pure policy).
 *
 * Spec §6 acceptance case: "Agents cannot expand delegated scope or
 * reuse revoked authority". This module is NOT live enforcement: no
 * route, API, job, tool, or storage is touched, and no live agent or
 * task execution is changed by it. A later slice wires these pure
 * rules into live call sites; until then they are testable policy.
 * Approval is a caller-supplied validity flag only (Slice 5/6
 * territory), not a workflow built here.
 */

const NOW = 1_800_000_000_000;
const EXPIRY = NOW + 3_600_000;

type MembershipStore = ReturnType<typeof createMemoryMembershipStore>;
type DelegationStore = ReturnType<typeof createMemoryDelegationStore>;

async function tenantAdmin(store: MembershipStore, user = "admin-1") {
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

async function member(store: MembershipStore, user = "user-1") {
  const result = await createMembership(store, {
    internalUserId: user,
    tenantId: "tenant-a",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "admin-1" }],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
  return result.membership;
}

async function delegate(
  memberships: MembershipStore,
  delegations: DelegationStore,
  overrides: Record<string, unknown> = {},
): Promise<Delegation> {
  const result = await createDelegation(memberships, delegations, {
    delegatorInternalUserId: "admin-1",
    delegateAgentId: "agent-1",
    tenantId: "tenant-a",
    allowedActions: ["task:read", "artifact:read"],
    resourceScope: ["resource-1"],
    expiresAtMs: EXPIRY,
    budget: { maxActions: 2 },
    reDelegationAllowed: true,
    nowMs: NOW,
    ...overrides,
  } as never);
  if (!result.ok) throw new Error(result.error);
  return result.delegation;
}

describe("iaaa delegation (#945 slice 4)", () => {
  it("allows a delegated action within scope, budget, and expiry", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
    expect(decision.delegation.usedActions).toBe(1);
    // The check itself is pure: the original record is unchanged
    // until the caller persists the returned copy.
    expect(delegation.usedActions).toBe(0);
  });

  it("allows a legitimate delegated workflow and tracks budget use", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    let delegation = await delegate(memberships, delegations);
    for (const permission of ["task:read", "artifact:read"] as const) {
      const decision = authorizeDelegatedAction(delegation, {
        delegateAgentId: "agent-1",
        tenantId: "tenant-a",
        permission,
        resourceId: "resource-1",
        nowMs: NOW,
      });
      expect(decision.decision).toBe("allow");
      delegation = decision.delegation;
    }
    expect(delegation.usedActions).toBe(2);
  });

  it("rejects creation when the delegator lacks a permission", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await member(memberships);
    const result = await createDelegation(memberships, delegations, {
      delegatorInternalUserId: "user-1",
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      allowedActions: ["task:read", "action:execute"],
      resourceScope: [],
      expiresAtMs: EXPIRY,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DELEGATOR_LACKS_PERMISSION");
    expect(await delegations.get("does-not-exist")).toBeNull();
  });

  it("rejects creation with no allowed actions and with an expiry in the past", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const empty = await createDelegation(memberships, delegations, {
      delegatorInternalUserId: "admin-1",
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      allowedActions: [],
      resourceScope: [],
      expiresAtMs: EXPIRY,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(empty.ok).toBe(false);
    const past = await createDelegation(memberships, delegations, {
      delegatorInternalUserId: "admin-1",
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      allowedActions: ["task:read"],
      resourceScope: [],
      expiresAtMs: NOW - 1,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(past.ok).toBe(false);
  });

  it("denies an action outside the delegated permissions", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:cancel",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("ACTION_NOT_DELEGATED");
    expect(decision.delegation.usedActions).toBe(0);
  });

  it("denies an action outside the delegated resource scope", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-2",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("OUT_OF_RESOURCE_SCOPE");
  });

  it("denies a delegation from Tenant A used in Tenant B", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-b",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("CROSS_TENANT");
  });

  it("denies an action by a different delegate than the named agent", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-2",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("DELEGATE_MISMATCH");
  });

  it("denies an expired delegation", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: EXPIRY,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("DELEGATION_EXPIRED");
  });

  it("denies a revoked delegation, including reuse after revocation", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    // Valid before revocation.
    expect(
      authorizeDelegatedAction(delegation, {
        delegateAgentId: "agent-1",
        tenantId: "tenant-a",
        permission: "task:read",
        resourceId: "resource-1",
        nowMs: NOW,
      }).decision,
    ).toBe("allow");
    const revoked = await revokeDelegation(delegations, delegation.id, NOW + 1);
    expect(revoked).toBe(true);
    const stored = await delegations.get(delegation.id);
    expect(stored?.revoked).toBe(true);
    // Reuse after revocation is denied, not silently re-allowed.
    const reused = authorizeDelegatedAction(stored!, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW + 2,
    });
    expect(reused.decision).toBe("deny");
    expect(reused.reason).toBe("DELEGATION_REVOKED");
  });

  it("denies actions after the budget is exhausted", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    let delegation = await delegate(memberships, delegations, {
      budget: { maxActions: 1 },
    });
    const first = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(first.decision).toBe("allow");
    delegation = first.delegation;
    const second = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(second.decision).toBe("deny");
    expect(second.reason).toBe("BUDGET_EXHAUSTED");
    expect(second.delegation.usedActions).toBe(1);
  });

  it("denies an action whose caller-supplied approval flag is invalid", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    const decision = authorizeDelegatedAction(delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      approvalId: "approval-1",
      approvalValid: false,
      nowMs: NOW,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("APPROVAL_INVALID");
  });

  it("re-checks authority at execution time: valid at creation, denied after revocation or expiry", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const delegation = await delegate(memberships, delegations);
    // Creation-time validity does not persist: recheck at execution.
    expect(recheckDelegation(delegation, NOW).valid).toBe(true);
    const revoked = await revokeDelegation(delegations, delegation.id, NOW + 1);
    expect(revoked).toBe(true);
    const stored = await delegations.get(delegation.id);
    expect(recheckDelegation(stored!, NOW + 2).valid).toBe(false);
    expect(recheckDelegation(stored!, NOW + 2).reason).toBe("DELEGATION_REVOKED");
    expect(recheckDelegation(delegation, EXPIRY).valid).toBe(false);
    expect(recheckDelegation(delegation, EXPIRY).reason).toBe("DELEGATION_EXPIRED");
  });

  it("revokes all delegations for a delegator", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const first = await delegate(memberships, delegations);
    const second = await delegate(memberships, delegations, {
      delegateAgentId: "agent-2",
    });
    const count = await revokeAllForUser(delegations, "admin-1", NOW + 1);
    expect(count).toBe(2);
    expect((await delegations.get(first.id))?.revoked).toBe(true);
    expect((await delegations.get(second.id))?.revoked).toBe(true);
    // Already-revoked delegations are not double-counted.
    expect(await revokeAllForUser(delegations, "admin-1", NOW + 2)).toBe(0);
  });

  it("allows re-delegation within the original actions, scope, and expiry", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const original = await delegate(memberships, delegations);
    const result = await createRedelegation(delegations, {
      originalDelegationId: original.id,
      newDelegateAgentId: "agent-2",
      allowedActions: ["task:read"],
      resourceScope: ["resource-1"],
      expiresAtMs: EXPIRY - 1,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected re-delegation to succeed");
    expect(result.delegation.tenantId).toBe("tenant-a");
    expect(result.delegation.delegatorInternalUserId).toBe("agent-1");
    const decision = authorizeDelegatedAction(result.delegation, {
      delegateAgentId: "agent-2",
      tenantId: "tenant-a",
      permission: "task:read",
      resourceId: "resource-1",
      nowMs: NOW,
    });
    expect(decision.decision).toBe("allow");
  });

  it("denies re-delegation when the original forbids it", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const original = await delegate(memberships, delegations, {
      reDelegationAllowed: false,
    });
    const result = await createRedelegation(delegations, {
      originalDelegationId: original.id,
      newDelegateAgentId: "agent-2",
      allowedActions: ["task:read"],
      resourceScope: ["resource-1"],
      expiresAtMs: EXPIRY - 1,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("REDELEGATION_FORBIDDEN");
  });

  it("denies re-delegation wider than the original in actions, scope, or expiry", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const original = await delegate(memberships, delegations);
    const widerActions = await createRedelegation(delegations, {
      originalDelegationId: original.id,
      newDelegateAgentId: "agent-2",
      allowedActions: ["task:read", "task:cancel"],
      resourceScope: ["resource-1"],
      expiresAtMs: EXPIRY - 1,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(widerActions.ok).toBe(false);
    if (!widerActions.ok) expect(widerActions.code).toBe("REDELEGATION_WIDER_ACTIONS");
    const widerScope = await createRedelegation(delegations, {
      originalDelegationId: original.id,
      newDelegateAgentId: "agent-2",
      allowedActions: ["task:read"],
      resourceScope: ["resource-1", "resource-2"],
      expiresAtMs: EXPIRY - 1,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(widerScope.ok).toBe(false);
    if (!widerScope.ok) expect(widerScope.code).toBe("REDELEGATION_WIDER_SCOPE");
    const longer = await createRedelegation(delegations, {
      originalDelegationId: original.id,
      newDelegateAgentId: "agent-2",
      allowedActions: ["task:read"],
      resourceScope: ["resource-1"],
      expiresAtMs: EXPIRY + 1,
      reDelegationAllowed: false,
      nowMs: NOW,
    });
    expect(longer.ok).toBe(false);
    if (!longer.ok) expect(longer.code).toBe("REDELEGATION_LONGER_EXPIRY");
  });

  it("denies re-delegation of a revoked original", async () => {
    const memberships = createMemoryMembershipStore();
    const delegations = createMemoryDelegationStore();
    await tenantAdmin(memberships);
    const original = await delegate(memberships, delegations);
    await revokeDelegation(delegations, original.id, NOW + 1);
    const result = await createRedelegation(delegations, {
      originalDelegationId: original.id,
      newDelegateAgentId: "agent-2",
      allowedActions: ["task:read"],
      resourceScope: ["resource-1"],
      expiresAtMs: EXPIRY - 1,
      reDelegationAllowed: false,
      nowMs: NOW + 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ORIGINAL_REVOKED");
  });
});
