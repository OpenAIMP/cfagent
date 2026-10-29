/**
 * App-facing session surface.
 *
 * The `getSession` exported here is the **cached** read (see
 * `./security/sessionCache`), not the raw store read. This facade is what the
 * Worker imports, and `requireAuth` runs on every `/api/*` request, so routing
 * the app through the cached variant is what stops each request from spending
 * a session-store read (issue #329).
 *
 * The uncached primitive remains available from `./security/session` for code
 * that must observe the authoritative value rather than a value up to one TTL
 * old — for example re-checking a session immediately after a revoke.
 *
 * Note: `src/security/githubOAuth.ts` imports `./session` directly and keeps
 * its own authoritative read on logout — it pairs the delete with
 * `invalidateSessionCache(sessionId)`, so a logged-out session stops
 * authenticating in this isolate immediately.
 */
export {
  SESSION_TTL,
  SESSION_MAX_TTL,
  SESSION_RENEW_WINDOW,
  COOKIE_NAME,
  getSessionId,
  isSessionIdFormat,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  deleteSession,
  sessionRenewalDue,
  renewSession,
  renewSessionWithStore,
  createState,
  verifyState,
} from "./security/session";

export { getSessionCached as getSession } from "./security/sessionCache";
