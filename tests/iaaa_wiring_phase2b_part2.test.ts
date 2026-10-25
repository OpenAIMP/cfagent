/**
 * #945 Wiring Phase 2b-part2 — migration + membership provisioning.
 *
 * Tests are written FIRST (TDD): this file must fail on the missing
 * modules before the implementation lands. Coverage:
 * - Kv membership store: put/get round trip, revoke, key-prefix
 *   separation from session / binding / audit keys.
 * - Grant path hard rule: a tenant admin cannot grant platform
 *   privileges; a non-admin cannot grant at all; a workspace-admin
 *   cannot grant a tenant-wide role.
 * - Bootstrap parsing: bare internal ids must be UUIDs (a pasted
 *   GitHub login is rejected, not silently provisioned); provider
 *   entries use issuer:subject form with the split at the LAST
 *   colon (issuers contain "://"); unset/empty input provisions
 *   ZERO members and rejects nothing.
 * - Bootstrap resolution + provisioning: provider subjects resolve
 *   through Slice 1 bindings; unbound subjects are reported, never
 *   invented; provisioning is idempotent and refuses an empty
 *   tenant id (no default tenant); bootstrap grants tenant-admin
 *   only — never platform-admin.
 * - Migration aliases: login <-> internalUserId in both directions;
 *   a conflicting alias is rejected and the original preserved;
 *   dual-read tries the internal-id key first, falls back to the
 *   login key, and never deletes or renames either key; DO naming
 *   for an unresolved user returns "unresolved", never a made-up
 *   name; the legacy login-derived DID still resolves via alias.
 * - PDP seam: allows with a membership, denies cross-tenant and
 *   without any membership. The seam is not wired to any route in
 *   this slice (verified by grep in the parent review, not here).
 */
import { describe, expect, it } from "vitest";
import {
  authorize,
  canGrantRole,
  createMembership,
  createMemoryMembershipStore,
  type MembershipStore,
} from "../src/security/authorization";
import {
  createKvMembershipStore,
  grantMembership,
  IAAA_MEMBERSHIP_KEY_PREFIX,
} from "../src/security/iaaaMembershipStore";
import {
  parseBootstrapAdmins,
  provisionBootstrapAdmins,
  resolveBootstrapEntries,
} from "../src/security/iaaaBootstrap";
import {
  IAAA_ALIAS_KEY_PREFIX,
  lookupInternalUserIdByLogin,
  lookupLoginByUserId,
  readWithFallback,
  recordLoginAlias,
  resolveDoNameInput,
} from "../src/security/iaaaMigration";
import { checkPermission } from "../src/security/iaaaPdpSeam";
import { createMemoryIdentityBindingStore } from "../src/security/identityBinding";
import { getUserDid } from "../src/agents/did";
import type { KvLike } from "../src/security/kvResilience";

/** In-memory KvLike with key inspection. */
function memoryKv(): KvLike & { keys(): string[] } {
  const map = new Map<string, string>();
  const kv: KvLike & { keys(): string[] } = {
    keys: () => [...map.keys()],
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
  return kv;
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

describe("Kv membership store", () => {
  it("round-trips put/get and revokes", async () => {
    const kv = memoryKv();
    const store = createKvMembershipStore(kv);
    const created = await createMembership(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-1",
      roleBindings: [
        { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
      ],
      createdBy: "system:bootstrap",
      nowMs: 1_000,
    });
    expect(created.ok).toBe(true);
    const list = await store.getMembershipsByUser(UUID_A);
    expect(list).toHaveLength(1);
    expect(list[0]!.tenantId).toBe("tenant-1");
    expect(await store.getMembershipsByUser(UUID_B)).toHaveLength(0);
    const revoked = await store.revokeMembership(list[0]!.membershipId, 2_000);
    expect(revoked).toBe(true);
    const after = await store.getMembershipsByUser(UUID_A);
    expect(after[0]!.revokedAtMs).toBe(2_000);
    expect(await store.revokeMembership("no-such-id", 3_000)).toBe(false);
  });

  it("uses only iaaa-membership: keys, colliding with nothing", async () => {
    const kv = memoryKv();
    const store = createKvMembershipStore(kv);
    await createMembership(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-1",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "g" }],
      createdBy: "g",
      nowMs: 1_000,
    });
    const keys = kv.keys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith(IAAA_MEMBERSHIP_KEY_PREFIX)).toBe(true);
      expect(key.startsWith("iaaa-binding:")).toBe(false);
      expect(key.startsWith("iaaa-audit:")).toBe(false);
      // Session keys are bare UUIDs; a membership key is never one.
      expect(key).not.toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    }
  });
});

describe("grant path hard rule", () => {
  async function storeWithTenantAdmin(): Promise<MembershipStore> {
    const store = createMemoryMembershipStore();
    await createMembership(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-1",
      roleBindings: [
        { role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" },
      ],
      createdBy: "system:bootstrap",
      nowMs: 1_000,
    });
    return store;
  }

  it("tenant admin can grant a tenant role", async () => {
    const store = await storeWithTenantAdmin();
    const granted = await grantMembership(store, {
      granterInternalUserId: UUID_A,
      internalUserId: UUID_B,
      tenantId: "tenant-1",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: UUID_A }],
      nowMs: 2_000,
    });
    expect(granted.ok).toBe(true);
    const decision = await authorize(store, {
      actorInternalUserId: UUID_B,
      tenantId: "tenant-1",
      permission: "task:create",
      nowMs: 2_000,
    });
    expect(decision.decision).toBe("allow");
  });

  it("tenant admin CANNOT grant platform-admin", async () => {
    const store = await storeWithTenantAdmin();
    const granted = await grantMembership(store, {
      granterInternalUserId: UUID_A,
      internalUserId: UUID_B,
      tenantId: "tenant-1",
      roleBindings: [
        { role: "platform-admin", scope: "platform", grantedBy: UUID_A },
      ],
      nowMs: 2_000,
    });
    expect(granted.ok).toBe(false);
    if (!granted.ok) expect(granted.code).toBe("GRANT_DENIED");
    expect(await store.getMembershipsByUser(UUID_B)).toHaveLength(0);
  });

  it("a user with no membership cannot grant at all", async () => {
    const store = await storeWithTenantAdmin();
    const granted = await grantMembership(store, {
      granterInternalUserId: UUID_C,
      internalUserId: UUID_B,
      tenantId: "tenant-1",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: UUID_C }],
      nowMs: 2_000,
    });
    expect(granted.ok).toBe(false);
    expect(await store.getMembershipsByUser(UUID_B)).toHaveLength(0);
  });

  it("workspace-admin cannot grant a tenant-wide role", async () => {
    const store = createMemoryMembershipStore();
    await createMembership(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-1",
      workspaceId: "ws-1",
      roleBindings: [
        {
          role: "workspace-admin",
          scope: "workspace",
          workspaceId: "ws-1",
          grantedBy: "system:bootstrap",
        },
      ],
      createdBy: "system:bootstrap",
      nowMs: 1_000,
    });
    const granted = await grantMembership(store, {
      granterInternalUserId: UUID_A,
      internalUserId: UUID_B,
      tenantId: "tenant-1",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: UUID_A }],
      nowMs: 2_000,
    });
    expect(granted.ok).toBe(false);
    expect(await store.getMembershipsByUser(UUID_B)).toHaveLength(0);
  });

  it("canGrantRole agrees: tenant admin is not a platform granter", async () => {
    const store = await storeWithTenantAdmin();
    const decision = await canGrantRole(store, {
      granterInternalUserId: UUID_A,
      targetTenantId: "tenant-1",
      targetScope: "platform",
      targetRole: "platform-admin",
      nowMs: 2_000,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toBe("PLATFORM_SCOPE_DENIED");
  });
});

describe("bootstrap parsing", () => {
  it("unset or empty input provisions zero and rejects nothing", () => {
    expect(parseBootstrapAdmins(undefined)).toEqual({
      entries: [],
      rejected: [],
    });
    expect(parseBootstrapAdmins("")).toEqual({ entries: [], rejected: [] });
    expect(parseBootstrapAdmins("  ,  ")).toEqual({
      entries: [],
      rejected: [],
    });
  });

  it("accepts a bare UUID internal id", () => {
    const parsed = parseBootstrapAdmins(UUID_A);
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.entries).toEqual([
      { kind: "internalUserId", internalUserId: UUID_A },
    ]);
  });

  it("accepts issuer:subject form, splitting at the LAST colon", () => {
    const parsed = parseBootstrapAdmins("https://github.com:424242");
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.entries).toEqual([
      {
        kind: "providerSubject",
        providerIssuer: "https://github.com",
        providerSubject: "424242",
      },
    ]);
  });

  it("rejects a bare GitHub login instead of silently provisioning it", () => {
    const parsed = parseBootstrapAdmins("octocat");
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
    expect(parsed.rejected[0]!.entry).toBe("octocat");
  });

  it("rejects malformed entries with reasons", () => {
    const parsed = parseBootstrapAdmins(
      "https://github.com:, :42, https://github.com:  , has space",
    );
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(4);
    for (const r of parsed.rejected) expect(r.reason.length).toBeGreaterThan(0);
  });

  it("rejects an over-long entry", () => {
    const parsed = parseBootstrapAdmins("x".repeat(513));
    expect(parsed.entries).toHaveLength(0);
    expect(parsed.rejected).toHaveLength(1);
  });

  it("trims surrounding whitespace on valid entries", () => {
    const parsed = parseBootstrapAdmins(`  ${UUID_A} , https://github.com:7  `);
    expect(parsed.rejected).toHaveLength(0);
    expect(parsed.entries).toHaveLength(2);
  });
});

describe("bootstrap resolution and provisioning", () => {
  it("resolves a provider subject through the Slice 1 binding", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await bindings.put({
      internalUserId: UUID_A,
      providerIssuer: "https://github.com",
      providerSubject: "424242",
      linkedAt: 1_000,
      proofOfControl: "oidc",
    });
    const resolved = await resolveBootstrapEntries(bindings, [
      {
        kind: "providerSubject",
        providerIssuer: "https://github.com",
        providerSubject: "424242",
      },
      {
        kind: "providerSubject",
        providerIssuer: "https://github.com",
        providerSubject: "999999",
      },
      { kind: "internalUserId", internalUserId: UUID_B },
    ]);
    expect(resolved.internalUserIds).toEqual([UUID_A, UUID_B]);
    expect(resolved.unresolved).toHaveLength(1);
    expect(resolved.unresolved[0]!.providerSubject).toBe("999999");
  });

  it("provisions tenant-admin memberships, idempotently", async () => {
    const store = createMemoryMembershipStore();
    const first = await provisionBootstrapAdmins(store, {
      tenantId: "tenant-1",
      internalUserIds: [UUID_A, UUID_B],
      nowMs: 1_000,
    });
    expect(first.provisioned).toEqual([UUID_A, UUID_B]);
    expect(first.skippedAlreadyAdmin).toEqual([]);
    const second = await provisionBootstrapAdmins(store, {
      tenantId: "tenant-1",
      internalUserIds: [UUID_A],
      nowMs: 2_000,
    });
    expect(second.provisioned).toEqual([]);
    expect(second.skippedAlreadyAdmin).toEqual([UUID_A]);
    // Bootstrap grants tenant-admin only, never platform-admin.
    const decision = await authorize(store, {
      actorInternalUserId: UUID_A,
      permission: "role:assign",
      scope: "platform",
      nowMs: 2_000,
    });
    expect(decision.decision).toBe("deny");
    const tenantDecision = await authorize(store, {
      actorInternalUserId: UUID_A,
      tenantId: "tenant-1",
      permission: "task:create",
      nowMs: 2_000,
    });
    expect(tenantDecision.decision).toBe("allow");
  });

  it("refuses an empty tenant id and writes nothing", async () => {
    const store = createMemoryMembershipStore();
    const result = await provisionBootstrapAdmins(store, {
      tenantId: "   ",
      internalUserIds: [UUID_A],
      nowMs: 1_000,
    });
    expect(result.ok).toBe(false);
    expect(await store.getMembershipsByUser(UUID_A)).toHaveLength(0);
  });

  it("an empty user list provisions nothing", async () => {
    const store = createMemoryMembershipStore();
    const result = await provisionBootstrapAdmins(store, {
      tenantId: "tenant-1",
      internalUserIds: [],
      nowMs: 1_000,
    });
    expect(result.ok).toBe(true);
    expect(result.provisioned).toEqual([]);
  });
});

describe("migration aliases", () => {
  it("records and looks up in both directions", async () => {
    const kv = memoryKv();
    const recorded = await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: UUID_A,
      nowMs: 1_000,
    });
    expect(recorded.ok).toBe(true);
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(UUID_A);
    expect(await lookupLoginByUserId(kv, UUID_A)).toBe("octocat");
    expect(await lookupInternalUserIdByLogin(kv, "nobody")).toBe(null);
  });

  it("a conflicting alias is rejected and the original preserved", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: UUID_A,
      nowMs: 1_000,
    });
    const conflict = await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: UUID_B,
      nowMs: 2_000,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("ALIAS_CONFLICT");
    expect(await lookupInternalUserIdByLogin(kv, "octocat")).toBe(UUID_A);
    // Re-recording the identical alias is idempotent, not a conflict.
    const same = await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: UUID_A,
      nowMs: 3_000,
    });
    expect(same.ok).toBe(true);
  });

  it("alias keys use only the iaaa-alias: prefix", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: UUID_A,
      nowMs: 1_000,
    });
    const keys = kv.keys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.startsWith(IAAA_ALIAS_KEY_PREFIX)).toBe(true);
      expect(key.startsWith("iaaa-binding:")).toBe(false);
      expect(key.startsWith("iaaa-audit:")).toBe(false);
      expect(key.startsWith(IAAA_MEMBERSHIP_KEY_PREFIX)).toBe(false);
    }
  });

  it("dual-read prefers the internal-id key, falls back, never deletes", async () => {
    const kv = memoryKv();
    await kv.put("etrade:token:octocat", "login-token");
    // Primary hit wins.
    const primary = await readWithFallback(
      (key) => kv.get(key),
      "etrade:token:" + UUID_A,
      "etrade:token:octocat",
    );
    expect(primary.value).toBe("login-token");
    expect(primary.source).toBe("fallback");
    await kv.put("etrade:token:" + UUID_A, "id-token");
    const hit = await readWithFallback(
      (key) => kv.get(key),
      "etrade:token:" + UUID_A,
      "etrade:token:octocat",
    );
    expect(hit.value).toBe("id-token");
    expect(hit.source).toBe("primary");
    // Both miss.
    const miss = await readWithFallback(
      (key) => kv.get(key),
      "etrade:token:missing",
      "etrade:token:alsomissing",
    );
    expect(miss.value).toBe(null);
    expect(miss.source).toBe("none");
    // Neither key was deleted or renamed by any read.
    expect(await kv.get("etrade:token:octocat")).toBe("login-token");
    expect(await kv.get("etrade:token:" + UUID_A)).toBe("id-token");
  });

  it("DO naming for an unresolved user is unresolved, never invented", async () => {
    const kv = memoryKv();
    expect(resolveDoNameInput(null)).toEqual({ kind: "unresolved" });
    await recordLoginAlias(kv, {
      githubLogin: "octocat",
      internalUserId: UUID_A,
      nowMs: 1_000,
    });
    const login = await lookupLoginByUserId(kv, UUID_A);
    expect(resolveDoNameInput(login)).toEqual({
      kind: "legacy-login",
      login: "octocat",
    });
  });

  it("the legacy login-derived DID still resolves through the alias", async () => {
    const kv = memoryKv();
    await recordLoginAlias(kv, {
      githubLogin: "OctoCat",
      internalUserId: UUID_A,
      nowMs: 1_000,
    });
    const login = await lookupLoginByUserId(kv, UUID_A);
    expect(login).toBe("OctoCat");
    // getUserDid is the existing legacy derivation; the alias is what
    // keeps it reachable once callers hold only an internalUserId.
    expect(getUserDid(login!)).toBe("did:user:github:octocat");
  });
});

describe("PDP seam (not enforcement)", () => {
  it("allows with a membership, denies cross-tenant and without one", async () => {
    const store = createMemoryMembershipStore();
    await createMembership(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-1",
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "g" }],
      createdBy: "g",
      nowMs: 1_000,
    });
    const own = await checkPermission(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-1",
      permission: "task:read",
      resourceScope: { resourceOwnerId: UUID_A },
      nowMs: 2_000,
    });
    expect(own.decision).toBe("allow");
    const cross = await checkPermission(store, {
      internalUserId: UUID_A,
      tenantId: "tenant-2",
      permission: "task:read",
      nowMs: 2_000,
    });
    expect(cross.decision).toBe("deny");
    expect(cross.reason).toBe("CROSS_TENANT");
    const none = await checkPermission(store, {
      internalUserId: UUID_B,
      tenantId: "tenant-1",
      permission: "task:read",
      nowMs: 2_000,
    });
    expect(none.decision).toBe("deny");
    expect(none.reason).toBe("NO_MEMBERSHIP");
  });
});
