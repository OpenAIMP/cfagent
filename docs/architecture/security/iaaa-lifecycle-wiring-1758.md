# IAAA lifecycle wiring (#1758, #1717 program)

## Agent #CISO-bhdm

## What was unwired, and what this slice wired

Source rows F-14, F-15, F-16, F-17, and F-21 partial. Re-verified
on fresh main (`c53f450a`) before building; two scan claims had
already moved, and were recorded, not rebuilt:

- **Already wired — approvals (#1274).** The access-request
  create / list / decide routes in `src/server.ts` already call
  `grantMembership` on approval, and the panel already had
  approve/deny buttons. This slice does not rebuild that flow.
  What it adds is the *direct* admin grant route, for grants
  without a request.
- **Already wired — panel decide actions (#1274).** The panel
  was not purely read-only on arrival: access-request decisions
  were mutations. What was still read-only was memberships
  themselves (no grant/revoke/edit, no list-all). This slice
  wires exactly that remainder.

## New surfaces

### Session registry (F-16)

- `src/security/sessionStore.ts`: the SessionStore DO `list` op
  now allows the `sessions` namespace (previously E*TRADE tokens
  only). The DO performs no authorization — it is reachable only
  through the Worker's internal stub fetch — so every list caller
  must be a server code path whose route gates the read. No new
  list caller may be added without a route-level gate review.
- `src/security/iaaaSessionRegistry.ts`: pure parsing/filtering
  over a supplied listing. Non-UUID keys (membership, binding,
  audit, access-request keys share the namespace) and corrupt
  values are skipped, never mistaken for sessions.

### Offboard + verify (F-15/F-16/F-17)

- `src/security/iaaaLifecycleWiring.ts`: `runOffboard()` over
  injected ports. It discovers sessions from the registry (the
  caller never supplies ids), revokes them through the
  `lifecycle.ts` core policy (memberships, delegations), revokes
  API keys and E*TRADE tokens for the logins those sessions
  reveal, records mail suppression, emits one audit event, and
  then re-reads every store. `verified` is true only when the
  re-read proves nothing revocable remains; a response is still
  returned (200 with the report) when verification fails, so the
  failure is visible instead of hidden behind a 500.

### Routes (all in `src/server.ts`, one block)

| Route | Gate |
| --- | --- |
| `POST /api/iaaa/membership/grant` | Session + wired; per-binding `evaluateWithObligations(role:assign)` (step-up + audit-before-allow), then `grantMembership` (canGrantRole re-enforced). Self-grant always 403. |
| `POST /api/iaaa/membership/revoke` | Session + wired; tenant memberships via `evaluateWithObligations(membership:revoke)`; platform-scope memberships via live platform-admin + audit-before-revoke (see below). Revoke does not delete sessions (#1750 semantics). |
| `POST /api/iaaa/membership/edit` | Session + wired; grant-new-then-revoke-old; self-edit always 403; a failed revoke is reported (`oldRevoked: false`), never hidden. |
| `GET /api/iaaa/memberships` | Session + wired; platform-admin (all) or tenant-admin granter (own tenant). Backed by the sessions-namespace `iaaa-membership:` listing. |
| `POST /api/iaaa/deactivate` | Session + wired; body must be exactly `{ confirm: "deactivate" }`; always targets the caller's own identity; clears the session cookie. |
| `POST /api/iaaa/offboard` | Session + wired; platform-admin or tenant-admin granter; `internalUserId` and/or `login` required. |

### Panel

`src/client/IaaaAdminPanel.tsx` gains a Members tab (list, grant
form, per-row revoke/edit) and a two-click self-deactivation
control on the Overview tab. The audit/catalog tabs stay
read-only. The client never decides authorization.

## Security decisions (read before extending)

- **No self-grant, no exceptions.** Grant and edit refuse any
  target equal to the caller, for any role, even one already
  held. Elevation of oneself goes through another admin.
- **Platform-admin is not a tenant superuser.** Slice 3 policy:
  a platform-admin grants platform-scope roles only; a
  tenant-admin grants tenant/workspace roles only. The panel's
  platform-admin gate therefore does not by itself authorize
  tenant grants — the caller must hold the granting role in
  scope. This preserves existing policy; it does not widen it.
- **Platform-scope revoke exception, documented.** The PDP
  grants platform-admin no `membership:revoke`, so a
  platform-scope revoke cannot pass the obligation channel's PDP
  step. It is instead gated on live platform-admin membership
  plus a wired audit record written *before* the revoke, failing
  closed on audit failure. Tenant memberships always use the
  obligation channel. Do not "fix" this by adding
  `membership:revoke` to the platform-admin grant set without a
  separate policy decision — that would change Slice 3 policy.
- **Step-up is real for grants.** `role:assign` carries the
  step-up obligation (15-minute freshness). A legacy session has
  no `authTimeMs` and fails closed; a stale wired session must
  re-authenticate. This is intended, not a bug to work around.
- **Offboard responses are 200 with a report, not 500 on
  verification failure.** The revocation already happened; the
  caller must check `verified` and `residuals`, not just status.
- **A null session listing fails closed (500).** Offboarding
  against an empty list when the DO cannot be listed would claim
  success over unseen sessions. The same fail-closed rule
  applies to the E*TRADE token re-read (unknown = present).

## Named residuals (explicit, not silent)

1. **No durable delegation store in production.**
   `delegation.ts` ships a memory store only, so production
   offboards report the delegations step as not-applicable and
   name it in `residuals`. When a durable delegation store lands,
   the route must pass it instead of `null`.
2. **Mail suppression is a flag, not yet a sender gate.** The
   offboard records `iaaa-mail-suppression:<internalUserId>` and
   exports `isMailSuppressed()` as the check, but existing mail
   send paths do not yet consult it. No mail path was modified
   in this slice; the next sender wiring must call the check.
3. **Legacy sessions and login transfer.** A legacy session
   (no `internalUserId`) is revoked when its login matches a
   login the principal's wired sessions reveal (or an admin
   login hint). If a login was transferred to a different person
   after that session was created, that session is revoked with
   the offboard. Sessions expire within 7 days, which bounds
   the window; the audit event records actor and logins.
4. **Legacy sessions cannot self-deactivate.** Deactivation
   requires a wired session (Slice 1 identity). A legacy holder
   re-logs in through wiring and then deactivates, uses
   `/auth/logout`, or is offboarded by an admin (login hint).
5. **Queued work and active tasks are not cancelled.**
   Revocation removes authority; it does not stop already-running
   work (the `lifecycle.ts` stated scope, carried here).
6. **Upstream E*TRADE revocation is best-effort inside the
   stored-token deletion.** The production adapter calls
   `revokeRemoteAccessToken`, which deletes stored tokens even
   when the upstream call fails. Stored tokens are therefore
   always dead locally after a successful offboard; an upstream
   failure does not resurrect them, and is visible only through
   the E*TRADE service's own logging, not this report.
7. **Membership-edit is grant + revoke, not an atomic edit.**
   The store has no binding-level edit; if the revoke half
   fails after a successful grant, the principal holds both
   records and the response says so (`oldRevoked: false`).
8. **Cross-isolate session cache staleness (≤ 60 s).** A
   revoked session's cached copy in another isolate is denied
   only after the isolate-cache TTL lapses (the #1750 bound).
   Offboard invalidates the cache in its own isolate only.
9. **Panel membership list is admin-only by construction.**
   Non-admin self-service deactivation is route-only: there is
   no account-settings surface for non-admin users in this
   slice. The route + client helper (`deactivateSelf`) exist;
   a non-admin UI surface is future work, not a missing route.

## Tests

- `tests/iaaa_lifecycle_wiring_1758.test.ts` (7 tests): registry
  parsing/filtering, bulk revocation without caller-supplied
  ids, full checklist + verify, verify-failure visibility,
  delegations residual, suppression round-trip.
- `tests/iaaa_lifecycle_routes_1758.test.ts` (11 tests):
  grant / self-grant / gates / platform-vs-tenant scope, revoke /
  list / edit, deactivate confirmation + full effect + cookie
  clear, offboard via registry + gates.
- Pins updated in this PR per the §7 pin rule (not deleted):
  `tests/iaaa_admin_tabs.test.tsx` — Members tab joins the tab
  list (6 tabs) and tab indices shift by one.
- `tests/fake-session-store.ts` gains the `list` op mirroring
  the real DO rule (sessions namespace + E*TRADE tokens only),
  so route tests exercise the real listing path.
