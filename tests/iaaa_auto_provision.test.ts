/**
 * Issue #1274 — automatic provisioning + login-provider display.
 *
 * Unit coverage for the two new policy modules:
 * - ensureTenantMember (auto-member on first wired login, any provider)
 * - the durable access-request store (request access, admin decides)
 * - issuer → provider display lookup (registry-backed, never user input)
 *
 * The member permission boundary is pinned against the Slice 3 grants
 * as amended by #2450: member may create/read/cancel tasks,
 * read/edit/export artifacts, propose actions, and connect
 * integrations — and must NOT use or manage integrations.
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";
import type { KvLike } from "../src/security/kvResilience";
import { ensureTenantMember } from "../src/security/iaaaAutoProvision";
import {
  createAccessRequestStore,
  type AccessRequestStore,
} from "../src/security/iaaaAccessRequests";
import { getProviderByIssuer } from "../src/security/providers";

const NOW = 1_790_000_000_000;
const TENANT = "primary";

function memoryKv(): KvLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
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

describe("getProviderByIssuer (#1274 display)", () => {
  it("maps the GitHub issuer to GitHub", () => {
    const found = getProviderByIssuer("https://github.com");
    expect(found?.providerId).toBe("github");
    expect(found?.displayName).toBe("GitHub");
    expect(found?.issuer).toBe("https://github.com");
  });

  it("maps the Google issuer to Google", () => {
    const found = getProviderByIssuer("https://accounts.google.com");
    expect(found?.providerId).toBe("google");
    expect(found?.displayName).toBe("Google");
  });

  it("returns null for unknown or non-string issuers, never a guess", () => {
    expect(getProviderByIssuer("https://example.com")).toBeNull();
    expect(getProviderByIssuer("")).toBeNull();
    expect(getProviderByIssuer(undefined as unknown as string)).toBeNull();
  });
});

describe("ensureTenantMember (#1274 auto-member)", () => {
  it("grants member in primary to a fresh identity", async () => {
    const store = createMemoryMembershipStore();
    const result = await ensureTenantMember(store, {
      internalUserId: "v1:freshuser000000000000000000000000000000000000000000000000000001",
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(result.status).toBe("granted");
    const memberships = await store.getMembershipsByUser(
      "v1:freshuser000000000000000000000000000000000000000000000000000001",
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0].tenantId).toBe(TENANT);
    expect(memberships[0].roleBindings).toEqual([
      expect.objectContaining({ role: "member", scope: "tenant" }),
    ]);
  });

  it("member may propose, read artifacts, and connect integrations but must NOT use them or assign roles", async () => {
    const store = createMemoryMembershipStore();
    const userId = "v1:memberboundary00000000000000000000000000000000000000000000001";
    await ensureTenantMember(store, { internalUserId: userId, tenantId: TENANT, nowMs: NOW });
    const allowed = await authorize(store, {
      actorInternalUserId: userId,
      tenantId: TENANT,
      permission: "action:propose",
      nowMs: NOW,
    });
    expect(allowed.decision).toBe("allow");
    // #2450: the blanket member grant gives every member connect.
    const connected = await authorize(store, {
      actorInternalUserId: userId,
      tenantId: TENANT,
      permission: "integration:connect",
      nowMs: NOW,
    });
    expect(connected.decision).toBe("allow");
    // integration:use stays admin-held under #2450.
    const deniedUse = await authorize(store, {
      actorInternalUserId: userId,
      tenantId: TENANT,
      permission: "integration:use",
      nowMs: NOW,
    });
    expect(deniedUse.decision).toBe("deny");
    const deniedManage = await authorize(store, {
      actorInternalUserId: userId,
      tenantId: TENANT,
      permission: "role:assign",
      nowMs: NOW,
    });
    expect(deniedManage.decision).toBe("deny");
  });

  it("repeat login is a no-op: no duplicate, no downgrade", async () => {
    const store = createMemoryMembershipStore();
    const userId = "v1:repeatlogin000000000000000000000000000000000000000000000001";
    const first = await ensureTenantMember(store, { internalUserId: userId, tenantId: TENANT, nowMs: NOW });
    const second = await ensureTenantMember(store, { internalUserId: userId, tenantId: TENANT, nowMs: NOW + 1000 });
    expect(first.status).toBe("granted");
    expect(second.status).toBe("already-member");
    const memberships = await store.getMembershipsByUser(userId);
    expect(memberships).toHaveLength(1);
  });

  it("an existing tenant-admin is left alone (never downgraded, no member added)", async () => {
    const store = createMemoryMembershipStore();
    const userId = "v1:existingadmin0000000000000000000000000000000000000000000001";
    await createMembership(store, {
      internalUserId: userId,
      tenantId: TENANT,
      roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: NOW,
    });
    const result = await ensureTenantMember(store, { internalUserId: userId, tenantId: TENANT, nowMs: NOW });
    expect(result.status).toBe("already-member");
    const memberships = await store.getMembershipsByUser(userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].roleBindings[0].role).toBe("tenant-admin");
  });

  it("a membership in another tenant does not block a primary member grant", async () => {
    const store = createMemoryMembershipStore();
    const userId = "v1:othertenant00000000000000000000000000000000000000000000001";
    await createMembership(store, {
      internalUserId: userId,
      tenantId: "other-tenant",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: NOW,
    });
    const result = await ensureTenantMember(store, { internalUserId: userId, tenantId: TENANT, nowMs: NOW });
    expect(result.status).toBe("granted");
    const memberships = await store.getMembershipsByUser(userId);
    expect(memberships).toHaveLength(2);
  });

  it("a revoked-only membership does not block a fresh grant", async () => {
    const store = createMemoryMembershipStore();
    const userId = "v1:revokedonly00000000000000000000000000000000000000000000001";
    const created = await createMembership(store, {
      internalUserId: userId,
      tenantId: TENANT,
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "test-seed" }],
      createdBy: "test-seed",
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("seed failed");
    await store.revokeMembership(created.membership.membershipId, NOW);
    const result = await ensureTenantMember(store, { internalUserId: userId, tenantId: TENANT, nowMs: NOW });
    expect(result.status).toBe("granted");
  });

  it("a failing store reports error and never throws", async () => {
    const failing = {
      async getMembershipsByUser() {
        throw new Error("boom");
      },
      async put() {
        throw new Error("boom");
      },
      async revokeMembership() {
        return false;
      },
    };
    const result = await ensureTenantMember(failing, {
      internalUserId: "v1:failingstore00000000000000000000000000000000000000000001",
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(result.status).toBe("error");
  });

  it("empty user or tenant ids are errors, never writes", async () => {
    const store = createMemoryMembershipStore();
    expect(
      (await ensureTenantMember(store, { internalUserId: "  ", tenantId: TENANT, nowMs: NOW })).status,
    ).toBe("error");
    expect(
      (await ensureTenantMember(store, { internalUserId: "v1:x", tenantId: " ", nowMs: NOW })).status,
    ).toBe("error");
    expect(await store.getMembershipsByUser("v1:x")).toHaveLength(0);
  });
});

describe("access request store (#1274 request access)", () => {
  function setup(): AccessRequestStore {
    return createAccessRequestStore(memoryKv());
  }

  it("creates a pending tenant-admin request with requester and timestamps", async () => {
    const store = setup();
    const created = await store.create({
      requesterInternalUserId: "v1:requester000000000000000000000000000000000000000000000001",
      requestedRole: "tenant-admin",
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    expect(created.request.status).toBe("pending");
    expect(created.request.scope).toBe("tenant");
    expect(created.request.createdAtMs).toBe(NOW);
    expect(created.request.decidedBy).toBeUndefined();
  });

  it("a second pending request for the same role returns ALREADY_PENDING, no duplicate", async () => {
    const store = setup();
    const userId = "v1:dupe00000000000000000000000000000000000000000000000000001";
    const first = await store.create({ requesterInternalUserId: userId, requestedRole: "tenant-admin", tenantId: TENANT, nowMs: NOW });
    const second = await store.create({ requesterInternalUserId: userId, requestedRole: "tenant-admin", tenantId: TENANT, nowMs: NOW + 5 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected ALREADY_PENDING");
    expect(second.code).toBe("ALREADY_PENDING");
    expect(await store.list()).toHaveLength(1);
  });

  it("only tenant-admin may be requested in this cut", async () => {
    const store = setup();
    const result = await store.create({
      requesterInternalUserId: "v1:badrole0000000000000000000000000000000000000000000000001",
      requestedRole: "platform-admin",
      tenantId: TENANT,
      nowMs: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected INVALID_ROLE");
    expect(result.code).toBe("INVALID_ROLE");
  });

  it("decide approves once; a second decision is NOT_PENDING", async () => {
    const store = setup();
    const created = await store.create({
      requesterInternalUserId: "v1:decide00000000000000000000000000000000000000000000000001",
      requestedRole: "tenant-admin",
      tenantId: TENANT,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("create failed");
    const decided = await store.decide(created.request.requestId, "approved", "v1:admin000000000000000000000000000000000000000000000000001", NOW + 10);
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error("decide failed");
    expect(decided.request.status).toBe("approved");
    expect(decided.request.decidedBy).toContain("v1:admin");
    expect(decided.request.decidedAtMs).toBe(NOW + 10);
    const again = await store.decide(created.request.requestId, "denied", "v1:admin000000000000000000000000000000000000000000000000001", NOW + 20);
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("expected NOT_PENDING");
    expect(again.code).toBe("NOT_PENDING");
  });

  it("deciding an unknown id is NOT_FOUND", async () => {
    const store = setup();
    const result = await store.decide("no-such-id", "approved", "v1:admin", NOW);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected NOT_FOUND");
    expect(result.code).toBe("NOT_FOUND");
  });

  it("a corrupt record reads as absent and is skipped by list, never granted", async () => {
    const kv = memoryKv();
    const store = createAccessRequestStore(kv);
    const created = await store.create({
      requesterInternalUserId: "v1:corrupt00000000000000000000000000000000000000000000000001",
      requestedRole: "tenant-admin",
      tenantId: TENANT,
      nowMs: NOW,
    });
    if (!created.ok) throw new Error("create failed");
    kv.map.set(`iaaa-access-request:${created.request.requestId}`, "{not json");
    expect(await store.get(created.request.requestId)).toBeNull();
    expect(await store.list()).toHaveLength(0);
  });
});
