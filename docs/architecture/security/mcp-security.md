# MCP security

How the Model Context Protocol surface — and the adjacent agent-to-agent
surface — is protected, and where its protection differs from the web
API's.

## 1. The transport rule: session OR API key, nothing else

The MCP transports (`/mcp` and `/api/mcp`) accept **either** a valid
session **or** a valid API key. That fallback is custom code in the worker
dispatch, deliberately kept out of any framework adapter: it is a security
decision, not middleware, and a framework migration must preserve it
exactly (same inputs, same fallback order, same failure mode).

Consequences:

- An MCP caller with neither credential gets nothing; there is no
  anonymous MCP access.
- An API key used over MCP carries exactly the key's authority — see
  [api-security.md](api-security.md) §3 for mint/revoke rules.
- MCP authorization rides the same session and membership machinery as
  the web routes where a route is gated; where it is not gated, that
  absence is a property of the tool, not of the transport.

## 2. The catalog is not the transport

The MCP catalog (30 tools, 8 resources, 4 prompts, plus 35 REST entries)
is published in the client bundle through `McpApiExplorer` and
`src/client/mcpEndpointsData.ts`. Two facts follow, and both are routinely
confused:

1. **The catalog is public knowledge.** It ships in JavaScript. Hiding
   the explorer tab, or gating the docs UI, does not hide what tools
   exist. The real gate is the transport's session/API-key check on every
   call.
2. **The catalog is not a complete inventory.** The IAAA panel reports
   18 MCP absences: scanner tools (`screen_options`, `scanner_status`,
   `get_scan_job`, `list_scan_jobs`) served by `/mcp/scanner` but absent
   from the catalog, plus 14 server command classes absent from it.
   Transport wiring cannot be verified from the catalog alone — an
   absent tool may still be callable, and a listed tool may be gated.
   The panel reports these as gaps rather than adding unverified
   entries, and this doc does the same.

## 3. The scanner exception

`/mcp/scanner` is intentionally unauthenticated. Its access control is
the x402 payment mechanism, not identity: payment is the gate. That is a
designed exception, not an oversight — but it means scanner abuse
analysis starts from payment records, not session records, and any change
to the x402 terms changes the scanner's security posture directly.
The full per-tool attribution verdicts, including the scanner
tools and the named gaps in scanner attribution, are in
[tool-attribution-audit-1763.md](tool-attribution-audit-1763.md) (#1763).

## 4. A2A: discovery is public, invocation auth is verified (#1763)

- **GET** on the agent cards (`/.well-known/agent-card.json`,
  `/.well-known/agent.json`) is public by design (see
  [api-security.md](api-security.md) §1).
- **POST** invocation auth is **verified from the entrypoint**
  (#1763, closing scan row F-25 and the open item carried from the
  #1024 analysis). The worker dispatch in `src/server.ts` routes
  `/a2a/*` to `src/a2a/index.ts` `handleA2A` before any session
  route, and `handleA2A` enforces, before agent resolution: a
  Bearer `A2A_API_TOKEN` compared timing-safely; an unset token
  fails closed with 503 (dispatch disabled, never unauthenticated);
  a missing or wrong token is 401 — including for unknown agents,
  so unauthenticated callers learn nothing about which agents
  exist. Evidence: `tests/a2a_entrypoint_auth_1763.test.ts` drives
  the worker's fetch export (the real `handleFetch` dispatch, not
  a direct `handleA2A` call — the pre-existing #291 A5 tests only
  covered the dispatcher in isolation) and asserts the DO stub is
  never reached without a valid token. What this does NOT claim:
  the shared token identifies the fleet/host caller, not a user —
  per-caller A2A attribution remains gap G-AUD-6 in the #1763
  tool-attribution audit (`tool-attribution-audit-1763.md`), and
  per-caller A2A identity is IAAA (#945) / #1024 design work, not
  a property of this token.

## 5. What to check before adding an MCP tool

1. Does it ride the session-or-API-key transport, or does it need its
   own gate? If its own gate, name the permission and the denial
   behavior.
2. Is it in the catalog? If not, say so in the panel gap list rather
   than letting the catalog silently under-report the surface.
3. Does it touch E*TRADE, keys, memberships, or audit? If yes, it
   inherits those docs' gates ([etrade.md](etrade.md),
   [authz.md](authz.md)) — the transport does not grant them.
4. Does it log enough to attribute a call to a session or a key? If a
   tool's calls cannot be attributed, that is a gap, not an acceptable
   default.
