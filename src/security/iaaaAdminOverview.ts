/**
 * #945 IAAA-UI v1 — read-only admin overview builder.
 *
 * What this module is: the single place that assembles the data for
 * GET /api/iaaa/overview from the existing stores, and the single
 * place that decides whether the caller may see it. It performs NO
 * store write of any kind (no put, append, grant, or revoke): the
 * route that calls it is GET-only, and v1 has no mutation path.
 *
 * Gating (fail-closed, server-side — the client never decides):
 * the caller must carry a wired session (internalUserId present;
 * legacy sessions have none) AND hold a live platform-admin
 * membership (role "platform-admin", scope "platform", not
 * revoked, not expired). Anything else gets { allowed: false }
 * with NO membership or audit data attached, so a 403 body can
 * never leak partial data.
 *
 * Trust assumption (documented, not hidden): the caller who passes
 * the gate IS a platform admin, so tenant-level audit data for the
 * resolved tenant is shown to them. Audit events are filtered to
 * the resolved tenant (tenantId === tenant) — a platform admin
 * still does not see other tenants' events from this route.
 *
 * Store limitations (read before extending this panel):
 * - There is NO list-all memberships API in MembershipStore
 *   (getMembershipsByUser only), so v1 shows the CALLER'S OWN
 *   memberships, not every user's. Cross-user listing needs a new
 *   store capability and is deliberately out of v1.
 * - The audit store is a single tenant-mixed log key
 *   (iaaa-audit:events) read in full and filtered in memory;
 *   at auth-event volume that is acceptable, but this route
 *   must NOT be used for per-request audit until a bounded
 *   backend exists (same limitation as the audit store itself).
 * - Membership/audit reads that throw (e.g. corrupt bytes, which
 *   the stores refuse to overwrite) propagate to the route,
 *   which answers 500 with a generic error and no partial data.
 * - The genesis marker is a single key per tenant
 *   (iaaa-bootstrap:platform-genesis:<tenant>); its presence
 *   means a platform-admin genesis has happened, not who holds
 *   the role — the membership list answers that.
 */

import type { Membership } from "./authorization";
import type { MembershipStore } from "./authorization";
import type { AuditStore, IaaaAuditEvent } from "./iaaaAudit";
import type { KvLike } from "./kvResilience";
import { platformGenesisMarkerKey } from "./iaaaGithubEndToEnd";

/** Max audit events returned, newest first. */
export const IAAA_ADMIN_OVERVIEW_LIMIT = 100;

export interface AdminOverviewDeps {
  membershipStore: MembershipStore;
  auditStore: AuditStore;
  /** SessionStore DO kv (for the genesis marker key read). */
  kv: KvLike;
  tenantId: string;
  nowMs: number;
}

export interface AdminOverviewInput {
  callerInternalUserId: string;
}

/** Audit event fields the panel shows — a subset of the store's own fields, nothing invented. */
export interface AdminAuditEventView {
  id: string;
  timestamp: number;
  type: string;
  actorPrincipalId: string;
  initiatingPrincipalId: string;
  action: string;
  decision: string;
  outcome: string;
  correlationId: string;
  resourceId?: string;
  errorCode?: string;
}

export type AdminOverviewResult =
  | { allowed: false }
  | {
      allowed: true;
      tenantId: string;
      callerInternalUserId: string;
      memberships: Membership[];
      genesis: { platformGenesisOccurred: boolean };
      recentAuditEvents: AdminAuditEventView[];
    };

/**
 * Live platform-admin test, same semantics as the end-to-end
 * module's holdsPlatformAdmin (which is module-private): a
 * platform-scoped platform-admin binding that is neither revoked
 * nor expired. Platform scope is platform-wide, not tenant-scoped,
 * so the membership's tenant does not restrict this test; the
 * audit filter below is what scopes events to the tenant.
 */
export function isPlatformAdmin(memberships: Membership[], nowMs: number): boolean {
  return memberships.some((m) =>
    m.roleBindings.some(
      (b) =>
        b.role === "platform-admin" &&
        b.scope === "platform" &&
        m.revokedAtMs === undefined &&
        (b.expiresAtMs === undefined || b.expiresAtMs > nowMs),
    ),
  );
}

function toEventView(event: IaaaAuditEvent): AdminAuditEventView {
  const view: AdminAuditEventView = {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    actorPrincipalId: event.actorPrincipalId,
    initiatingPrincipalId: event.initiatingPrincipalId,
    action: event.action,
    decision: event.decision,
    outcome: event.outcome,
    correlationId: event.correlationId,
  };
  if (event.resourceId !== undefined) view.resourceId = event.resourceId;
  if (event.errorCode !== undefined) view.errorCode = event.errorCode;
  return view;
}

/**
 * Assemble the overview or refuse it. Reads only; throws only
 * when an underlying store read throws (corrupt evidence), in
 * which case the route answers 500 with no partial data.
 */
export async function buildAdminOverview(
  deps: AdminOverviewDeps,
  input: AdminOverviewInput,
): Promise<AdminOverviewResult> {
  const memberships = await deps.membershipStore.getMembershipsByUser(input.callerInternalUserId);
  if (!isPlatformAdmin(memberships, deps.nowMs)) {
    return { allowed: false };
  }
  const allEvents = await deps.auditStore.list();
  const recentAuditEvents = allEvents
    .filter((event) => event.tenantId === deps.tenantId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, IAAA_ADMIN_OVERVIEW_LIMIT)
    .map(toEventView);
  const marker = await deps.kv.get(platformGenesisMarkerKey(deps.tenantId));
  return {
    allowed: true,
    tenantId: deps.tenantId,
    callerInternalUserId: input.callerInternalUserId,
    memberships,
    genesis: { platformGenesisOccurred: marker !== null },
    recentAuditEvents,
  };
}
