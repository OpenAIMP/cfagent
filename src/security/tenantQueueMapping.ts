/**
 * Issue #2457 — tenant-to-login mapping for cross-tenant queue management.
 *
 * Owner ruling (2026-10-30): a platform admin manages ALL tenants. Queues
 * live in per-login Durable Object instances (`idFromName(userLogin)`),
 * not in tenants — so acting on a tenant's queues first needs a mapping
 * from the tenant to the login instances that hold its members' queues.
 * This module is that mapping, built from stored records only:
 *
 * - Tenancy comes from membership records: a tenant's members are the
 *   distinct internalUserIds holding a NON-REVOKED membership record
 *   for that tenant. Binding expiry does NOT remove tenancy: expiry
 *   governs permission, revocation governs membership.
 * - Logins come from two stored sources, in order: (a) the wired-login
 *   alias record (`iaaa-alias:user:<internalUserId>`, verbatim login =
 *   DO instance name); (b) live session records in the sessions
 *   namespace, parsed by parseSessionRegistryEntry (UUID key + string
 *   githubLogin), filtered to the internalUserId.
 *
 * Nothing here is derived from a login name, and a tenantId is never
 * used to construct an instance name. A member with neither an alias
 * nor a session record is UNMAPPED: reported, never guessed. A tenant
 * with zero resolved logins is a fail-closed outcome (the route layer
 * answers 409); a partially-mapped tenant proceeds on resolved logins
 * only, with the unmapped members disclosed in every response and in
 * the audit record.
 *
 * This module performs no I/O beyond the injected lookup/session
 * functions, so the resolution rules are unit-testable without a DO.
 */

import type { Membership } from "./authorization";
import { parseSessionRegistryEntries } from "./iaaaSessionRegistry";

export interface TenantMemberResolution {
  internalUserId: string;
  /** Sorted, deduped logins (alias union session) for this member. */
  logins: string[];
  unmapped: boolean;
}

export interface TenantQueueResolution {
  tenantId: string;
  members: TenantMemberResolution[];
  /** Sorted, deduped logins across all resolved members. */
  resolvedLogins: string[];
  unmappedMembers: string[];
  zeroResolved: boolean;
}

/** Tenant ids are opaque non-empty tokens: no whitespace, bounded length. */
export function isTenantIdShaped(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 512 &&
    !/[\s\x00-\x1F\x7F]/.test(value.trim())
  );
}

/** Distinct tenant ids across all membership records, sorted. */
export function listTenantIds(memberships: Membership[]): string[] {
  const ids = new Set<string>();
  for (const membership of memberships) {
    if (typeof membership.tenantId === "string" && membership.tenantId !== "") {
      ids.add(membership.tenantId);
    }
  }
  return [...ids].sort();
}

/**
 * Distinct internalUserIds holding a non-revoked membership record for
 * the tenant, sorted. Revocation is the membership status; there is no
 * separate retired state.
 */
export function tenantMemberIds(
  memberships: Membership[],
  tenantId: string,
): string[] {
  const ids = new Set<string>();
  for (const membership of memberships) {
    if (membership.tenantId !== tenantId) continue;
    if (membership.revokedAtMs !== undefined) continue;
    if (typeof membership.internalUserId !== "string") continue;
    if (membership.internalUserId === "") continue;
    ids.add(membership.internalUserId);
  }
  return [...ids].sort();
}

export interface ResolveTenantLoginsInput {
  memberships: Membership[];
  tenantId: string;
  /** Alias lookup: internalUserId -> verbatim login, or null. */
  lookupLogin: (internalUserId: string) => Promise<string | null>;
  /** Raw sessions-namespace listing entries (parsed here, fail-silent per entry). */
  sessionEntries: Array<{ key: string; value: string }>;
}

/**
 * Resolve a tenant to its members' logins. Pure over the injected
 * functions: no KV, no DO, no network. Corrupt session entries are
 * skipped by the registry parser, never fatal.
 */
export async function resolveTenantLogins(
  input: ResolveTenantLoginsInput,
): Promise<TenantQueueResolution> {
  const memberIds = tenantMemberIds(input.memberships, input.tenantId);
  const sessionByUser = new Map<string, Set<string>>();
  for (const entry of parseSessionRegistryEntries(input.sessionEntries)) {
    if (entry.internalUserId === undefined) continue;
    let logins = sessionByUser.get(entry.internalUserId);
    if (!logins) {
      logins = new Set<string>();
      sessionByUser.set(entry.internalUserId, logins);
    }
    logins.add(entry.githubLogin);
  }

  const members: TenantMemberResolution[] = [];
  const allLogins = new Set<string>();
  const unmappedMembers: string[] = [];
  for (const internalUserId of memberIds) {
    const logins = new Set<string>();
    const aliasLogin = await input.lookupLogin(internalUserId);
    if (aliasLogin !== null && aliasLogin !== "") logins.add(aliasLogin);
    for (const sessionLogin of sessionByUser.get(internalUserId) ?? []) {
      logins.add(sessionLogin);
    }
    const sorted = [...logins].sort();
    for (const login of sorted) allLogins.add(login);
    if (sorted.length === 0) unmappedMembers.push(internalUserId);
    members.push({
      internalUserId,
      logins: sorted,
      unmapped: sorted.length === 0,
    });
  }

  const resolvedLogins = [...allLogins].sort();
  return {
    tenantId: input.tenantId,
    members,
    resolvedLogins,
    unmappedMembers,
    zeroResolved: resolvedLogins.length === 0,
  };
}
