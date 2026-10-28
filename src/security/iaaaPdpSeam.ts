/**
 * #945 Wiring Phase 2b-part2 — PDP seam (NOT enforcement).
 *
 * This module answers one question — "does this internalUserId hold
 * this permission in this tenant?" — by reading memberships from a
 * MembershipStore and running Slice 3's authorize() PDP. It exists
 * so the later route-wiring step has a single, tested call site to
 * attach to, instead of each route re-deriving the check.
 *
 * It is deliberately NOT called from any route, job, tool, or
 * handler in this slice. Wiring it into a route now would deny
 * requests for users who have no memberships yet — legitimate
 * workflows that predate membership provisioning — which is
 * exactly what epic §8 forbids before migration + provisioning
 * exist. Route enforcement is a later, separately reviewed step;
 * grepping for checkPermission callers must return only tests and
 * this module's own definition until that step lands.
 *
 * Default-deny is inherited from Slice 3, not re-implemented here:
 * unknown permissions, missing memberships, revoked memberships,
 * cross-tenant requests, and scope/resource mismatches all deny.
 * Identity is always the Slice 1 internal user id; a login is
 * never an input to this function.
 */

import {
  authorizeWithPolicy,
  getCompiledPolicySnapshot,
  membershipStoreToAttributeProvider,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type MembershipStore,
} from "./authorization";

export interface CheckPermissionInput {
  internalUserId: string;
  tenantId: string;
  permission: AuthorizationRequest["permission"];
  scope?: AuthorizationRequest["scope"];
  resourceScope?: AuthorizationRequest["resourceScope"];
  nowMs: number;
}

/**
 * PDP decision for one permission check. Allow iff Slice 3 allows.
 * #1755: signature unchanged; internally the check now routes
 * through the PIP port (store adapted to a provider) and the
 * compiled policy snapshot, so the seam consumes the same PDP core
 * as the port-based callers. Decisions are identical.
 */
export async function checkPermission(
  store: MembershipStore,
  input: CheckPermissionInput,
): Promise<AuthorizationDecision> {
  return authorizeWithPolicy(
    getCompiledPolicySnapshot(),
    membershipStoreToAttributeProvider(store),
    {
      actorInternalUserId: input.internalUserId,
      tenantId: input.tenantId,
      permission: input.permission,
      scope: input.scope,
      resourceScope: input.resourceScope,
      nowMs: input.nowMs,
    },
  );
}
