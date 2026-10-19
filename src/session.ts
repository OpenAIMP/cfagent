/**
 * App-facing session surface.
 *
 * The `getSession` exported here is the **cached** read (see
 * `./security/sessionCache`), not the raw KV read. This facade is what the
 * Worker imports, and `requireAuth` runs on every `/api/*` request, so routing
 * the app through the cached variant is what stops each request from spending
 * a Workers KV read (issue #329).
 *
 * The uncached primitive remains available from `./security/session` for code
 * that must observe the authoritative value rather than a value up to one TTL
 * old — for example re-checking a session immediately after a revoke.
 *
 * Note: `src/security/githubOAuth.ts` imports `./session` directly, so logout
 * still bypasses this facade. Until its `env.SESSIONS.delete(sessionId)` is
 * paired with `invalidateSessionCache(sessionId)`, a logged-out session can
 * keep authenticating in this isolate for up to one TTL.
 */
export {
  SESSION_TTL,
  COOKIE_NAME,
  getSessionId,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  deleteSession,
  createState,
  verifyState,
} from "./security/session";

export { getSessionCached as getSession } from "./security/sessionCache";
