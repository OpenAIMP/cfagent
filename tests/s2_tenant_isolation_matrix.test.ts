import { describe, it, expect } from "vitest";
import {
  authorize,
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";
import type {
  MembershipStore,
  Permission,
} from "../src/security/authorization";
import {
  authorizeDelegatedAction,
  createDelegation,
  createMemoryDelegationStore,
  recheckDelegation,
} from "../src/security/delegation";
import type {
  DelegatedActionDecision,
  Delegation,
  DelegationStore,
} from "../src/security/delegation";
import {
  createMemoryAuditStore,
  recordAuditEvent,
  verifyChain,
} from "../src/security/iaaaAudit";
import type { AuditStore } from "../src/security/iaaaAudit";
import {
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
 * Issue #1422 (epic #1070, Phase S2) — the #1069 §10 combination
 * matrix at the contract layer.
 *
 * One scenario fixture, reused across every cell: an authorized
 * Tenant A user runs a premium screening workflow through an
 * approved agent, using a named provider connection and external
 * account in sandbox mode, within budget — and, in the same
 * matrix, cannot access Tenant B, cannot switch to live
 * execution, and cannot bypass approval.
 *
 * Composition under test (real modules, no stubs of the decision
 * logic): Slice 3 PDP (`authorization.ts`), Slice 4 delegation
 * (`delegation.ts`), the S1 ExecutionContext contract
 * (`executionContext.ts`: resolve → serialize → revalidate →
 * narrow), and the Slice 5 audit chain (`iaaaAudit.ts`).
 *
 * Deliberate boundaries, stated so this suite cannot be misread:
 * - Contract layer only. Live route/DO wiring belongs to #945;
 *   nothing here claims a live call site is enforced.
 * - Explicit principals only. The fixture names every principal;
 *   there is no shared/default identity anywhere (the S3
 *   disposition from the #1185 merge: the `default_trader`
 *   legacy exception was removed, and this suite must not
 *   reintroduce it in test form).
 * - §8 stays NOT-SUPPORTED after this lane. The plan's Phase S
 *   exit criteria require S1 *enforced* (not just observing)
 *   AND S2 green before the registry may mark §1/§8 dimensions
 *   supported; the #1078 enforcement flip is still pending, so
 *   this suite proves the contract the wiring will call and
 *   flips nothing.
 * - Entitlement honesty: S1 carries `entitlementReference` but
 *   performs no hard entitlement-balance check — that model is
 *   F3 territory. The enforced budget in this matrix is the
 *   Slice 4 delegation action-count budget, and an entitlement
 *   reference a parent already carries cannot be replaced by
 *   narrowing (REFERENCE_CHANGE). Neither fact is a claim of
 *   commercial entitlement enforcement.
 * - Approval honesty: S1 requires an approval *reference* for
 *   consequential or live execution; the approval workflow that
 *   mints the reference is Slice 5/6 territory, not checked
 *   here. What this suite pins is that execution without the
 *   reference denies, with a typed reason, on the audit chain.
 *
 * Negative-cell discipline: a negative cell passes only when the
 * step under test returns a typed denial AND that denial is
 * recorded on the audit chain. A cell that "passes" because
 * nothing executed — no decision, no audit event — is a failed
 * test, not a pass. Each negative test therefore asserts the
 * denial code, the audit errorCode, and that no allow event for
 * the denied step exists on the chain.
 *
 * Determinism: caller-supplied time seams only (NOW and
 * derivatives); no wall-clock, network, or randomness in any
 * decision. `crypto.randomUUID()` is used only by the modules
 * themselves for ids the tests never assert on (except where a
 * correlation id is explicitly supplied).
 */

const NOW = 1_800_000_000_000;

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const WORKSPACE_A = "ws-a";
const USER_A = "user-a";
const ADMIN_A = "admin-a";
const USER_B = "user-b";
const AGENT_A = "agent-a";
const SERVICE = "premium-screener";
const TASK = "task-s2-screen";
const CONNECTION_A = "conn-a";
const ACCOUNT_A = "acct-a";
const ENTITLEMENT = "ent-premium-a";
const APPROVAL = "approval-s2-1";
const SCREEN_PERMISSION: Permission = "task:create";

// ---------------------------------------------------------------------------
// Scenario fixture
// ---------------------------------------------------------------------------

interface Scenario {
  memberships: MembershipStore;
  delegations: DelegationStore;
  audit: AuditStore;
  authority: ExecutionContextAuthority;
  /** Bound "tenant:principal:connection:account" pairs. */
  bound: Set<string>;
  delegation: Delegation;
}

async function seedMembership(
  store: MembershipStore,
  internalUserId: string,
  tenantId: string,
  role: "member" | "tenant-admin",
): Promise<void> {
  const result = await createMembership(store, {
    internalUserId,
    tenantId,
    workspaceId: tenantId === TENANT_A ? WORKSPACE_A : undefined,
    roleBindings: [{ role, scope: "tenant", grantedBy: "platform-1" }],
    createdBy: "platform-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(`seed failed: ${result.error}`);
}

/**
 * Build the §10 scenario from scratch. Every cell gets a fresh
 * fixture so no cell can pass (or fail) because of another
 * cell's revocation, expiry, or budget consumption.
 */
async function createScenario(options: {
  delegationBudget?: number;
  delegationExpiryMs?: number;
  extraBound?: string[];
} = {}): Promise<Scenario> {
  const memberships = createMemoryMembershipStore();
  // Distinct roles, explicit principals, no default identity:
  // a member (the screening user) and a tenant-admin in Tenant A,
  // a member in Tenant B. Tenant B has no Tenant A principal.
  await seedMembership(memberships, USER_A, TENANT_A, "member");
  await seedMembership(memberships, ADMIN_A, TENANT_A, "tenant-admin");
  await seedMembership(memberships, USER_B, TENANT_B, "member");

  const bound = new Set<string>([
    `${TENANT_A}:${USER_A}:${CONNECTION_A}:${ACCOUNT_A}`,
    ...(options.extraBound ?? []),
  ]);
  const authority: ExecutionContextAuthority = {
    memberships,
    async isConnectionBound(input) {
      return bound.has(
        `${input.tenantId}:${input.principalId}:${input.connectionId}:${input.externalAccountId ?? ""}`,
      );
    },
  };

  const delegations = createMemoryDelegationStore();
  const created = await createDelegation(memberships, delegations, {
    delegatorInternalUserId: USER_A,
    delegateAgentId: AGENT_A,
    tenantId: TENANT_A,
    allowedActions: [SCREEN_PERMISSION],
    resourceScope: [],
    expiresAtMs: options.delegationExpiryMs ?? NOW + 60_000,
    budget:
      options.delegationBudget !== undefined
        ? { maxActions: options.delegationBudget }
        : { maxActions: 10 },
    reDelegationAllowed: false,
    nowMs: NOW,
    taskId: TASK,
  });
  if (!created.ok) throw new Error(`delegation seed failed: ${created.error}`);

  return {
    memberships,
    delegations,
    audit: createMemoryAuditStore(),
    authority,
    bound,
    delegation: created.delegation,
  };
}

function baseResolveInput(
  overrides: Partial<ResolveExecutionContextInput> = {},
): ResolveExecutionContextInput {
  return {
    principalId: USER_A,
    tenantId: TENANT_A,
    workspaceId: WORKSPACE_A,
    taskId: TASK,
    serviceId: SERVICE,
    connectionId: CONNECTION_A,
    externalAccountId: ACCOUNT_A,
    environment: "sandbox",
    permission: SCREEN_PERMISSION,
    consequential: true,
    entitlementReference: ENTITLEMENT,
    approvalReference: APPROVAL,
    correlationId: "corr-s2",
    nowMs: NOW,
    ...overrides,
  };
}

/** Resolve the positive path's context, or throw with the denial code. */
async function resolvePositive(
  scenario: Scenario,
  overrides: Partial<ResolveExecutionContextInput> = {},
): Promise<ExecutionContext> {
  const result = await resolveExecutionContext(
    scenario.authority,
    baseResolveInput(overrides),
  );
  if (!result.ok) {
    throw new Error(`expected resolution, got ${result.code}: ${result.error}`);
  }
  return result.context;
}

// ---------------------------------------------------------------------------
// Audit helpers: every decision point in a cell lands on the chain
// ---------------------------------------------------------------------------

async function auditResolution(
  scenario: Scenario,
  resolution: Awaited<ReturnType<typeof resolveExecutionContext>>,
): Promise<void> {
  const recorded = await recordContextDecision(scenario.audit, resolution, NOW);
  expect(recorded.ok).toBe(true);
}

async function auditDenial(
  scenario: Scenario,
  input: {
    actorPrincipalId: string;
    actorType: "human" | "service" | "agent";
    tenantId: string;
    action: string;
    errorCode: string;
    delegationId?: string;
    correlationId?: string;
  },
): Promise<void> {
  const recorded = await recordAuditEvent(scenario.audit, {
    timestamp: NOW,
    type: "s2.combination.decision",
    actorPrincipalId: input.actorPrincipalId,
    actorType: input.actorType,
    initiatingPrincipalId: USER_A,
    tenantId: input.tenantId,
    workspaceId: input.tenantId === TENANT_A ? WORKSPACE_A : undefined,
    taskId: TASK,
    delegationId: input.delegationId,
    correlationId: input.correlationId ?? "corr-s2",
    action: input.action,
    decision: "deny",
    policyVersion: "s2-matrix-1",
    outcome: "failed",
    errorCode: input.errorCode,
  });
  expect(recorded.ok).toBe(true);
}

async function auditDelegationDecision(
  scenario: Scenario,
  decision: DelegatedActionDecision,
  tenantId: string,
): Promise<void> {
  const recorded = await recordAuditEvent(scenario.audit, {
    timestamp: NOW,
    type: "delegation.tool_authorization",
    actorPrincipalId: AGENT_A,
    actorType: "agent",
    initiatingPrincipalId: USER_A,
    tenantId,
    workspaceId: tenantId === TENANT_A ? WORKSPACE_A : undefined,
    taskId: TASK,
    delegationId: scenario.delegation.id,
    correlationId: "corr-s2",
    action: `delegated:${SCREEN_PERMISSION}`,
    decision: decision.decision,
    policyVersion: decision.policyVersion,
    outcome: decision.decision === "allow" ? "succeeded" : "failed",
    errorCode: decision.decision === "deny" ? decision.reason : undefined,
  });
  expect(recorded.ok).toBe(true);
}

/** The chain must verify, and the cell's decisions must all be on it. */
async function expectChain(
  scenario: Scenario,
  expected: Array<{ decision: "allow" | "deny"; errorCode?: string }>,
): Promise<void> {
  const events = await scenario.audit.list();
  expect(await verifyChain(events)).toBe(true);
  expect(events.map((e) => e.decision)).toEqual(
    expected.map((e) => e.decision),
  );
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].errorCode !== undefined) {
      expect(events[i].errorCode).toBe(expected[i].errorCode);
    }
    // Delegation attribution: every cell decision attributes back
    // to the initiating principal, never to a shared identity.
    expect(events[i].initiatingPrincipalId).toBe(USER_A);
  }
}

// ---------------------------------------------------------------------------
// The §10 positive cell
// ---------------------------------------------------------------------------

describe("S2 positive cell (#1069 §10, #1422)", () => {
  it("runs the full path: resolve → carry → revalidate → narrow → delegated tool authorization, all audited", async () => {
    const scenario = createScenario();
    const s = await scenario;

    // API boundary: resolve from the authenticated principal.
    const resolved = await resolveExecutionContext(
      s.authority,
      baseResolveInput(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await auditResolution(s, resolved);
    const context = resolved.context;
    expect(context.tenantId).toBe(TENANT_A);
    expect(context.workspaceId).toBe(WORKSPACE_A);
    expect(context.principalId).toBe(USER_A);
    expect(context.initiatingPrincipalId).toBe(USER_A);
    expect(context.serviceId).toBe(SERVICE);
    expect(context.connectionId).toBe(CONNECTION_A);
    expect(context.externalAccountId).toBe(ACCOUNT_A);
    expect(context.environment).toBe("sandbox");
    expect(context.entitlementReference).toBe(ENTITLEMENT);
    expect(context.approvalReference).toBe(APPROVAL);
    expect(context.correlationId).toBe("corr-s2");

    // Durable-task boundary: the context crosses as data only.
    const carried = parseExecutionContext(serializeExecutionContext(context));
    expect(carried).toEqual(context);
    if (!carried) return;

    // Agent boundary: revalidate against current authority, then
    // narrow for the agent run under the Slice 4 delegation.
    // Narrowing changes neither the principal nor the initiator:
    // the agent acts as the delegation, not as a new identity.
    const revalidated = await revalidateExecutionContext(
      s.authority,
      carried,
      SCREEN_PERMISSION,
      NOW,
    );
    expect(revalidated.ok).toBe(true);

    const child = narrowExecutionContext(carried, {
      agentRunId: "run-s2-1",
      delegationId: s.delegation.id,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.context.tenantId).toBe(TENANT_A);
    expect(child.context.initiatingPrincipalId).toBe(USER_A);
    expect(child.context.correlationId).toBe("corr-s2");
    expect(child.context.connectionId).toBe(CONNECTION_A);
    expect(child.context.externalAccountId).toBe(ACCOUNT_A);
    expect(child.context.entitlementReference).toBe(ENTITLEMENT);
    expect(child.context.environment).toBe("sandbox");

    // Tool boundary: the delegated action is authorized against
    // the child context's tenant and delegation, within budget.
    const tool = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: child.context.tenantId,
      permission: SCREEN_PERMISSION,
      nowMs: NOW,
    });
    expect(tool.decision).toBe("allow");
    expect(tool.delegation.usedActions).toBe(1);
    await auditDelegationDecision(s, tool, TENANT_A);

    await expectChain(s, [{ decision: "allow" }, { decision: "allow" }]);
  });

  it("keeps the fixture's distinct roles honest: Tenant A admin holds admin grants, Tenant B member holds none in Tenant A", async () => {
    const s = await createScenario();
    expect(
      (
        await authorize(s.memberships, {
          actorInternalUserId: ADMIN_A,
          tenantId: TENANT_A,
          permission: "membership:invite",
          nowMs: NOW,
        })
      ).decision,
    ).toBe("allow");
    const cross = await authorize(s.memberships, {
      actorInternalUserId: USER_B,
      tenantId: TENANT_A,
      permission: SCREEN_PERMISSION,
      nowMs: NOW,
    });
    expect(cross.decision).toBe("deny");
    expect(cross.reason).toBe("CROSS_TENANT");
  });
});

// ---------------------------------------------------------------------------
// §10 negative cells
// ---------------------------------------------------------------------------

describe("S2 negative cells (#1069 §10, #1422)", () => {
  it("cross-tenant access: resolving in Tenant B denies PDP_DENIED/CROSS_TENANT and is audited (no context, no tool call)", async () => {
    const s = await createScenario();
    const denied = await resolveExecutionContext(
      s.authority,
      baseResolveInput({ tenantId: TENANT_B }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("PDP_DENIED");
    expect(denied.pdpReason).toBe("CROSS_TENANT");
    await auditResolution(s, denied);
    // No allow event anywhere: the cell did not pass by doing nothing.
    await expectChain(s, [{ decision: "deny", errorCode: "PDP_DENIED" }]);
  });

  it("cross-tenant access: a delegated tool call naming Tenant B denies CROSS_TENANT and is audited", async () => {
    const s = await createScenario();
    const context = await resolvePositive(s);
    const child = narrowExecutionContext(context, {
      agentRunId: "run-s2-cross",
      delegationId: s.delegation.id,
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const tool = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: TENANT_B,
      permission: SCREEN_PERMISSION,
      nowMs: NOW,
    });
    expect(tool.decision).toBe("deny");
    expect(tool.reason).toBe("CROSS_TENANT");
    expect(tool.delegation.usedActions).toBe(0);
    await auditDelegationDecision(s, tool, TENANT_B);
    await expectChain(s, [{ decision: "deny", errorCode: "CROSS_TENANT" }]);
  });

  it("cross-tenant access: a tenant swapped in transit denies at revalidation PDP_DENIED/CROSS_TENANT and is audited", async () => {
    const s = await createScenario();
    const context = await resolvePositive(s);
    const tampered: ExecutionContext = { ...context, tenantId: TENANT_B };
    const check = await revalidateExecutionContext(
      s.authority,
      tampered,
      SCREEN_PERMISSION,
      NOW,
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("PDP_DENIED");
    expect(check.pdpReason).toBe("CROSS_TENANT");
    await auditDenial(s, {
      actorPrincipalId: USER_A,
      actorType: "human",
      tenantId: TENANT_B,
      action: "execution-context:revalidate",
      errorCode: "PDP_DENIED",
    });
    await expectChain(s, [{ decision: "deny", errorCode: "PDP_DENIED" }]);
  });

  it("sandbox→live switch: narrowing a sandbox context to live denies ENVIRONMENT_ESCALATION and is audited", async () => {
    const s = await createScenario();
    const context = await resolvePositive(s);
    const escalated = narrowExecutionContext(context, { environment: "live" });
    expect(escalated.ok).toBe(false);
    if (escalated.ok) return;
    expect(escalated.code).toBe("ENVIRONMENT_ESCALATION");
    await auditDenial(s, {
      actorPrincipalId: USER_A,
      actorType: "human",
      tenantId: TENANT_A,
      action: "execution-context:narrow",
      errorCode: "ENVIRONMENT_ESCALATION",
      delegationId: s.delegation.id,
    });
    await expectChain(s, [
      { decision: "deny", errorCode: "ENVIRONMENT_ESCALATION" },
    ]);
  });

  it("sandbox→live switch: resolving live without an approval reference denies APPROVAL_REQUIRED; live with approval resolves (the denial is approval-gated, not live-gated)", async () => {
    const s = await createScenario();
    const denied = await resolveExecutionContext(
      s.authority,
      baseResolveInput({ environment: "live", approvalReference: undefined }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("APPROVAL_REQUIRED");
    await auditResolution(s, denied);

    const allowed = await resolveExecutionContext(
      s.authority,
      baseResolveInput({ environment: "live" }),
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.context.environment).toBe("live");
    await auditResolution(s, allowed);
    await expectChain(s, [
      { decision: "deny", errorCode: "APPROVAL_REQUIRED" },
      { decision: "allow" },
    ]);
  });

  it("approval bypass: a consequential resolution without an approval reference denies APPROVAL_REQUIRED and is audited", async () => {
    const s = await createScenario();
    const denied = await resolveExecutionContext(
      s.authority,
      baseResolveInput({ approvalReference: undefined }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("APPROVAL_REQUIRED");
    await auditResolution(s, denied);
    await expectChain(s, [
      { decision: "deny", errorCode: "APPROVAL_REQUIRED" },
    ]);
  });

  it("approval bypass: a delegated tool call with an invalid approval denies APPROVAL_INVALID and consumes no budget", async () => {
    const s = await createScenario();
    const tool = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: TENANT_A,
      permission: SCREEN_PERMISSION,
      approvalValid: false,
      nowMs: NOW,
    });
    expect(tool.decision).toBe("deny");
    expect(tool.reason).toBe("APPROVAL_INVALID");
    expect(tool.delegation.usedActions).toBe(0);
    await auditDelegationDecision(s, tool, TENANT_A);
    await expectChain(s, [{ decision: "deny", errorCode: "APPROVAL_INVALID" }]);
  });
});

// ---------------------------------------------------------------------------
// Adjacent cells the scenario implies
// ---------------------------------------------------------------------------

describe("S2 adjacent cells (#1422)", () => {
  it("budget/entitlement: an exhausted delegation budget denies BUDGET_EXHAUSTED on the second use, and a parent's entitlement reference cannot be replaced by narrowing", async () => {
    const s = await createScenario({ delegationBudget: 1 });
    const first = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: TENANT_A,
      permission: SCREEN_PERMISSION,
      nowMs: NOW,
    });
    expect(first.decision).toBe("allow");
    await auditDelegationDecision(s, first, TENANT_A);

    const exhausted = authorizeDelegatedAction(first.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: TENANT_A,
      permission: SCREEN_PERMISSION,
      nowMs: NOW,
    });
    expect(exhausted.decision).toBe("deny");
    expect(exhausted.reason).toBe("BUDGET_EXHAUSTED");
    expect(exhausted.delegation.usedActions).toBe(1);
    await auditDelegationDecision(s, exhausted, TENANT_A);

    const context = await resolvePositive(s);
    const replaced = narrowExecutionContext(context, {
      entitlementReference: "ent-premium-other",
    });
    expect(replaced.ok).toBe(false);
    if (replaced.ok) return;
    expect(replaced.code).toBe("REFERENCE_CHANGE");
    await auditDenial(s, {
      actorPrincipalId: USER_A,
      actorType: "human",
      tenantId: TENANT_A,
      action: "execution-context:narrow",
      errorCode: "REFERENCE_CHANGE",
    });
    await expectChain(s, [
      { decision: "allow" },
      { decision: "deny", errorCode: "BUDGET_EXHAUSTED" },
      { decision: "deny", errorCode: "REFERENCE_CHANGE" },
    ]);
  });

  it("revoked membership mid-flight: a context resolved before revocation denies at revalidation PDP_DENIED/MEMBERSHIP_REVOKED, after its allow event", async () => {
    const s = await createScenario();
    const resolved = await resolveExecutionContext(
      s.authority,
      baseResolveInput(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    await auditResolution(s, resolved);
    const carried = parseExecutionContext(
      serializeExecutionContext(resolved.context),
    );
    if (!carried) throw new Error("carry failed");

    const memberships = await s.memberships.getMembershipsByUser(USER_A);
    expect(memberships).toHaveLength(1);
    await s.memberships.revokeMembership(memberships[0].membershipId, NOW);

    const check = await revalidateExecutionContext(
      s.authority,
      carried,
      SCREEN_PERMISSION,
      NOW,
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.code).toBe("PDP_DENIED");
    expect(check.pdpReason).toBe("MEMBERSHIP_REVOKED");
    await auditDenial(s, {
      actorPrincipalId: USER_A,
      actorType: "human",
      tenantId: TENANT_A,
      action: "execution-context:revalidate",
      errorCode: "PDP_DENIED",
    });
    // The chain shows the sequence: allow, then deny after revocation.
    await expectChain(s, [
      { decision: "allow" },
      { decision: "deny", errorCode: "PDP_DENIED" },
    ]);
  });

  it("expired delegation: a tool call after expiry denies DELEGATION_EXPIRED and is audited; the same delegation rechecks valid before expiry", async () => {
    const s = await createScenario({ delegationExpiryMs: NOW + 1_000 });
    expect(recheckDelegation(s.delegation, NOW)).toEqual({
      valid: true,
      reason: "VALID",
    });
    const tool = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: TENANT_A,
      permission: SCREEN_PERMISSION,
      nowMs: NOW + 2_000,
    });
    expect(tool.decision).toBe("deny");
    expect(tool.reason).toBe("DELEGATION_EXPIRED");
    expect(tool.delegation.usedActions).toBe(0);
    await auditDelegationDecision(s, tool, TENANT_A);
    await expectChain(s, [
      { decision: "deny", errorCode: "DELEGATION_EXPIRED" },
    ]);
  });

  it("unbound connection: an unbound connection and a bound connection with the wrong external account both deny CONNECTION_NOT_BOUND; the bound pair resolves", async () => {
    const s = await createScenario();
    const unbound = await resolveExecutionContext(
      s.authority,
      baseResolveInput({ connectionId: "conn-unbound" }),
    );
    expect(unbound.ok).toBe(false);
    if (!unbound.ok) expect(unbound.code).toBe("CONNECTION_NOT_BOUND");
    await auditResolution(s, unbound);

    const wrongAccount = await resolveExecutionContext(
      s.authority,
      baseResolveInput({ externalAccountId: "acct-other" }),
    );
    expect(wrongAccount.ok).toBe(false);
    if (!wrongAccount.ok) {
      expect(wrongAccount.code).toBe("CONNECTION_NOT_BOUND");
    }
    await auditResolution(s, wrongAccount);

    const bound = await resolveExecutionContext(
      s.authority,
      baseResolveInput(),
    );
    expect(bound.ok).toBe(true);
    await auditResolution(s, bound);
    await expectChain(s, [
      { decision: "deny", errorCode: "CONNECTION_NOT_BOUND" },
      { decision: "deny", errorCode: "CONNECTION_NOT_BOUND" },
      { decision: "allow" },
    ]);
  });

  it("delegation scope: a tool call by the wrong agent denies DELEGATE_MISMATCH and a non-delegated action denies ACTION_NOT_DELEGATED, neither consuming budget", async () => {
    const s = await createScenario();
    const wrongAgent = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: "agent-other",
      tenantId: TENANT_A,
      permission: SCREEN_PERMISSION,
      nowMs: NOW,
    });
    expect(wrongAgent.decision).toBe("deny");
    expect(wrongAgent.reason).toBe("DELEGATE_MISMATCH");
    await auditDelegationDecision(s, wrongAgent, TENANT_A);

    const wrongAction = authorizeDelegatedAction(s.delegation, {
      delegateAgentId: AGENT_A,
      tenantId: TENANT_A,
      permission: "action:execute",
      nowMs: NOW,
    });
    expect(wrongAction.decision).toBe("deny");
    expect(wrongAction.reason).toBe("ACTION_NOT_DELEGATED");
    await auditDelegationDecision(s, wrongAction, TENANT_A);
    await expectChain(s, [
      { decision: "deny", errorCode: "DELEGATE_MISMATCH" },
      { decision: "deny", errorCode: "ACTION_NOT_DELEGATED" },
    ]);
  });
});
