# OpenAPI + Swagger spike (issue #1024 Phase 1)

No framework change. The hand-rolled router in `src/server.ts` stays;
this spike only DESCRIBES it, to prove the spec-generation half of the
#1024 design before any adapter decision.

## What is served

- `GET /openapi.json` — the generated OpenAPI 3.0.3 document as JSON.
- `GET /api/docs` — a small HTML page loading Swagger UI from CDN
  (`cdn.jsdelivr.net`, swagger-ui-dist@5) with `url=/openapi.json`.

Both routes live in `src/server.ts` immediately before the generic
`/api/` forwarder, so `/api/docs` is not forwarded to the DO.

## Generation

`src/security/openapiSpec.ts` (`buildOpenApiSpec()`) builds the document
from the IAAA-UI API catalog (`src/client/iaaaEndpointCatalog.ts`):
one path item per catalog HTTP endpoint, aliases as their own path
items, methods and gating notes carried over as description text.
The catch-all `/api/*` forwarder and the static-asset pre-route are
excluded (they are not endpoints). WebSocket routes are listed with
an `x-transport: websocket` marker and no invented REST operation.

- `info.version` is `1.0.0` from `package.json` (the repo's version marker).
- `servers` is the production origin `https://agent.openaimp.com`.
- Session auth is described by a `sessionCookie` scheme (cookie
  `session_id`, per `src/security/session.ts` COOKIE_NAME).

## Provisional gating (NOT the final design decision)

Both routes require an authenticated session: unauthenticated → 401,
non-GET → 405. This is the safe spike default. The #1024 decision on
docs exposure (public vs gated vs per-surface visibility) is still
open; do not treat this gate as decided. The spec contains no user
data and the docs page contains no user data.

## Pilot scope — hand-written schemas

Schemas were written only for the pilot set, with shapes read from the
route handlers (not guessed):

- `GET /api/me` → `MeResponse`: `authenticated` required; `login` /
  `name` / `avatar` present only when authenticated; `internalUserId`
  only for wired sessions. Unauthenticated callers get
  `{ authenticated: false }` with HTTP 200 (this handler does not 401).
- `GET /health` (+ `/api/health` alias) → `HealthResponse`, including
  the `telemetry` object.
- `GET /api/iaaa/overview` → `IaaaOverviewResponse` (with `Membership`,
  `RoleBinding`, `AdminAuditEventView` components), plus the 401 / 403 /
  405 / 500 error responses the handler returns.

Method note on the pilot set: the `/api/me` and `/health` handlers do
not restrict the method (catalog method `ANY`). GET is documented as
the contract because `/health` is fetched with GET by
`scripts/qa-smoke.mjs` and `/api/me` is read with a browser GET by the
owner (activation flow). No other method is claimed for them.

## Not yet specified — the honest state for everything else

Every non-pilot path carries the marker
`schema: not yet specified (spike pilot coverage)` in its description,
and its 200 response has no content schema. Two catalog facts the
generator had to handle, now pinned by tests:

- Two catalog entries can share one path (GET + POST
  `/api/schedule/goals`; list + mint `/api/api-keys`). The generator
  merges operations into one path item; each operation keeps its own
  entry's gating note.
- The spec test pins catalog coverage: every `path ===` /
  `path.startsWith` / `path.match` literal in `server.ts` must be
  covered by the catalog, so a new route without a catalog entry fails
  (inherited from the IAAA-UI v2 pin test).

## Spike findings (CDN, layering)

- No worker Content-Security-Policy was found (grep over `src/` at
  spike time), so CDN loading is not blocked today. If a CSP is added
  later, `cdn.jsdelivr.net` must be allowlisted for scripts, styles,
  and fonts, or `/api/docs` breaks. Nothing is vendored.
- Layering smell, accepted for the spike only: the server-side
  generator imports a client-side catalog module. That module imports
  only pure data (`mcpEndpointsData.ts` has no component or CSS
  imports), so the worker bundle is unaffected — but the #1024 design
  should give the catalog a shared home instead of a client import.
- Swagger UI is configured with `withCredentials: true` so the
  same-origin session cookie is carried on spec fetches and try-it
  requests. Without a live session, try-it gets 401s — the correct
  fail-closed behavior under the provisional gate. Browser smoke
  verification of the rendered UI is still owed (not verifiable from
  unit tests alone).

## How to extend to full coverage

1. Write a response schema per endpoint from its handler (same
   read-the-handler rule as the pilot set; never infer from a name).
2. Remove the marker from that path only, and add the schema's
   component (or inline it for one-off shapes).
3. When the catalog moves to a shared home, repoint the generator's
   import — the generator takes catalog entries, so no other change
   is needed.
4. When the #1024 docs-exposure decision lands, replace the
   provisional session gate on the two routes with the decided rule
   and update the route comments, the spec descriptions, and this doc
   together.
