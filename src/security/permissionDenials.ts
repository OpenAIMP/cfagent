/**
 * #2450 — per-user permission-denial store + management policy.
 *
 * The PDP types live in authorization.ts (PermissionDenial,
 * PermissionDenialReader); this module is the writable store, the
 * in-memory implementation, and the rule for who may manage
 * denials. The durable KV implementation lives in
 * iaaaPermissionDenialStore.ts and mirrors the membership store's
 * key conventions.
 *
 * Slice scope: only integration:connect is manageable as a denial.
 * The store itself is permission-generic (a denial record can name
 * any permission), but the routes accept only connect in this
 * slice, so no admin can use this path to deny role:assign,
 * audit:read, or any other permission. Widening the manageable set
 * is a separate policy decision, not a code constant to flip
 * casually: a denial for an administrative permission would let
 * one tenant-admin lock another admin out of administration.
 */
import {
  authorizeWithPolicy,
  getCompiledPolicySnapshot,
  membershipStoreToAttributeProvider,
  type AuthorizationDecision,
  type MembershipStore,
  type Permission,
  type PermissionDenial,
  type PermissionDenialReader,
} from "./authorization";

/** Permissions an admin may deny/revoke per user in this slice. */
export const MANAGEABLE_DENIED_PERMISSIONS: readonly Permission[] = [
  "integration:connect",
] as const;

/** Writable denial store: the reader surface plus set/clear. */
export interface PermissionDenialStore extends PermissionDenialReader {
  /**
   * Record a denial. Idempotent by (user, tenant, permission):
   * a second put for the same triple returns the FIRST denial
   * (original denier + time), so a re-deny never rewrites
   * attribution or restarts the clock.
   */
  putDenial(denial: PermissionDenial): Promise<PermissionDenial>;
  /** Delete a denial by id. False when no such denial exists. */
  clearDenial(denialId: string): Promise<boolean>;
}

export function createMemoryPermissionDenialStore(): PermissionDenialStore {
  const byId = new Map<string, PermissionDenial>();
  const byUser = new Map<string, PermissionDenial[]>();

  return {
    async getDenialsByUser(internalUserId: string): Promise<PermissionDenial[]> {
      return [...(byUser.get(internalUserId) ?? [])].map((d) => ({ ...d }));
    },
    async putDenial(denial: PermissionDenial): Promise<PermissionDenial> {
      const list = byUser.get(denial.internalUserId) ?? [];
      const existing = list.find(
        (d) =>
          d.tenantId === denial.tenantId && d.permission === denial.permission,
      );
      if (existing) return { ...existing };
      const record = { ...denial };
      byId.set(record.denialId, record);
      list.push(record);
      byUser.set(denial.internalUserId, list);
      return { ...record };
    },
    async clearDenial(denialId: string): Promise<boolean> {
      const record = byId.get(denialId);
      if (!record) return false;
      byId.delete(denialId);
      const list = byUser.get(record.internalUserId) ?? [];
      byUser.set(
        record.internalUserId,
        list.filter((d) => d.denialId !== denialId),
      );
      return true;
    },
  };
}

export interface ManageDenialRequest {
  managerInternalUserId: string;
  targetTenantId: string;
  nowMs: number;
}

/**
 * Whether the manager may set/clear a permission denial in the
 * target tenant. Mirrors canGrantRole's tenant-scope rule exactly:
 * the manager must hold role:assign in the tenant AND hold a
 * tenant-admin binding there. A workspace-admin holds role:assign
 * only inside a workspace, so the tenant-wide check denies them;
 * a platform-admin holds platform-scope only and gains no tenant
 * authority from it — the #2331 slice-1 grant boundary stands.
 * This is the decision only: self-denial is forbidden at the
 * route (SELF_DENY), and audit-before-allow runs at the route.
 */
export async function canManagePermissionDenial(
  store: MembershipStore,
  request: ManageDenialRequest,
): Promise<AuthorizationDecision> {
  const policy = getCompiledPolicySnapshot();
  const attributes = membershipStoreToAttributeProvider(store);
  const base = {
    actorInternalUserId: request.managerInternalUserId,
    tenantId: request.targetTenantId,
    permission: "role:assign" as const,
    nowMs: request.nowMs,
  };
  const grant = await authorizeWithPolicy(policy, attributes, base);
  if (grant.decision === "deny") return grant;
  const memberships = await attributes.getMembershipsByUser(
    request.managerInternalUserId.trim(),
  );
  const inTenant = memberships.filter(
    (m) =>
      m.tenantId === request.targetTenantId.trim() &&
      m.revokedAtMs === undefined,
  );
  const hasTenantAdmin = inTenant.some((m) =>
    m.roleBindings.some(
      (b) =>
        b.role === "tenant-admin" &&
        (b.expiresAtMs === undefined || b.expiresAtMs > request.nowMs),
    ),
  );
  if (!hasTenantAdmin) {
    return {
      decision: "deny",
      reason: "SCOPE_MISMATCH",
      principalId: request.managerInternalUserId,
      tenantId: request.targetTenantId,
      permission: "role:assign",
      policyVersion: policy.version,
    };
  }
  return grant;
}
