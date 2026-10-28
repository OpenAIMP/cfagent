/**
 * Issue #1758 (#1717 lifecycle wiring) — TDD Red-first.
 *
 * Pure wiring tests (no Worker, no DO): the session registry, the
 * bulk-revocation rule (a principal's sessions are revoked even
 * though the caller never pre-listed them), and the offboard+
 * verify checklist (sessions, memberships, delegations, API keys,
 * E*TRADE tokens, mail suppression, audit).
 *
 * The route-level tests live in tests/iaaa_lifecycle_routes_1758.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createMembership,
  createMemoryMembershipStore,
} from "../src/security/authorization";
import {
  createMemoryDelegationStore,
  type Delegation,
} from "../src/security/delegation";
import {
  parseSessionRegistryEntry,
  sessionsForPrincipal,
} from "../src/security/iaaaSessionRegistry";
import {
  isMailSuppressed,
  runOffboard,
  setMailSuppression,
  type OffboardAuditPort,
  type OffboardDeps,
} from "../src/security/iaaaLifecycleWiring";
import type { KvLike } from "../src/security/kvResilience";

const NOW = 1_792_660_000_000;
const TARGET = "v1:target00000000000000000000000000000000000000000000001";
const ACTOR = "v1:admin000000000000000000000000000000000000000000000001";
const OTHER = "v1:other00000000000000000000000000000000000000000000001";

interface FakeSession {
  internalUserId?: string;
  githubLogin: string;
}

function makeSessionPort(seed: Record<string, FakeSession>) {
  const map = new Map<string, FakeSession>(Object.entries(seed));
  return {
    map,
    async list() {
      return [...map.entries()].map(([sessionId, s]) => ({
        sessionId,
        internalUserId: s.internalUserId,
        githubLogin: s.githubLogin,
      }));
    },
    async delete(sessionId: string) {
      map.delete(sessionId);
    },
  };
}

function makeKeyPort(seed: Record<string, string[]>) {
  const map = new Map<string, string[]>(Object.entries(seed).map(([k, v]) => [k, [...v]]));
  return {
    map,
    async list(login: string) {
      return [...(map.get(login) ?? [])];
    },
    async revoke(login: string, keyId: string) {
      const ids = map.get(login) ?? [];
      if (!ids.includes(keyId)) return false;
      map.set(login, ids.filter((id) => id !== keyId));
      return true;
    },
  };
}

function makeEtradePort(seedLogins: string[]) {
  const present = new Set(seedLogins);
  return {
    present,
    revoked: [] as string[],
    async revoke(login: string) {
      this.revoked.push(login);
      present.delete(login);
    },
    async hasTokens(login: string) {
      return present.has(login);
    },
  };
}

function makeSuppressionPort() {
  const set = new Set<string>();
  return {
    async set(userId: string) {
      set.add(userId);
    },
    async isSet(userId: string) {
      return set.has(userId);
    },
  };
}

function makeMemoryKv(): KvLike {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

describe("session registry (#1758 F-16)", () => {
  it("parses a live session record and skips non-session keys and corrupt values", () => {
    const entry = parseSessionRegistryEntry(
      "0d9a3120-1c2b-4e3f-8a5b-312000000001",
      JSON.stringify({ githubLogin: "target-user", internalUserId: TARGET, createdAt: NOW }),
    );
    expect(entry).toEqual({
      sessionId: "0d9a3120-1c2b-4e3f-8a5b-312000000001",
      internalUserId: TARGET,
      githubLogin: "target-user",
    });
    // Membership/audit/binding keys share the sessions namespace but are not sessions.
    expect(parseSessionRegistryEntry("iaaa-membership:abc", "{}")).toBeNull();
    expect(parseSessionRegistryEntry("iaaa-audit:events", "[]")).toBeNull();
    // Corrupt session bytes are skipped, never mistaken for a session.
    expect(
      parseSessionRegistryEntry("0d9a3120-1c2b-4e3f-8a5b-312000000002", "not-json"),
    ).toBeNull();
    expect(
      parseSessionRegistryEntry("0d9a3120-1c2b-4e3f-8a5b-312000000003", JSON.stringify({})),
    ).toBeNull();
  });

  it("sessionsForPrincipal returns exactly the principal's wired sessions", () => {
    const entries = [
      { sessionId: "s-1", internalUserId: TARGET, githubLogin: "target-user" },
      { sessionId: "s-2", internalUserId: OTHER, githubLogin: "other-user" },
      { sessionId: "s-3", githubLogin: "legacy-user" },
    ];
    expect(sessionsForPrincipal(entries, TARGET).map((e) => e.sessionId)).toEqual(["s-1"]);
  });
});

async function makeDeps(overrides: Partial<OffboardDeps> = {}): Promise<{
  deps: OffboardDeps;
  sessions: ReturnType<typeof makeSessionPort>;
  keys: ReturnType<typeof makeKeyPort>;
  etrade: ReturnType<typeof makeEtradePort>;
  suppression: ReturnType<typeof makeSuppressionPort>;
  auditEvents: Array<{ action: string }>;
}> {
  const memberships = createMemoryMembershipStore();
  await createMembership(memberships, {
    internalUserId: TARGET,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: NOW,
  });
  await createMembership(memberships, {
    internalUserId: OTHER,
    tenantId: "primary",
    roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
    createdBy: "test-seed",
    nowMs: NOW,
  });
  const delegations = createMemoryDelegationStore();
  const delegation: Delegation = {
    id: "del-1",
    delegatorInternalUserId: TARGET,
    delegateAgentId: "agent-1",
    tenantId: "primary",
    allowedActions: ["task:read"],
    resourceScope: [],
    expiresAtMs: NOW + 3_600_000,
    usedActions: 0,
    reDelegationAllowed: false,
    revoked: false,
    createdAtMs: NOW,
  };
  await delegations.put(delegation);

  const sessions = makeSessionPort({
    "0d9a3120-1c2b-4e3f-8a5b-312000000001": { internalUserId: TARGET, githubLogin: "target-user" },
    "0d9a3120-1c2b-4e3f-8a5b-312000000002": { internalUserId: TARGET, githubLogin: "target-user" },
    // Legacy session for the same login, no internalUserId: the registry
    // must still find it through the login the wired sessions reveal.
    "0d9a3120-1c2b-4e3f-8a5b-312000000003": { githubLogin: "target-user" },
    "0d9a3120-1c2b-4e3f-8a5b-312000000004": { internalUserId: OTHER, githubLogin: "other-user" },
  });
  const keys = makeKeyPort({ "target-user": ["key-1", "key-2"], "other-user": ["key-9"] });
  const etrade = makeEtradePort(["target-user"]);
  const suppression = makeSuppressionPort();
  const auditEvents: Array<{ action: string }> = [];
  const audit: OffboardAuditPort = {
    async emit(input) {
      auditEvents.push({ action: input.action });
      return true;
    },
  };
  const deps: OffboardDeps = {
    sessions,
    memberships,
    delegations,
    apiKeys: keys,
    etrade,
    suppression,
    audit,
    ...overrides,
  };
  return { deps, sessions, keys, etrade, suppression, auditEvents };
}

describe("offboard + verify (#1758 F-15/F-16/F-17)", () => {
  it("bulk revocation revokes sessions the caller never pre-listed", async () => {
    const { deps, sessions } = await makeDeps();
    // The caller supplies NO session ids at all — the registry discovers them.
    const report = await runOffboard(deps, {
      internalUserId: TARGET,
      tenantId: "primary",
      nowMs: NOW,
      actorInternalUserId: ACTOR,
    });
    expect(report.offboarded).toBe(true);
    expect(report.verified).toBe(true);
    expect(report.sessionsRevoked).toHaveLength(3);
    expect(report.sessionsRevoked).toContain("0d9a3120-1c2b-4e3f-8a5b-312000000001");
    expect(report.sessionsRevoked).toContain("0d9a3120-1c2b-4e3f-8a5b-312000000003");
    // The other principal's session is untouched.
    expect([...sessions.map.keys()]).toEqual(["0d9a3120-1c2b-4e3f-8a5b-312000000004"]);
  });

  it("covers the full checklist end to end and re-reads the stores to verify", async () => {
    const { deps, keys, etrade, suppression, auditEvents } = await makeDeps();
    const report = await runOffboard(deps, {
      internalUserId: TARGET,
      tenantId: "primary",
      nowMs: NOW,
      actorInternalUserId: ACTOR,
    });
    expect(report.membershipsRevoked).toHaveLength(1);
    expect(report.delegationsRevoked).toEqual(["del-1"]);
    expect(report.apiKeysRevoked).toEqual(["key-1", "key-2"]);
    expect([...(keys.map.get("other-user") ?? [])]).toEqual(["key-9"]);
    expect(report.etradeLogins).toEqual(["target-user"]);
    expect(etrade.present.has("target-user")).toBe(false);
    expect(report.mailSuppressed).toBe(true);
    expect(await suppression.isSet(TARGET)).toBe(true);
    expect(report.auditEmitted).toBe(true);
    expect(auditEvents).toHaveLength(1);
    expect(report.verified).toBe(true);
    expect(report.residuals).toEqual([]);
    // A second offboard is a no-op success, not a failure.
    const again = await runOffboard(deps, {
      internalUserId: TARGET,
      tenantId: "primary",
      nowMs: NOW,
      actorInternalUserId: ACTOR,
    });
    expect(again.offboarded).toBe(true);
    expect(again.verified).toBe(true);
  });

  it("reports verify failure instead of claiming a revoked principal it cannot prove", async () => {
    const { deps, sessions } = await makeDeps();
    // A session that re-appears after revocation (issued after the
    // offboard) must make verification fail, not silently pass.
    const originalDelete = sessions.delete.bind(sessions);
    let deleted = false;
    sessions.delete = async (id: string) => {
      await originalDelete(id);
      if (!deleted) {
        deleted = true;
        sessions.map.set("0d9a3120-1c2b-4e3f-8a5b-312000000099", {
          internalUserId: TARGET,
          githubLogin: "target-user",
        });
      }
    };
    const report = await runOffboard(deps, {
      internalUserId: TARGET,
      tenantId: "primary",
      nowMs: NOW,
      actorInternalUserId: ACTOR,
    });
    expect(report.verified).toBe(false);
    expect(report.residuals.some((r) => r.includes("session"))).toBe(true);
  });

  it("names the missing durable delegation store instead of pretending delegations were checked", async () => {
    const { deps } = await makeDeps({ delegations: null });
    const report = await runOffboard(deps, {
      internalUserId: TARGET,
      tenantId: "primary",
      nowMs: NOW,
      actorInternalUserId: ACTOR,
    });
    expect(report.offboarded).toBe(true);
    expect(report.steps.find((s) => s.step === "revoke-delegations")?.status).toBe("not-applicable");
    expect(report.residuals.some((r) => r.includes("delegation"))).toBe(true);
  });

  it("mail suppression flag round-trips through a KvLike store", async () => {
    const kv = makeMemoryKv();
    expect(await isMailSuppressed(kv, TARGET)).toBe(false);
    await setMailSuppression(kv, TARGET, NOW);
    expect(await isMailSuppressed(kv, TARGET)).toBe(true);
    expect(await isMailSuppressed(kv, OTHER)).toBe(false);
  });
});
