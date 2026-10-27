# API security

How the HTTP surface is protected: dispatch order, per-route gating, API
keys, and the docs routes. The underlying identity and authorization
models are in [authn.md](authn.md) and [authz.md](authz.md).

## 1. Dispatch order is a security property

The worker's `handleFetch` does not treat routes equally. Order matters,
and it is deliberate:

1. **Static assets first.** The asset layer serves files before any
   session check (`serveStaticAsset`, `src/security/staticAssets.ts`).
   The `run_worker_first` list is exactly `["/", "/index.html"]`: only
   those paths invoke the Worker for unauthenticated visitors (to render
   the landing page). Everything else under the asset layer never reaches
   auth code — which is why strategy pages in `public/strategies/` are
   public by deployment, not by policy (see §5).
2. **Public routes before auth.** A2A agent-card GETs
   (`/.well-known/agent-card.json`, `/.well-known/agent.json`) are routed
   before authentication, by design: discovery is public.
3. **Session-gated routes.** The bulk of `/api/*`, the OAuth routes, and
   the admin overview go through `requireAuth` and, where applicable,
   the PDP.
4. **The generic `/api/*` forwarder last.** Anything not matched earlier
   falls to the forwarder, which is itself session-gated — an unmatched
   path is not an unauthenticated path.

A future framework adapter must preserve this order exactly (see the
#1024 conformance-suite idea): a route that moves above the session
check in a refactor has silently become public.

## 2. Per-route gating, as it stands

| Surface | Gate |
| --- | --- |
| E*TRADE link start + verifier | Session + PDP `integration:connect` (wired, PDP on) |
| E*TRADE status / renew | Session, own login only |
| E*TRADE revoke | Session, deliberately ungated (safety action) |
| `GET /api/iaaa/overview` | Platform-admin, server-side; 401/403/500 per §6 of [authz.md](authz.md) |
| `GET /api/me` | Deliberate quirk: returns `{authenticated: false}` without a session (HTTP 200), and the caller's own `internalUserId` only for wired sessions |
| `/openapi.json`, `/api/docs` | Provisional spike gating: authenticated session required (401 otherwise, 405 non-GET). The final `DOCS_PUBLIC_SURFACES` decision is still open (#1024) |
| Generic `/api/*` forwarder | Session-gated; downstream DO checks apply per route |
| WebSocket routes (`/voice/trade`, market-data quote streams) | Session handling at upgrade; they do not map cleanly onto framework middleware and stay in `handleFetch` during any strangler migration |

Per-route throttling exists as a helper in the worker dispatch; it is a
load control, not an authorization control, and must not be cited as one.

## 3. API keys

API keys are the non-session credential for programmatic access (notably
the MCP transport — see [mcp-security.md](mcp-security.md)):

- **Mint is step-up gated.** Creating a key requires a fresh
  authentication; stale and legacy sessions get a 403 until they
  re-login. Minting is the one key operation where freshness is the gate.
- **List and revoke are deliberately ungated** by step-up: revocation
  must never be blocked by the freshness rule it escapes from.
- Keys are bearer-equivalent: possession is access within the key's
  scope, so key storage and rotation are the owner's responsibility, and
  a leaked key is revoked, not "fixed" by policy.

## 4. Errors must not leak

The Worker entrypoint is wrapped in `withErrorBoundary`: an escaped throw
becomes a real 5xx with a machine-readable code, never a Cloudflare edge
error page and never a stack trace to the visitor. Corrupt-store paths
return generic 500s (the admin overview is the worked example). Error
codes are externalized (`src/aspects/errorCodes.ts`) so a message never
has to carry internals to be actionable.

## 5. Already-public surfaces (not vulnerabilities, but not secrets)

These are public and must not be treated as protected by obscurity:

- The landing page (server-rendered for unauthenticated visitors).
- A2A agent cards (GET only; A2A POST invocation requires Bearer
  `A2A_API_TOKEN` at the edge — verified from the entrypoint in
  #1763, see [mcp-security.md](mcp-security.md) §4).
- Strategy pages (`public/strategies/`): already public via the asset
  layer. True privacy for them needs removing them from output or adding
  them to `run_worker_first` plus a guard — a worker variable alone
  cannot gate them as deployed.
- The McpApiExplorer catalog ships in the client bundle: hiding its tab
  is not secrecy (see [mcp-security.md](mcp-security.md)).

If any of these ever carries sensitive content, the fix is to move it
behind a gate — not to assume nobody noticed it is public.
