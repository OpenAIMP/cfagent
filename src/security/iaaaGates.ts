/**
 * #945 Wiring Phase 2b-part1 — small gating predicates for live call sites.
 *
 * This module is deliberately a LEAF: it imports only
 * iaaaSessionActivity (which imports sessionPolicy) and types, so
 * it can be imported from githubOAuth.ts without creating the
 * cycle that importing providers.ts (or iaaaLogin.ts) there would
 * cause — providers.ts imports githubOAuth.ts, and iaaaLogin.ts
 * imports githubOAuth.ts too.
 *
 * Both predicates encode the same rule: wiring OFF means the
 * legacy behaviour, unconditionally. Every gate is fail-closed
 * when its inputs are missing, and no default tenant is ever
 * invented.
 */

import { sessionRequiresStepUp } from "./iaaaSessionActivity";
import type { SessionData } from "../types";

/**
 * Logout-audit gate. Returns the tenant to attribute to, or null
 * when nothing must be recorded. Null whenever wiring is off, the
 * session has no internalUserId, or the tenant id is unset/blank.
 * A caller that gets null records nothing — it must NOT fall back
 * to a default tenant, because that would fabricate attribution.
 */
export function logoutAuditTenant(input: {
  wiringEnabled: boolean;
  internalUserId?: string;
  tenantId?: string;
}): string | null {
  if (!input.wiringEnabled) return null;
  if (!input.internalUserId) return null;
  const tenant = input.tenantId?.trim();
  return tenant ? tenant : null;
}

/**
 * Step-up gate for the API-key mint pilot (POST /api/api-keys).
 * Wiring OFF never requires step-up; wiring ON fails closed: a
 * session without a fresh authTimeMs (including every legacy
 * session) must re-authenticate before minting a credential.
 * Listing and revoking keys are NOT gated by this predicate.
 */
export function requiresStepUpForMint(
  session: SessionData,
  wiringEnabled: boolean,
  nowMs: number,
): boolean {
  if (!wiringEnabled) return false;
  return sessionRequiresStepUp(session, nowMs);
}
