/**
 * Issue #2402: client-side sign-in outcome helpers (pure, no store,
 * no DOM access beyond the URL string passed in).
 *
 * - signedInMessage: the one-time boot confirmation text, only for
 *   the success code with a display name. Anything else is null —
 *   the boot never invents a confirmation.
 * - stripAuthOutcomeParam: removes the outcome parameter from a URL
 *   string so a shown outcome is never reshown on refresh. Other
 *   parameters are preserved untouched.
 */
import { AUTH_OUTCOME_PARAM, parseAuthOutcome } from "../security/authOutcome";

export function signedInMessage(
  outcome: unknown,
  displayName: string | undefined
): string | null {
  if (parseAuthOutcome(outcome) !== "signed_in") return null;
  if (typeof displayName !== "string" || displayName.trim() === "") return null;
  return `Signed in as ${displayName}`;
}

export function stripAuthOutcomeParam(url: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const parsed = new URL(url, "https://auth-outcome.invalid");
  parsed.searchParams.delete(AUTH_OUTCOME_PARAM);
  if (absolute) return parsed.toString();
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
