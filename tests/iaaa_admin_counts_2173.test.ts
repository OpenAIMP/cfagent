import { describe, it, expect } from "vitest";
import {
  computeAdminCounts,
  type AdminCounts,
} from "../src/security/iaaaAdminOverview";
import type { Membership, RoleBinding } from "../src/security/authorization";

/**
 * #2173 admin-counts slice — pure counting over membership records.
 *
 * Counting rules (fixed from the verified membership model in
 * src/security/authorization.ts + iaaaMembershipStore.ts):
 * - A membership counts only when it is live: revokedAtMs undefined.
 * - A binding counts only when it is live: expiresAtMs undefined or > nowMs.
 * - Platform admins = DISTINCT internalUserIds holding a live
 *   platform-admin binding at platform scope. Two platform-admin
 *   memberships for one identity count once. Platform scope is
 *   platform-wide, so no per-tenant split applies.
 * - Tenant admins = per tenant, DISTINCT internalUserIds holding a
 *   live tenant-admin binding at tenant scope in that tenant. An
 *   identity admin in two tenants counts in EACH tenant's count.
 * - System-wide tenant-admin total = SUM of the per-tenant counts
 *   (not distinct identities across tenants).
 * - An identity holding both a platform-admin binding and a
 *   tenant-admin binding counts in BOTH dimensions.
 * - member / workspace-admin / approver / auditor bindings never
 *   count; scope mismatches (platform-admin at tenant scope,
 *   tenant-admin at platform scope) never count.
 * - No identities are returned: counts only.
 */

const NOW = 1792660000000;

function binding(
  role: RoleBinding["role"],
  scope: RoleBinding["scope"],
  extra: Partial<RoleBinding> = {},
): RoleBinding {
  return { role, scope, grantedBy: "system:bootstrap", ...extra };
}

function membership(
  membershipId: string,
  internalUserId: string,
  tenantId: string,
  roleBindings: RoleBinding[],
  extra: Partial<Membership> = {},
): Membership {
  return {
    membershipId,
    internalUserId,
    tenantId,
    roleBindings,
    createdBy: "system:bootstrap",
    createdAtMs: NOW - 1000,
    ...extra,
  };
}

const ADMIN_A = "11111111-1111-4111-8111-111111111111";
const ADMIN_B = "22222222-2222-4222-8222-222222222222";
const USER_C = "33333333-3333-4333-8333-333333333333";

describe("computeAdminCounts", () => {
  it("empty input → zero counts and an empty breakdown", () => {
    expect(computeAdminCounts([], NOW)).toEqual({
      platformAdmins: 0,
      tenantAdminsTotal: 0,
      tenantAdminsByTenant: [],
    } satisfies AdminCounts);
  });

  it("platform-only admin counted once as platform, even with two platform-admin memberships", () => {
    const counts = computeAdminCounts(
      [
        membership("m-p1", ADMIN_A, "primary", [binding("platform-admin", "platform")]),
        membership("m-p2", ADMIN_A, "other", [binding("platform-admin", "platform")]),
      ],
      NOW,
    );
    expect(counts.platformAdmins).toBe(1);
    expect(counts.tenantAdminsTotal).toBe(0);
    expect(counts.tenantAdminsByTenant).toEqual([]);
  });

  it("tenant-admin in one tenant counts once in that tenant and in the total", () => {
    const counts = computeAdminCounts(
      [membership("m-t1", ADMIN_B, "primary", [binding("tenant-admin", "tenant")])],
      NOW,
    );
    expect(counts.platformAdmins).toBe(0);
    expect(counts.tenantAdminsTotal).toBe(1);
    expect(counts.tenantAdminsByTenant).toEqual([{ tenantId: "primary", count: 1 }]);
  });

  it("identity admin in two tenants counts in each tenant; total is the sum", () => {
    const counts = computeAdminCounts(
      [
        membership("m-t1", ADMIN_B, "primary", [binding("tenant-admin", "tenant")]),
        membership("m-t2", ADMIN_B, "acme", [binding("tenant-admin", "tenant")]),
        membership("m-t3", USER_C, "acme", [binding("tenant-admin", "tenant")]),
      ],
      NOW,
    );
    expect(counts.platformAdmins).toBe(0);
    expect(counts.tenantAdminsTotal).toBe(3);
    expect(counts.tenantAdminsByTenant).toEqual([
      { tenantId: "acme", count: 2 },
      { tenantId: "primary", count: 1 },
    ]);
  });

  it("plain member, workspace-admin, approver, and auditor bindings are excluded", () => {
    const counts = computeAdminCounts(
      [
        membership("m-m1", USER_C, "primary", [binding("member", "tenant")]),
        membership("m-w1", USER_C, "primary", [binding("workspace-admin", "workspace")]),
        membership("m-a1", USER_C, "primary", [binding("approver", "tenant")]),
        membership("m-u1", USER_C, "primary", [binding("auditor", "tenant")]),
      ],
      NOW,
    );
    expect(counts).toEqual({
      platformAdmins: 0,
      tenantAdminsTotal: 0,
      tenantAdminsByTenant: [],
    });
  });

  it("revoked memberships are excluded", () => {
    const counts = computeAdminCounts(
      [
        membership("m-p1", ADMIN_A, "primary", [binding("platform-admin", "platform")], {
          revokedAtMs: NOW - 10,
        }),
        membership("m-t1", ADMIN_B, "primary", [binding("tenant-admin", "tenant")], {
          revokedAtMs: NOW - 10,
        }),
      ],
      NOW,
    );
    expect(counts).toEqual({
      platformAdmins: 0,
      tenantAdminsTotal: 0,
      tenantAdminsByTenant: [],
    });
  });

  it("expired bindings are excluded", () => {
    const counts = computeAdminCounts(
      [
        membership("m-p1", ADMIN_A, "primary", [
          binding("platform-admin", "platform", { expiresAtMs: NOW - 10 }),
        ]),
        membership("m-t1", ADMIN_B, "primary", [
          binding("tenant-admin", "tenant", { expiresAtMs: NOW }),
        ]),
      ],
      NOW,
    );
    expect(counts).toEqual({
      platformAdmins: 0,
      tenantAdminsTotal: 0,
      tenantAdminsByTenant: [],
    });
  });

  it("scope mismatches never count", () => {
    const counts = computeAdminCounts(
      [
        membership("m-p1", ADMIN_A, "primary", [binding("platform-admin", "tenant")]),
        membership("m-t1", ADMIN_B, "primary", [binding("tenant-admin", "platform")]),
      ],
      NOW,
    );
    expect(counts).toEqual({
      platformAdmins: 0,
      tenantAdminsTotal: 0,
      tenantAdminsByTenant: [],
    });
  });

  it("identity holding both platform-admin and tenant-admin counts in both dimensions", () => {
    const counts = computeAdminCounts(
      [
        membership("m-p1", ADMIN_A, "primary", [binding("platform-admin", "platform")]),
        membership("m-t1", ADMIN_A, "primary", [binding("tenant-admin", "tenant")]),
      ],
      NOW,
    );
    expect(counts.platformAdmins).toBe(1);
    expect(counts.tenantAdminsTotal).toBe(1);
    expect(counts.tenantAdminsByTenant).toEqual([{ tenantId: "primary", count: 1 }]);
  });

  it("duplicate tenant-admin memberships for one identity in one tenant count once", () => {
    const counts = computeAdminCounts(
      [
        membership("m-t1", ADMIN_B, "primary", [binding("tenant-admin", "tenant")]),
        membership("m-t2", ADMIN_B, "primary", [binding("tenant-admin", "tenant")]),
      ],
      NOW,
    );
    expect(counts.tenantAdminsTotal).toBe(1);
    expect(counts.tenantAdminsByTenant).toEqual([{ tenantId: "primary", count: 1 }]);
  });

  it("returns counts only — no member identities", () => {
    const counts = computeAdminCounts(
      [membership("m-p1", ADMIN_A, "primary", [binding("platform-admin", "platform")])],
      NOW,
    );
    expect(JSON.stringify(counts)).not.toContain(ADMIN_A);
  });
});
