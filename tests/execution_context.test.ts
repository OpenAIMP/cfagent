import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_POLICY_VERSION,
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";
import type { MembershipStore } from "../src/security/authorization";
import {
  authorizeDelegatedAction,
  createDelegation,
  createMemoryDelegationStore,
} from "../src/security/delegation";
import {
  createMemoryAuditStore,
  verifyChain,
} from "../src/security/iaaaAudit";
import {
  evaluateExecutionContext,
  executionContextMode,
  narrowExecutionContext,
  parseExecutionContext,
  recordContextDecision,
  resolveExecutionContext,
  revalidateExecutionContext,
  serializeExecutionContext,
} from "../src/security/executionContext";
import type {
  ExecutionContext,
  ExecutionContextAuthority,
  ResolveExecutionContextInput,
} from "../src/security/executionContext";

/**
 * Issue #1078 (epic #1070, Phase S1) — validated ExecutionContext
 * contract for #1069 §8. The resolver is the only constructor:
 * contexts are built from server-side authoritative sources (the
 * #945 PDP + membership store, a connection-binding authority),
 * never assembled from client-supplied identifiers trusted on
 * appearance. Every denial is fail-closed and typed.
 */

const NOW = 1_800_000_000_000;

async function seedMember(
  store: MembershipStore,
  overrides: {
    internalUserId?: string;
    tenantId?: string;
    workspaceId?: string;
    role?: "member" | "tenant-admin" | "workspace-admin";
    scope?: "tenant" | "workspace";
  } = {},
): Promise<void> {
  const result = await createMembership(store, {
    internalUserId: overrides.internalUserId ?? "user-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    workspaceId: overrides.workspaceId,
    roleBindings: [
      {
        role: overrides.role ?? "member",
        scope: overrides.scope ?? "tenant",
        workspaceId: overrides.workspaceId,
        grantedBy: "admin-1",
      },
    ],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
}

function authority(
  memberships: MembershipStore,
  bound: Set<string> = new Set(),
): ExecutionContextAuthority {
  return {
    memberships,
    async isConnectionBound(input) {
      return bound.has(
        `${input.tenantId}:${input.principalId}:${input.connectionId}`,
      );
    },
  };
}

function baseInput(
  overrides: Partial<ResolveExecutionContextInput> = {},
): ResolveExecutionContextInput {
  return {
    principalId: "user-1",
    tenantId: "tenant-a",
    taskId: "task-1",
    serviceId: "screener",
    environment: "sandbox",
    permission: "task:create",
    nowMs: NOW,
    ...overrides,
  };
}

async function resolvedContext(
  overrides: Partial<ResolveExecutionContextInput> = {},
): Promise<ExecutionContext> {
  const store = createMemoryMembershipStore();
  await seedMember(store);
  const result = await resolveExecutionContext(
    authority(store),
    baseInput(overrides),
  );
  if (!result.ok) throw new Error(`expected resolution, got ${result.code}`);
  return result.context;
}

describe("resolveExecutionContext", () => {
  it("builds a context from authoritative sources for a member in their tenant", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({ correlationId: "corr-1" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.tenantId).toBe("tenant-a");
    expect(result.context.principalId).toBe("user-1");
    expect(result.context.initiatingPrincipalId).toBe("user-1");
    expect(result.context.taskId).toBe("task-1");
    expect(result.context.serviceId).toBe("screener");
    expect(result.context.environment).toBe("sandbox");
    expect(result.context.policyVersion).toBe(AUTHORIZATION_POLICY_VERSION);
    expect(result.context.correlationId).toBe("corr-1");
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  it("generates a correlation id when the caller does not supply one", async () => {
    const context = await resolvedContext();
    expect(context.correlationId.length).toBeGreaterThan(0);
  });

  it("denies a cross-tenant request with the PDP reason propagated", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({ tenantId: "tenant-b" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PDP_DENIED");
    expect(result.pdpReason).toBe("CROSS_TENANT");
  });

  it("denies a principal with no memberships at all", async () => {
    const store = createMemoryMembershipStore();
    const result = await resolveExecutionContext(
      authority(store),
      baseInput(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PDP_DENIED");
    expect(result.pdpReason).toBe("NO_MEMBERSHIP");
  });

  it("denies a permission the role does not grant", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({ permission: "action:execute" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PDP_DENIED");
    expect(result.pdpReason).toBe("NO_GRANT");
  });

  it("denies after the membership is revoked", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const memberships = await store.getMembershipsByUser("user-1");
    await store.revokeMembership(memberships[0].membershipId, NOW);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("PDP_DENIED");
    expect(result.pdpReason).toBe("MEMBERSHIP_REVOKED");
  });

  it("enforces workspace scoping through the PDP", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store, {
      role: "workspace-admin",
      scope: "workspace",
      workspaceId: "ws-1",
    });
    const okResult = await resolveExecutionContext(
      authority(store),
      baseInput({ workspaceId: "ws-1" }),
    );
    expect(okResult.ok).toBe(true);
    const denied = await resolveExecutionContext(
      authority(store),
      baseInput({ workspaceId: "ws-2" }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("PDP_DENIED");
  });

  it("requires a bound connection when a connection is named", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const unbound = await resolveExecutionContext(
      authority(store),
      baseInput({ connectionId: "conn-1", externalAccountId: "acct-1" }),
    );
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) expect(unbound.code).toBe("CONNECTION_NOT_BOUND");

    const bound = await resolveExecutionContext(
      authority(store, new Set(["tenant-a:user-1:conn-1"])),
      baseInput({ connectionId: "conn-1", externalAccountId: "acct-1" }),
    );
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.context.connectionId).toBe("conn-1");
      expect(bound.context.externalAccountId).toBe("acct-1");
    }
  });

  it("rejects an external account named without its connection", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({ externalAccountId: "acct-1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_FIELD");
  });

  it("requires an approval reference for consequential actions", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denied = await resolveExecutionContext(
      authority(store),
      baseInput({ consequential: true }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("APPROVAL_REQUIRED");

    const allowed = await resolveExecutionContext(
      authority(store),
      baseInput({ consequential: true, approvalReference: "approval-1" }),
    );
    expect(allowed.ok).toBe(true);
  });

  it("requires an approval reference for live-environment execution", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({ environment: "live" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_REQUIRED");
  });

  it("rejects an initiator different from the principal without a delegation", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const denied = await resolveExecutionContext(
      authority(store),
      baseInput({ initiatingPrincipalId: "user-2" }),
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("INITIATOR_MISMATCH");

    const allowed = await resolveExecutionContext(
      authority(store),
      baseInput({
        initiatingPrincipalId: "user-2",
        delegationId: "delegation-1",
      }),
    );
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.context.initiatingPrincipalId).toBe("user-2");
    }
  });

  it("rejects malformed identifiers and environments", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const badTenant = await resolveExecutionContext(
      authority(store),
      baseInput({ tenantId: "   " }),
    );
    expect(badTenant.ok).toBe(false);
    if (!badTenant.ok) expect(badTenant.code).toBe("INVALID_FIELD");

    const badEnv = await resolveExecutionContext(
      authority(store),
      baseInput({
        environment: "production" as ResolveExecutionContextInput["environment"],
      }),
    );
    expect(badEnv.ok).toBe(false);
    if (!badEnv.ok) expect(badEnv.code).toBe("INVALID_FIELD");
  });
});

describe("narrowExecutionContext", () => {
  it("derives an agent-run child that keeps tenant, initiator, and correlation", async () => {
    const parent = await resolvedContext();
    const child = narrowExecutionContext(parent, {
      agentRunId: "run-1",
      delegationId: "delegation-1",
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.context.tenantId).toBe(parent.tenantId);
    expect(child.context.initiatingPrincipalId).toBe(
      parent.initiatingPrincipalId,
    );
    expect(child.context.correlationId).toBe(parent.correlationId);
    expect(child.context.taskId).toBe(parent.taskId);
    expect(child.context.agentRunId).toBe("run-1");
    expect(child.context.delegationId).toBe("delegation-1");
  });

  it("denies sandbox to live escalation", async () => {
    const parent = await resolvedContext();
    const child = narrowExecutionContext(parent, { environment: "live" });
    expect(child.ok).toBe(false);
    if (!child.ok) expect(child.code).toBe("ENVIRONMENT_ESCALATION");
  });

  it("allows live to sandbox narrowing", async () => {
    const parent = await resolvedContext({
      environment: "live",
      approvalReference: "approval-1",
    });
    const child = narrowExecutionContext(parent, { environment: "sandbox" });
    expect(child.ok).toBe(true);
    if (child.ok) expect(child.context.environment).toBe("sandbox");
  });

  it("denies changing the connection on an existing context", async () => {
    const parent = await resolvedContext({ connectionId: undefined });
    const withConnection = narrowExecutionContext(parent, {
      connectionId: "conn-9",
    });
    expect(withConnection.ok).toBe(false);
    if (!withConnection.ok) {
      expect(withConnection.code).toBe("CONNECTION_CHANGE");
    }
  });

  it("denies replacing a parent's approval reference, allows adding one", async () => {
    const parent = await resolvedContext({
      consequential: true,
      approvalReference: "approval-1",
    });
    const replaced = narrowExecutionContext(parent, {
      approvalReference: "approval-2",
    });
    expect(replaced.ok).toBe(false);
    if (!replaced.ok) expect(replaced.code).toBe("REFERENCE_CHANGE");

    const bare = await resolvedContext();
    const added = narrowExecutionContext(bare, {
      approvalReference: "approval-9",
    });
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.context.approvalReference).toBe("approval-9");
  });
});

describe("serialization and revalidation", () => {
  it("round-trips a context across the durable-task boundary", async () => {
    const context = await resolvedContext({ correlationId: "corr-rt" });
    const parsed = parseExecutionContext(serializeExecutionContext(context));
    expect(parsed).toEqual(context);
  });

  it("rejects malformed serialized contexts", () => {
    expect(parseExecutionContext("not json")).toBeNull();
    expect(parseExecutionContext("{}")).toBeNull();
    expect(
      parseExecutionContext(
        JSON.stringify({ tenantId: "tenant-a", environment: "production" }),
      ),
    ).toBeNull();
  });

  it("revalidates a carried context against current authority", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const auth = authority(store);
    const result = await resolveExecutionContext(auth, baseInput());
    if (!result.ok) throw new Error("seed resolution failed");
    const carried = parseExecutionContext(
      serializeExecutionContext(result.context),
    );
    if (!carried) throw new Error("round-trip failed");

    const stillValid = await revalidateExecutionContext(
      auth,
      carried,
      "task:create",
      NOW,
    );
    expect(stillValid.ok).toBe(true);

    const memberships = await store.getMembershipsByUser("user-1");
    await store.revokeMembership(memberships[0].membershipId, NOW);
    const afterRevoke = await revalidateExecutionContext(
      auth,
      carried,
      "task:create",
      NOW,
    );
    expect(afterRevoke.ok).toBe(false);
    if (!afterRevoke.ok) expect(afterRevoke.code).toBe("PDP_DENIED");
  });

  it("catches a tenant swapped in transit at revalidation", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const auth = authority(store);
    const result = await resolveExecutionContext(auth, baseInput());
    if (!result.ok) throw new Error("seed resolution failed");
    const tampered: ExecutionContext = {
      ...result.context,
      tenantId: "tenant-b",
    };
    const check = await revalidateExecutionContext(
      auth,
      tampered,
      "task:create",
      NOW,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.code).toBe("PDP_DENIED");
      expect(check.pdpReason).toBe("CROSS_TENANT");
    }
  });
});

describe("observe / enforce evaluation", () => {
  it("parses the mode with observe as the safe default", () => {
    expect(executionContextMode({})).toBe("observe");
    expect(executionContextMode({ EXECUTION_CONTEXT_MODE: "enforce" })).toBe(
      "enforce",
    );
    expect(executionContextMode({ EXECUTION_CONTEXT_MODE: "bogus" })).toBe(
      "observe",
    );
  });

  it("observe mode surfaces a denial without blocking; enforce mode blocks", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const auth = authority(store);
    const crossTenant = baseInput({ tenantId: "tenant-b" });

    const observed = await evaluateExecutionContext(
      auth,
      crossTenant,
      "observe",
    );
    expect(observed.allowed).toBe(true);
    expect(observed.resolution.ok).toBe(false);

    const enforced = await evaluateExecutionContext(
      auth,
      crossTenant,
      "enforce",
    );
    expect(enforced.allowed).toBe(false);
    expect(enforced.resolution.ok).toBe(false);

    const allowed = await evaluateExecutionContext(auth, baseInput(), "enforce");
    expect(allowed.allowed).toBe(true);
    expect(allowed.resolution.ok).toBe(true);
  });
});

describe("audit emission", () => {
  it("records allow and deny decisions on the IAAA audit chain", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const auth = authority(store);
    const audit = createMemoryAuditStore();

    const allowed = await resolveExecutionContext(
      auth,
      baseInput({ correlationId: "corr-audit" }),
    );
    if (!allowed.ok) throw new Error("seed resolution failed");
    const allowRecord = await recordContextDecision(audit, allowed, NOW);
    expect(allowRecord.ok).toBe(true);

    const denied = await resolveExecutionContext(
      auth,
      baseInput({ tenantId: "tenant-b", correlationId: "corr-audit" }),
    );
    if (denied.ok) throw new Error("expected denial");
    const denyRecord = await recordContextDecision(audit, denied, NOW);
    expect(denyRecord.ok).toBe(true);

    const events = await audit.list();
    expect(events).toHaveLength(2);
    expect(events[0].decision).toBe("allow");
    expect(events[0].tenantId).toBe("tenant-a");
    expect(events[0].correlationId).toBe("corr-audit");
    expect(events[0].initiatingPrincipalId).toBe("user-1");
    expect(events[1].decision).toBe("deny");
    expect(events[1].errorCode).toBe("PDP_DENIED");
    expect(await verifyChain(events)).toBe(true);
  });
});

describe("reference path: API → durable task → agent run → tool call", () => {
  it("propagates the identical context, with delegation checked at the tool boundary", async () => {
    const memberships = createMemoryMembershipStore();
    await seedMember(memberships);
    const auth = authority(
      memberships,
      new Set(["tenant-a:user-1:conn-1"]),
    );

    // API boundary: resolve from the authenticated principal.
    const resolved = await resolveExecutionContext(
      auth,
      baseInput({
        connectionId: "conn-1",
        externalAccountId: "acct-1",
        correlationId: "corr-path",
      }),
    );
    if (!resolved.ok) throw new Error("API-boundary resolution failed");

    // Durable-task boundary: the context crosses as data only.
    const carried = parseExecutionContext(
      serializeExecutionContext(resolved.context),
    );
    if (!carried) throw new Error("context did not survive the task boundary");
    expect(carried).toEqual(resolved.context);

    // Agent boundary: revalidate against current authority, then
    // narrow for the agent run under a real delegation.
    const revalidated = await revalidateExecutionContext(
      auth,
      carried,
      "task:create",
      NOW,
    );
    expect(revalidated.ok).toBe(true);

    const delegationStore = createMemoryDelegationStore();
    const delegation = await createDelegation(memberships, delegationStore, {
      delegatorInternalUserId: "user-1",
      delegateAgentId: "agent-1",
      tenantId: "tenant-a",
      allowedActions: ["task:create"],
      resourceScope: [],
      expiresAtMs: NOW + 60_000,
      reDelegationAllowed: false,
      nowMs: NOW,
      taskId: "task-1",
    });
    if (!delegation.ok) throw new Error("delegation creation failed");

    const child = narrowExecutionContext(carried, {
      agentRunId: "run-1",
      delegationId: delegation.delegation.id,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.context.initiatingPrincipalId).toBe("user-1");
    expect(child.context.correlationId).toBe("corr-path");
    expect(child.context.connectionId).toBe("conn-1");

    // Tool boundary: the delegated action is authorized against
    // the child context's tenant and delegation.
    const toolDecision = authorizeDelegatedAction(delegation.delegation, {
      delegateAgentId: "agent-1",
      tenantId: child.context.tenantId,
      permission: "task:create",
      nowMs: NOW,
    });
    expect(toolDecision.decision).toBe("allow");

    // And the same tool call under a foreign tenant is denied.
    const foreign = authorizeDelegatedAction(delegation.delegation, {
      delegateAgentId: "agent-1",
      tenantId: "tenant-b",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(foreign.decision).toBe("deny");
    expect(foreign.reason).toBe("CROSS_TENANT");
  });
});
