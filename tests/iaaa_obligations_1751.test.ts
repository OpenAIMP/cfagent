/**
 * #1751 (parent #1717, IAAA-3): obligation/advice channel, with
 * proving tests.
 *
 * Before this slice, authz.md §10 recorded obligations/advice as
 * partial equivalents only: audit-on-decision was a record, not a
 * condition, and step-up was enforced ad hoc at each gate, not
 * declared as an obligation attached to a policy. The PDP returned
 * allow/deny and everything else was the caller's job.
 *
 * This file pins the replacement channel (src/security/obligations.ts)
 * AND proves it against the real PDP — declare, then enforce — with
 * no weaker substitute:
 *
 * - Obligations attach to POLICY (the frozen OBLIGATION_POLICY table,
 *   keyed by permission), not to per-gate ad-hoc code. A permission
 *   with no table entry behaves exactly as the PDP alone decides.
 * - Step-up-as-obligation: role:assign allows only with fresh
 *   authentication (the real requiresStepUp rule: fresh means
 *   authTimeMs finite, not in the future, and younger than the
 *   15-minute platform default; exactly at the window is stale).
 *   A missing authTimeMs fails closed, never skips the obligation.
 * - Audit-as-condition: role:assign, membership:revoke, and
 *   audit:export allow only after the injected audit writer
 *   records the decision. A missing writer, a false return, or a
 *   throwing writer all deny (fail closed) — the allow is never
 *   returned unaudited.
 * - Advice delivery: policy-declared advice accompanies BOTH allow
 *   and deny decisions for table entries (advice never changes a
 *   decision — it is information, not enforcement), and is empty
 *   for permissions with no entry.
 * - Fail-closed on ambiguity: obligations are evaluated in table
 *   order and short-circuit on the first failure, so a failed
 *   step-up never triggers an audit record for an action that will
 *   not happen; an unknown obligation kind (defensive branch) denies.
 *
 * The obligation table is frozen constants, not configuration: no
 * caller, session, run, or env value can widen, narrow, or disable
 * an obligation (security guard for this program — a
 * caller-configurable obligation would let a caller disable their
 * own enforcement). The step-up window itself is the platform
 * default, reused not settled (still an open CISO value, #1757).
 *
 * Written FIRST (TDD Red): these tests fail on the pre-change tree,
 * which has no src/security/obligations.ts module at all. Live route
 * adoption is a separate CTO-lane #945 wiring step (see authz.md
 * §10): this module is the PEP-side enforcement function, proved
 * here against the real PDP seam; routes keep their current gates
 * until that wiring lands, and no existing gate is removed by this
 * slice.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryMembershipStore,
  createMembership,
  type MembershipStore,
} from "../src/security/authorization";
import { checkPermission } from "../src/security/iaaaPdpSeam";
import {
  adviceFor,
  evaluateWithObligations,
  OBLIGATION_POLICY,
  OBLIGATION_POLICY_BY_PERMISSION,
  obligationsFor,
  type ObligationAuditEvent,
} from "../src/security/obligations";
import { DEFAULT_STEP_UP_FRESHNESS_MS } from "../src/security/sessionPolicy";

const NOW = 1_800_000_000_000;
const TENANT = "primary";

async function tenantAdminStore(): Promise<MembershipStore> {
  const store = createMemoryMembershipStore();
  const created = await createMembership(store, {
    internalUserId: "v1:admin",
    tenantId: TENANT,
    roleBindings: [
      { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    nowMs: NOW,
  });
  if (!created.ok) throw new Error("fixture membership failed");
  return store;
}

async function memberStore(): Promise<MembershipStore> {
  const store = createMemoryMembershipStore();
  const created = await createMembership(store, {
    internalUserId: "v1:member",
    tenantId: TENANT,
    roleBindings: [
      { role: "member", scope: "tenant", grantedBy: "system:bootstrap" },
    ],
    createdBy: "system:bootstrap",
    nowMs: NOW,
  });
  if (!created.ok) throw new Error("fixture membership failed");
  return store;
}

function recordingWriter() {
  const events: ObligationAuditEvent[] = [];
  return {
    events,
    writer: async (event: ObligationAuditEvent): Promise<boolean> => {
      events.push(event);
      return true;
    },
  };
}

describe("obligation policy table (#1751)", () => {
  it("is frozen and covers exactly role:assign, membership:revoke, audit:export", () => {
    expect(Object.isFrozen(OBLIGATION_POLICY)).toBe(true);
    expect(OBLIGATION_POLICY.map((e) => e.permission).sort()).toEqual([
      "audit:export",
      "membership:revoke",
      "role:assign",
    ]);
    for (const entry of OBLIGATION_POLICY) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.obligations)).toBe(true);
      expect(Object.isFrozen(entry.advice)).toBe(true);
    }
    expect(Object.isFrozen(OBLIGATION_POLICY_BY_PERMISSION)).toBe(true);
  });

  it("declares step-up plus audit-before-allow for role:assign, audit-only for the other two", () => {
    expect(obligationsFor("role:assign")).toEqual([
      "step-up",
      "audit-before-allow",
    ]);
    expect(obligationsFor("membership:revoke")).toEqual([
      "audit-before-allow",
    ]);
    expect(obligationsFor("audit:export")).toEqual(["audit-before-allow"]);
  });

  it("declares no obligations and no advice for permissions with no entry", () => {
    expect(obligationsFor("task:read")).toEqual([]);
    expect(adviceFor("task:read")).toEqual([]);
    expect(adviceFor("integration:connect")).toEqual([]);
  });

  it("declares audit-notice advice for every table entry", () => {
    for (const permission of [
      "role:assign",
      "membership:revoke",
      "audit:export",
    ] as const) {
      const advice = adviceFor(permission);
      expect(advice.length).toBeGreaterThan(0);
      expect(advice.every((a) => a.kind === "audit-notice")).toBe(true);
    }
  });

  it("reuses the platform step-up default (15 minutes), not an invented window", () => {
    expect(DEFAULT_STEP_UP_FRESHNESS_MS).toBe(15 * 60 * 1000);
  });
});

describe("step-up-as-obligation (#1751)", () => {
  it("allows role:assign with fresh authentication after the audit writer records", async () => {
    const store = await tenantAdminStore();
    const { events, writer } = recordingWriter();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW,
      audit: writer,
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("ALLOW");
    expect(result.obligations).toEqual([
      expect.objectContaining({ kind: "step-up", satisfied: true }),
      expect.objectContaining({ kind: "audit-before-allow", satisfied: true }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      permission: "role:assign",
      principalId: "v1:admin",
      tenantId: TENANT,
      decision: "allow",
      nowMs: NOW,
    });
  });

  it("denies role:assign at exactly the step-up freshness boundary (stale, real rule)", async () => {
    const store = await tenantAdminStore();
    const { events, writer } = recordingWriter();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW - DEFAULT_STEP_UP_FRESHNESS_MS,
      audit: writer,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
    expect(result.obligations).toEqual([
      expect.objectContaining({ kind: "step-up", satisfied: false }),
    ]);
    // Short-circuit: a failed step-up never audits an action that will not happen.
    expect(events).toHaveLength(0);
  });

  it("denies role:assign one millisecond inside the window is fresh, stale beyond it", async () => {
    const store = await tenantAdminStore();
    const fresh = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW - DEFAULT_STEP_UP_FRESHNESS_MS + 1,
      audit: async () => true,
    });
    expect(fresh.decision).toBe("allow");
    const stale = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW - DEFAULT_STEP_UP_FRESHNESS_MS - 60_000,
      audit: async () => true,
    });
    expect(stale.decision).toBe("deny");
    expect(stale.reason).toBe("OBLIGATION_FAILED");
  });

  it("fails closed when authTimeMs is missing (obligation never skipped)", async () => {
    const store = await tenantAdminStore();
    const { events, writer } = recordingWriter();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      audit: writer,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
    expect(events).toHaveLength(0);
  });

  it("fails closed on a future authTimeMs", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW + 60_000,
      audit: async () => true,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
  });
});

describe("audit-as-condition (#1751)", () => {
  it("allows membership:revoke only after the audit writer records (no step-up on this permission)", async () => {
    const store = await tenantAdminStore();
    const { events, writer } = recordingWriter();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "membership:revoke",
      nowMs: NOW,
      audit: writer,
    });
    expect(result.decision).toBe("allow");
    expect(result.obligations).toEqual([
      expect.objectContaining({ kind: "audit-before-allow", satisfied: true }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].permission).toBe("membership:revoke");
  });

  it("allows audit:export only after the audit writer records", async () => {
    const store = await tenantAdminStore();
    const { events, writer } = recordingWriter();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "audit:export",
      nowMs: NOW,
      audit: writer,
    });
    expect(result.decision).toBe("allow");
    expect(events).toHaveLength(1);
    expect(events[0].permission).toBe("audit:export");
  });

  it("denies when no audit writer is supplied (fail closed, never allow unaudited)", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "audit:export",
      nowMs: NOW,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
    expect(result.obligations).toEqual([
      expect.objectContaining({
        kind: "audit-before-allow",
        satisfied: false,
      }),
    ]);
  });

  it("denies when the audit writer returns false", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "membership:revoke",
      nowMs: NOW,
      audit: async () => false,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
  });

  it("denies when the audit writer throws (fail closed on channel failure)", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "membership:revoke",
      nowMs: NOW,
      audit: async () => {
        throw new Error("audit store down");
      },
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
  });
});

describe("advice channel (#1751)", () => {
  it("delivers policy advice with an allow decision", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "audit:export",
      nowMs: NOW,
      audit: async () => true,
    });
    expect(result.decision).toBe("allow");
    expect(result.advice.length).toBeGreaterThan(0);
    expect(result.advice[0].kind).toBe("audit-notice");
  });

  it("delivers policy advice with a PDP deny too (advice never changes the decision)", async () => {
    const store = await memberStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:member",
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
      authTimeMs: NOW,
      audit: async () => true,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("NO_GRANT");
    expect(result.obligations).toEqual([]);
    expect(result.advice.length).toBeGreaterThan(0);
  });

  it("delivers policy advice with an obligation-failed deny", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "audit:export",
      nowMs: NOW,
      audit: async () => false,
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("OBLIGATION_FAILED");
    expect(result.advice.length).toBeGreaterThan(0);
  });
});

describe("PDP passthrough (#1751)", () => {
  it("returns the PDP decision unchanged for permissions with no policy entry", async () => {
    const store = await tenantAdminStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "task:read",
      nowMs: NOW,
    });
    const pdp = await checkPermission(store, {
      internalUserId: "v1:admin",
      tenantId: TENANT,
      permission: "task:read",
      nowMs: NOW,
    });
    expect(result.decision).toBe(pdp.decision);
    expect(result.reason).toBe(pdp.reason);
    expect(result.obligations).toEqual([]);
    expect(result.advice).toEqual([]);
  });

  it("returns the PDP deny unchanged (with its reason) for an unprivileged caller", async () => {
    const store = await memberStore();
    const result = await evaluateWithObligations(store, {
      internalUserId: "v1:member",
      tenantId: TENANT,
      permission: "task:read",
      nowMs: NOW,
    });
    expect(result.decision).toBe("allow");
    const denied = await evaluateWithObligations(store, {
      internalUserId: "v1:member",
      tenantId: TENANT,
      permission: "audit:export",
      nowMs: NOW,
      audit: async () => true,
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("NO_GRANT");
    expect(denied.obligations).toEqual([]);
  });
});
