/**
 * Issue #1274 — automatic member provisioning on first wired login.
 *
 * Runs in the provider-agnostic wired-login tail (completeWiredLogin),
 * so GitHub and Google (and any future registered provider) behave
 * identically — no per-provider branches, no email anywhere in the
 * decision. Identity is the caller's stable internalUserId; email is
 * never identity and never auto-links accounts.
 *
 * Rules, all fail-closed:
 * - The caller already holding ANY active binding in the tenant keeps
 *   it untouched: no duplicate member membership, never a downgrade
 *   (a tenant-admin is not "upgraded" to member, nor duplicated).
 * - Otherwise exactly one tenant-scope member membership is created
 *   (Slice 3 grants: task create/read/cancel, artifact read/edit/
 *   export, action propose — explicitly NOT integration connect/use/
 *   manage, membership invite/revoke, role assign, action approve/
 *   execute, or audit read/export).
 * - Any store failure reports "error" and never throws: provisioning
 *   must never break a login, and must never grant beyond member.
 * - A revoked-only or fully-expired prior membership does not block
 *   a fresh grant (there is nothing active to preserve).
 */
import {
  createMembership,
  type MembershipStore,
} from "./authorization";

export type AutoProvisionResult =
  | { status: "granted"; membershipId: string }
  | { status: "already-member" }
  | { status: "error"; error: string };

export interface AutoProvisionInput {
  internalUserId: string;
  tenantId: string;
  nowMs: number;
}

function isActiveBinding(
  binding: { expiresAtMs?: number },
  nowMs: number,
): boolean {
  return binding.expiresAtMs === undefined || binding.expiresAtMs > nowMs;
}

export async function ensureTenantMember(
  store: MembershipStore,
  input: AutoProvisionInput,
): Promise<AutoProvisionResult> {
  try {
    if (
      typeof input.internalUserId !== "string" ||
      input.internalUserId.trim() === "" ||
      typeof input.tenantId !== "string" ||
      input.tenantId.trim() === ""
    ) {
      return { status: "error", error: "internalUserId and tenantId must be non-empty strings" };
    }
    const memberships = await store.getMembershipsByUser(input.internalUserId);
    const alreadyActive = memberships.some(
      (m) =>
        m.tenantId === input.tenantId.trim() &&
        m.revokedAtMs === undefined &&
        m.roleBindings.some((b) => isActiveBinding(b, input.nowMs)),
    );
    if (alreadyActive) return { status: "already-member" };
    const created = await createMembership(store, {
      internalUserId: input.internalUserId,
      tenantId: input.tenantId,
      roleBindings: [{ role: "member", scope: "tenant", grantedBy: "system:auto-provision" }],
      createdBy: "system:auto-provision",
      nowMs: input.nowMs,
    });
    if (!created.ok) return { status: "error", error: created.error };
    return { status: "granted", membershipId: created.membership.membershipId };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "auto-provision failed" };
  }
}
