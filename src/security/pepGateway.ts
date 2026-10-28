/**
 * #1755 (parent #1717) — the single PEP gateway PATTERN.
 *
 * Decision (recorded on #1755 before this build): the PEPs do NOT
 * collapse to a single runtime gateway — requireAuth (401 before
 * any permission is evaluated), the integration:connect gates
 * (session + tenant resolution + the #1749 legacy-grace rule),
 * and the schedule/access-request gates have irreducibly different
 * preconditions. What consolidates is the PATTERN: this one helper
 * implements the shouldEnforcePdp + permission + grace-expired-403
 * mapping that was copy-pasted, identically, at the four
 * integration:connect sites in src/server.ts (E*TRADE/Public start
 * + verifier), and all four sites now call it. Its outcomes map
 * byte-identically onto those blocks' responses:
 *   enforced:false            -> pre-change path, no response
 *   enforced:true, allowed    -> proceed
 *   enforced:true, denied, graceExpired:true  -> 403 legacy_pdp_grace_expired
 *   enforced:true, denied, graceExpired:false -> 403 authorization denied
 *
 * The helper decides through the PDP port (createInProcessPdp):
 * policy from the platform-only resolver (compiled by default;
 * a snapshot only when the platform configured one), attributes
 * from the membership store adapted to the PIP port. It performs
 * no enforcement itself and changes no decision — it only removes
 * the duplication between the four call sites.
 */

import {
  membershipStoreToAttributeProvider,
  type MembershipStore,
  type Permission,
} from "./authorization";
import {
  isLegacyPdpGraceExpired,
  shouldEnforcePdp,
} from "./iaaaGithubEndToEnd";
import {
  compiledPolicyProvider,
  createInProcessPdp,
  resolvePdpPolicySource,
  snapshotPolicyProvider,
} from "./pdpPorts";
import type { Env, SessionData } from "../types";

export type RoutePepOutcome =
  | { enforced: false }
  | { enforced: true; allowed: true }
  | { enforced: true; allowed: false; graceExpired: boolean };

export interface RoutePepInput {
  /** Worker env (IAAA_PDP_ENABLED + the platform-only policy switches). */
  env: Partial<Env> & {
    IAAA_PDP_POLICY_SOURCE?: unknown;
    IAAA_PDP_POLICY_SNAPSHOT_JSON?: unknown;
  };
  session: SessionData | null | undefined;
  tenantId: string;
  permission: Permission;
  membershipStore: MembershipStore;
  nowMs: number;
}

export async function evaluateRoutePep(
  input: RoutePepInput,
): Promise<RoutePepOutcome> {
  const { env, session, tenantId, permission, membershipStore, nowMs } = input;
  if (!shouldEnforcePdp(env, session, nowMs)) {
    return { enforced: false };
  }
  const graceExpired = isLegacyPdpGraceExpired(env, session, nowMs);
  if (!session?.internalUserId) {
    // Same as checkRoutePermission: no internal id, nothing to evaluate.
    return { enforced: true, allowed: false, graceExpired };
  }
  const resolved = resolvePdpPolicySource(
    env as unknown as Record<string, unknown>,
  );
  const pdp = createInProcessPdp({
    policyProvider:
      resolved.source === "snapshot" && resolved.snapshot
        ? snapshotPolicyProvider(resolved.snapshot)
        : compiledPolicyProvider(),
    attributeProvider: membershipStoreToAttributeProvider(membershipStore),
  });
  const decision = await pdp.decide({
    internalUserId: session.internalUserId,
    tenantId,
    permission,
    nowMs,
  });
  if (decision.decision === "allow") {
    return { enforced: true, allowed: true };
  }
  return { enforced: true, allowed: false, graceExpired };
}
