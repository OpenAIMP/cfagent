/**
 * #1210 — repair migration moving the stranded platform-admin from the
 * retired Oct 22 activation id to the logging-in derived id.
 *
 * The genesis marker was already set by the Oct 22 activation
 * identity (a minted id no current login carries), so the owner
 * GitHub login holds only tenant-admin while a platform-admin
 * membership sits stranded on the retired id. This repair, run in
 * the login path at the same point as normal binding migration,
 * moves ONLY active platform-admin memberships from the retired
 * id to the logging-in id (equivalents created unless one
 * exists; old records revoked, never deleted), and revokes the
 * retired record. It never resurrects a revoked membership, never
 * duplicates a grant the target already holds, never fires for an
 * unlisted caller, and is self-retiring: after the retired record
 * is revoked, later runs find nothing to move. Any store failure
 * fails this step only — never the login.
 */
import { describe, expect, it } from "vitest";
import {
  createMembership,
  createMemoryMembershipStore,
  type Membership,
  type MembershipStore,
} from "../src/security/authorization";
import {
  createMemoryIdentityBindingStore,
  type IdentityBindingStore,
} from "../src/security/identityBinding";
import { isPlatformBootstrapListed } from "../src/security/iaaaLogin";
import {
  repairStrandedPlatformAdmin,
  STRANDED_PLATFORM_ADMIN_ID,
  type RepairStrandedPlatformAdminResult,
} from "../src/security/iaaaMigration";

// Golden vector from #1182 (SHA-256 of "https://github.com\0" + "42"),
// used here purely as a synthetic derived target id.
const TARGET_ID =
  "v1:0962030c695d4b7f3a855132a8d14e814ede67f43f538a4e67bf68a59f99b72a";
const GITHUB_ISSUER = "https://github.com";
const NOW = 9_000;

async function seedPlatformAdmin(
  store: MembershipStore,
  userId: string,
  grantedBy = "system:bootstrap-genesis",
): Promise<Membership> {
  const created = await createMembership(store, {
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy }],
    createdBy: grantedBy,
    nowMs: 2_000,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("seed platform-admin failed");
  return created.membership;
}

async function seedTenantAdmin(
  store: MembershipStore,
  userId: string,
): Promise<Membership> {
  const created = await createMembership(store, {
    internalUserId: userId,
    tenantId: "primary",
    roleBindings: [{ role: "tenant-admin", scope: "tenant", grantedBy: "system:bootstrap" }],
    createdBy: "system:bootstrap",
    nowMs: 2_000,
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("seed tenant-admin failed");
  return created.membership;
}

async function activePlatformAdmins(
  store: MembershipStore,
  userId: string,
): Promise<Membership[]> {
  const all = await store.getMembershipsByUser(userId);
  return all.filter(
    (m) =>
      m.revokedAtMs === undefined &&
      m.roleBindings.some((b) => b.role === "platform-admin" && b.scope === "platform"),
  );
}

describe("repairStrandedPlatformAdmin (#1210)", () => {
  it("pins the retired activation id repair constant", () => {
    expect(STRANDED_PLATFORM_ADMIN_ID).toBe(
      "00fbb0ba-9e4b-43ec-a7d6-df2a1dfc5d6c",
    );
  });

  it("moves an active platform-admin to the listed target and revokes the retired record", async () => {
    const store = createMemoryMembershipStore();
    const retired = await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("moved");
    const target = await activePlatformAdmins(store, TARGET_ID);
    expect(target).toHaveLength(1);
    expect(target[0]?.tenantId).toBe("primary");
    expect(target[0]?.roleBindings).toEqual([
      { role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" },
    ]);
    expect(target[0]?.createdBy).toBe("system:bootstrap-genesis");
    expect(target[0]?.revokedAtMs).toBeUndefined();
    // Retired record is revoked, never deleted.
    const retiredAfter = await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID);
    expect(retiredAfter).toHaveLength(1);
    expect(retiredAfter[0]?.membershipId).toBe(retired.membershipId);
    expect(retiredAfter[0]?.revokedAtMs).toBe(NOW);
  });

  it("revokes only (no duplicate) when the target already holds platform-admin", async () => {
    const store = createMemoryMembershipStore();
    // Different grantedBy on purpose: the already-holds check is
    // about holding the role, not about signature equality.
    await seedPlatformAdmin(store, TARGET_ID, "system:other-grant");
    await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("revoked-only");
    expect(await activePlatformAdmins(store, TARGET_ID)).toHaveLength(1);
    const retiredAfter = await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID);
    expect(retiredAfter).toHaveLength(1);
    expect(retiredAfter[0]?.revokedAtMs).toBe(NOW);
  });

  it("is a no-op when the retired id holds nothing", async () => {
    const store = createMemoryMembershipStore();
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("noop");
    expect(await store.getMembershipsByUser(TARGET_ID)).toHaveLength(0);
    expect(await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID)).toHaveLength(0);
  });

  it("is a no-op for a revoked retired membership and never resurrects it", async () => {
    const store = createMemoryMembershipStore();
    const retired = await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    await store.put({ ...retired, revokedAtMs: 5_000 });
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("noop");
    expect(await store.getMembershipsByUser(TARGET_ID)).toHaveLength(0);
    const retiredAfter = await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID);
    expect(retiredAfter).toHaveLength(1);
    expect(retiredAfter[0]?.revokedAtMs).toBe(5_000);
  });

  it("is a no-op when the caller is not platform-listed", async () => {
    const store = createMemoryMembershipStore();
    await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: false,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("noop");
    expect(await store.getMembershipsByUser(TARGET_ID)).toHaveLength(0);
    expect(await activePlatformAdmins(store, STRANDED_PLATFORM_ADMIN_ID)).toHaveLength(1);
  });

  it("is a no-op on a second run after a successful move", async () => {
    const store = createMemoryMembershipStore();
    await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    const first = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(first.status).toBe("moved");
    const revokedAt = (
      await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID)
    )[0]?.revokedAtMs;
    const second = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW + 1_000,
    });
    expect(second.status).toBe("noop");
    expect(await activePlatformAdmins(store, TARGET_ID)).toHaveLength(1);
    expect(
      (await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID))[0]?.revokedAtMs,
    ).toBe(revokedAt);
  });

  it("never revokes the caller own grant when target equals the retired id", async () => {
    const store = createMemoryMembershipStore();
    await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: STRANDED_PLATFORM_ADMIN_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("noop");
    expect(await activePlatformAdmins(store, STRANDED_PLATFORM_ADMIN_ID)).toHaveLength(1);
  });

  it("moves only platform-admin memberships, leaving other active memberships untouched", async () => {
    const store = createMemoryMembershipStore();
    await seedPlatformAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    await seedTenantAdmin(store, STRANDED_PLATFORM_ADMIN_ID);
    const result = await repairStrandedPlatformAdmin({
      membershipStore: store,
      isPlatformListed: true,
      targetInternalUserId: TARGET_ID,
      nowMs: NOW,
    });
    expect(result.status).toBe("moved");
    expect(await activePlatformAdmins(store, TARGET_ID)).toHaveLength(1);
    const retiredAfter = await store.getMembershipsByUser(STRANDED_PLATFORM_ADMIN_ID);
    const tenantStillActive = retiredAfter.filter(
      (m) =>
        m.revokedAtMs === undefined &&
        m.roleBindings.some((b) => b.role === "tenant-admin"),
    );
    expect(tenantStillActive).toHaveLength(1);
    const platformAfter = retiredAfter.filter((m) =>
      m.roleBindings.some((b) => b.role === "platform-admin"),
    );
    expect(platformAfter).toHaveLength(1);
    expect(platformAfter[0]?.revokedAtMs).toBe(NOW);
  });

  it("fails closed with an error status (never throws) when the store fails", async () => {
    const base = createMemoryMembershipStore();
    const failing: MembershipStore = {
      ...base,
      async getMembershipsByUser() {
        throw new Error("store boom");
      },
    };
    let result: RepairStrandedPlatformAdminResult | undefined;
    let threw = false;
    try {
      result = await repairStrandedPlatformAdmin({
        membershipStore: failing,
        isPlatformListed: true,
        targetInternalUserId: TARGET_ID,
        nowMs: NOW,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.status).toBe("error");
  });
});

describe("isPlatformBootstrapListed (repair wiring)", () => {
  async function seedBinding(
    store: IdentityBindingStore,
    issuer: string,
    subject: string,
    internalUserId: string,
  ): Promise<void> {
    await store.put({
      internalUserId,
      providerIssuer: issuer,
      providerSubject: subject,
      linkedAt: 1_000,
      proofOfControl: "oidc",
    });
  }

  it("matches a platform: issuer:subject entry resolving to the target", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedBinding(bindings, GITHUB_ISSUER, "82253453", TARGET_ID);
    const listed = await isPlatformBootstrapListed(
      bindings,
      "platform:https://github.com:82253453,https://github.com:82253453",
      TARGET_ID,
    );
    expect(listed).toBe(true);
  });

  it("is false for a plain (non-platform:) entry only", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedBinding(bindings, GITHUB_ISSUER, "82253453", TARGET_ID);
    const listed = await isPlatformBootstrapListed(
      bindings,
      "https://github.com:82253453",
      TARGET_ID,
    );
    expect(listed).toBe(false);
  });

  it("is false for an undefined bootstrap list", async () => {
    const bindings = createMemoryIdentityBindingStore();
    const listed = await isPlatformBootstrapListed(bindings, undefined, TARGET_ID);
    expect(listed).toBe(false);
  });

  it("matches a platform: bare derived-id entry equal to the target", async () => {
    const bindings = createMemoryIdentityBindingStore();
    const listed = await isPlatformBootstrapListed(
      bindings,
      `platform:${TARGET_ID}`,
      TARGET_ID,
    );
    expect(listed).toBe(true);
    const other = await isPlatformBootstrapListed(
      bindings,
      `platform:v1:${"b".repeat(64)}`,
      TARGET_ID,
    );
    expect(other).toBe(false);
  });

  it("is false for a platform: entry resolving to a different user", async () => {
    const bindings = createMemoryIdentityBindingStore();
    await seedBinding(bindings, GITHUB_ISSUER, "424242", "v1:" + "c".repeat(64));
    const listed = await isPlatformBootstrapListed(
      bindings,
      "platform:https://github.com:424242",
      TARGET_ID,
    );
    expect(listed).toBe(false);
  });
});
