/**
 * Issue #1185: the fail-closed identity response for extracted route
 * handlers.
 *
 * Route handlers receive the authenticated login only via the
 * `x-user-login` header, which src/server.ts sets from the verified
 * session (and strips for anonymous traffic). There is no fallback
 * identity: when the header is absent the handler must refuse with
 * this 401 rather than substitute the Orchestrator instance id or any
 * synthetic login (the pre-#1185 fallback chains this removal
 * deleted). The body matches the routes/schedules.ts precedent.
 */
export function unauthenticatedResponse(): Response {
  return Response.json(
    { success: false, error: "An authenticated E*TRADE account is required." },
    { status: 401 }
  );
}
