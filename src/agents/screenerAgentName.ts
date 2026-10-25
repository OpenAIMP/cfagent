/**
 * ScreenerAgent instance naming (extracted from orchestrator.ts under
 * the #992 size budget; issue #1185 naming rules).
 *
 * Instances are per-owner: `screener:<login>`. The bare "default" name
 * is where the pre-multi-user shared agent's live state sits, so it
 * belongs to the configured service identity — the only login that
 * maps to it — and is never orphaned or reassigned.
 */
import type { Env } from "../types";
import { getServiceUserLogin } from "../security/serviceIdentity";

export function screenerAgentName(
  userLogin: string,
  serviceUserLogin?: string | null
): string {
  return serviceUserLogin && userLogin === serviceUserLogin
    ? "default"
    : `screener:${userLogin}`;
}

/**
 * Resolve the ScreenerAgent instance name for a dispatch: the explicit
 * owner login when given, else the configured service identity (the
 * only legitimate unattended identity). Fail closed when neither
 * exists — there is no synthetic shared identity to route to.
 */
export function resolveScreenerAgentName(env: Env, userLogin?: string): string {
  const serviceLogin = getServiceUserLogin(env);
  const owner = userLogin || serviceLogin;
  if (!owner) {
    throw new Error(
      "ScreenerAgent dispatch requires a user login or a configured service identity (issue #1185: no default identity)."
    );
  }
  return screenerAgentName(owner, serviceLogin);
}
