import { describe, it, expect } from "vitest";
import {
  createMemoryRevocationStore,
  sessionIsUsable,
  DEFAULT_SESSION_POLICY,
} from "../src/security/sessionPolicy";
import type { SessionState } from "../src/security/sessionPolicy";
import {
  createMemoryMembershipStore,
  createMembership,
  authorize,
} from "../src/security/authorization";
import {
  createMemoryDelegationStore,
  createDelegation,
  authorizeDelegatedAction,
  recheckDelegation,
} from "../src/security/delegation";
import {
  revokePrincipal,
  isPrincipalFullyRevoked,
  offboardPrincipal,
} from "../src/security/lifecycle";

/**
 * Issue #945, Slice 6 — lifecycle verification: revocation propagation
 * and offboarding.
 *
 * Spec §6 acceptance case: "Membership revocation affects sessions,
 * queued work, active tasks per contract". This tests the pure
 * propagation contract across the Slice 2 session store, the Slice 3
 * membership store, and the Slice 4 delegation store. It does NOT
 * touch any live session, route, job, or execution flow, and it
 * changes no production membership, delegation, or session. A
 * later slice wires these pure rules into live call sites.
 */

const NOW = 1_800_000_000_000;

async function setup() {
  const sessions = createMemoryRevocationStore();
  const memberships = createMemoryMembershipStore();
  const delegations = createMemoryDelegationStore();

  const membership = await createMembership(memberships, {
    internalUserId: "user-1",
    tenantId: "tenant-a",
    roleBindings: [
      { role: "tenant-admin", scope: "tenant", grantedBy: "platform-admin-1" },
    ],
    createdBy: "platform-admin-1",
    nowMs: NOW,
  });
  if (!membership.ok) throw new Error("expected membership ok");

  const session: SessionState = {
    sessionId: "session-1",
    internalUserId: "user-1",
    createdAtMs: NOW,
    lastActivityMs: NOW,
    authTimeMs: NOW,
  };
  await sessions.registerSession("session-1", "user-1");

  const delegation = await createDelegation(memberships, delegations, {
    delegatorInternalUserId: "user-1",
    delegateAgentId: "agent-1",
    tenantId: "tenant-a",
    allowedActions: ["task:create"],
    resourceScope: [],
    expiresAtMs: NOW + 60_000,
    reDelegationAllowed: false,
    nowMs: NOW,
  });
  if (!delegation.ok) throw new Error("expected delegation ok");

  return { sessions, memberships, delegations, session, membership: membership.membership, delegation: delegation.delegation };
}

describe("iaaa revocation (#945 slice 6)", () => {
  it("revokes sessions, memberships, and delegations for a principal in one report", async () => {
    const s = await setup();
    const report = await revokePrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    expect(report.principalId).toBe("user-1");
    expect(report.sessionsRevoked).toEqual(["session-1"]);
    expect(report.membershipsRevoked).toEqual([s.membership.membershipId]);
    expect(report.delegationsRevoked).toEqual([s.delegation.id]);
    expect(report.failures).toEqual([]);
    expect(report.allRevoked).toBe(true);
  });

  it("makes a revoked principal's session unusable at the next check", async () => {
    const s = await setup();
    expect(
      (await sessionIsUsable(s.sessions, s.session, DEFAULT_SESSION_POLICY, NOW)).usable,
    ).toBe(true);
    await revokePrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    const after = await sessionIsUsable(s.sessions, s.session, DEFAULT_SESSION_POLICY, NOW);
    expect(after.usable).toBe(false);
    expect(after.reason).toBe("REVOKED");
  });

  it("makes a revoked principal's membership deny at the next PDP check", async () => {
    const s = await setup();
    expect(
      (await authorize(s.memberships, {
        actorInternalUserId: "user-1",
        tenantId: "tenant-a",
        permission: "task:create",
        nowMs: NOW,
      })).decision,
    ).toBe("allow");
    await revokePrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    const after = await authorize(s.memberships, {
      actorInternalUserId: "user-1",
      tenantId: "tenant-a",
      permission: "task:create",
      nowMs: NOW,
    });
    expect(after.decision).toBe("deny");
    expect(after.reason).toBe("MEMBERSHIP_REVOKED");
  });

  it("makes a revoked principal's delegation unusable at the next check", async () => {
    const s = await setup();
    await revokePrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    const stored = await s.delegations.get(s.delegation.id);
    if (!stored) throw new Error("expected delegation stored");
    expect(recheckDelegation(stored, NOW).valid).toBe(false);
    expect(
      authorizeDelegatedAction(stored, {
        delegateAgentId: "agent-1",
        tenantId: "tenant-a",
        permission: "task:create",
        nowMs: NOW,
      }).decision,
    ).toBe("deny");
  });

  it("reports a fully revoked principal as fully revoked, and a live one as not", async () => {
    const s = await setup();
    const before = await isPrincipalFullyRevoked(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"] },
    );
    expect(before.fullyRevoked).toBe(false);
    await revokePrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    const after = await isPrincipalFullyRevoked(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"] },
    );
    expect(after.fullyRevoked).toBe(true);
    expect(after.sessionsRevoked).toBe(true);
    expect(after.membershipsRevoked).toBe(true);
    expect(after.delegationsRevoked).toBe(true);
  });

  it("is idempotent: revoking twice does not double-count or fail", async () => {
    const s = await setup();
    const stores = { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations };
    const first = await revokePrincipal(stores, { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW });
    const second = await revokePrincipal(stores, { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW });
    expect(first.allRevoked).toBe(true);
    expect(second.allRevoked).toBe(true);
    expect(second.sessionsRevoked).toEqual([]);
    expect(second.membershipsRevoked).toEqual([]);
    expect(second.delegationsRevoked).toEqual([]);
    expect(second.failures).toEqual([]);
  });

  it("does not revoke another principal's sessions, memberships, or delegations", async () => {
    const s = await setup();
    await revokePrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-2", sessionIds: [], nowMs: NOW },
    );
    const after = await isPrincipalFullyRevoked(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"] },
    );
    expect(after.fullyRevoked).toBe(false);
    expect(
      (await sessionIsUsable(s.sessions, s.session, DEFAULT_SESSION_POLICY, NOW)).usable,
    ).toBe(true);
  });

  it("offboards a principal with a checklist covering sessions, memberships, and delegations", async () => {
    const s = await setup();
    const result = await offboardPrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    expect(result.offboarded).toBe(true);
    expect(result.report.allRevoked).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      "revoke-sessions",
      "revoke-memberships",
      "revoke-delegations",
    ]);
    expect(result.steps.every((step) => step.status === "done")).toBe(true);
    expect(result.unrevoked).toEqual([]);
  });

  it("offboarding a principal with nothing to revoke reports not-applicable, not success-by-silence", async () => {
    const s = await setup();
    const result = await offboardPrincipal(
      { sessions: s.sessions, memberships: s.memberships, delegations: s.delegations },
      { internalUserId: "user-2", sessionIds: [], nowMs: NOW },
    );
    expect(result.offboarded).toBe(true);
    expect(result.steps.every((step) => step.status === "not-applicable")).toBe(true);
    expect(result.unrevoked).toEqual([]);
  });

  it("offboarding reports anything it could not revoke instead of silently dropping it", async () => {
    const s = await setup();
    // A membership store that refuses one revocation, surfacing the failure.
    const failingMemberships = {
      ...s.memberships,
      revokeMembership: async () => false,
    };
    const result = await offboardPrincipal(
      { sessions: s.sessions, memberships: failingMemberships, delegations: s.delegations },
      { internalUserId: "user-1", sessionIds: ["session-1"], nowMs: NOW },
    );
    expect(result.offboarded).toBe(false);
    expect(result.unrevoked.length).toBeGreaterThan(0);
    expect(result.unrevoked[0].kind).toBe("membership");
    expect(result.steps.find((step) => step.step === "revoke-memberships")?.status).toBe("failed");
    // Sessions and delegations were still revoked even though one step failed.
    expect(result.report.sessionsRevoked).toEqual(["session-1"]);
    expect(result.report.delegationsRevoked).toEqual([s.delegation.id]);
  });
});
