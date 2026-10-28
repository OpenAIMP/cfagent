/**
 * Issue #1759 (#1717 slice) — provider-neutral login key and DID prefix.
 *
 * The pre-#1759 world derived every user DID as
 * `did:user:github:<login>` (getUserDid), so a Google session
 * rendered another provider's prefix in the UI (F-23). The fix is
 * NOT a relabelling: the DID's provider segment is resolved from
 * the session's own providerIssuer through the provider registry
 * (the same source /api/me uses for its provider field), never
 * from user input and never from a hardcoded default.
 *
 * Resolution rules (each is a deliberate non-merge choice):
 * - No providerIssuer (legacy session): the legacy GitHub
 *   derivation. Legacy sessions predate multi-provider login and
 *   are historically GitHub-only, so `github:` here is accurate,
 *   not cross-provider.
 * - Known issuer: that provider's id (`google:`, `github:`).
 * - Unknown issuer: `unknown:`. An unregistered issuer must never
 *   render as another provider, and must never fall back to
 *   github merely because github was first.
 *
 * Identity is unaffected: the DID is display/lookup text. The
 * authoritative identity remains the (issuer, subject) binding +
 * internalUserId; two providers with the same login key yield two
 * different DIDs and are never merged by this module.
 */
import { getLoginDid, getUserDid } from "../agents/did";
import { getProviderByIssuer } from "./providers";

export interface SessionDidInput {
  githubLogin: string;
  providerIssuer?: string;
}

export type ProviderIssuerResolver = (
  issuer: unknown,
) => { providerId: string } | null;

/**
 * The user DID to display for a session. The resolver parameter
 * exists so tests can substitute a fake registry; production
 * callers use the default (the real provider registry).
 */
export function getSessionDid(
  session: SessionDidInput,
  resolveProvider: ProviderIssuerResolver = getProviderByIssuer,
): string {
  if (!session.providerIssuer) {
    return getUserDid(session.githubLogin);
  }
  const provider = resolveProvider(session.providerIssuer);
  if (!provider) {
    return getLoginDid("unknown", session.githubLogin);
  }
  return getLoginDid(provider.providerId, session.githubLogin);
}
