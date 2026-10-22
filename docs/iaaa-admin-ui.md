# IAAA admin UI — read-only v1 (issue #945)

## Agent #ceo-aimp

## What the panel shows

The **IAAA Admin** section (in the settings menu, next to API Keys)
renders `GET /api/iaaa/overview`:

- **Tenant** — the resolved tenant (`IAAA_TENANT_ID` else the
  documented default `"primary"`, same resolution as the GitHub
  end-to-end slice).
- **Your roles** — the caller's own role bindings (e.g.
  `platform-admin (platform)`).
- **Platform genesis** — whether the platform-genesis marker key
  exists for the tenant (i.e. a genesis grant has happened).
- **Recent audit events** — the tenant's audit events, newest
  first, capped at 100, showing time, action, decision, outcome,
  and correlation id.

## The gating rule (server-side, never client-side only)

The route is fail-closed:

- No session → `401`.
- Legacy session (no `internalUserId`) → `403`, no data.
- Wired session without a live platform-admin membership
  (role `platform-admin`, scope `platform`, not revoked, not
  expired) → `403`, no data.
- Wired session with a live platform-admin membership → `200`.

The client only renders what the server returns; on `403` it
shows a plain "not an admin" state and fetches nothing else.

## Read-only limitation

v1 cannot change anything: there is no grant, revoke, or
membership-edit UI, and no mutation endpoint exists behind the
panel. The server route is `GET`-only and the builder performs
no store write.

## Trust assumption

A caller who passes the gate **is** a platform admin, so
tenant-level audit data for the resolved tenant is shown to
them. Audit events are filtered to the resolved tenant — other
tenants' events are never returned by this route.

## Store limitations (why the panel shows what it shows)

- `MembershipStore` has no list-all API (`getMembershipsByUser`
  only), so v1 shows the **caller's own** memberships, not every
  user's. Cross-user listing needs a new store capability.
- The audit store is a single tenant-mixed log key read in full
  and filtered in memory; acceptable at auth-event volume, but
  this route must not be used for per-request audit until a
  bounded backend exists.
- A corrupt membership/audit read answers `500` with a generic
  error and no partial data (the stores refuse to overwrite
  corrupt evidence).

## How to extend it (mutations later)

1. Add a mutation endpoint per action (grant/revoke) behind the
   same platform-admin gate, enforcing Slice 3's `canGrantRole`
   rule server-side (a tenant admin must never grant platform
   privileges).
2. Add a list-all memberships capability to the store first —
   do not scan key prefixes from the route.
3. Keep the read path and the write path in separate modules so
   the read-only guarantee of this panel stays reviewable.
4. Add client controls only after the server endpoints exist
   and are tested with the same gating matrix as v1.
