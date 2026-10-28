# IAAA admin bootstrap, genesis, and the stranded-grant recovery (Oct 2026)

This records the October 2026 admin-bootstrap saga: how the owner's
platform-admin went missing, how it was diagnosed, and how it was fixed.
It exists so the reasoning is not re-derived from chat memory.
Related issues: #945 (IAAA epic), #1182 (stable identity),
#1196 (bootstrap config), #1197 (bare `v1:` entries),
#1208 (genesis marker reset), #1210 (repair migration).

## Identity and bootstrap primitives

- An internal user id is **derived**, not minted (since #1182):
  `v1:` + lowercase hex of SHA-256 over the normalized
  `(issuer, subject)` pair. Derivation runs in the shared wired-login
  tail, so it covers GitHub, Google, and future IdPs with zero
  per-provider code. Email is never identity; it is only a legacy
  login key.
- A bootstrap entry in `IAAA_BOOTSTRAP_ADMINS` (a `wrangler.jsonc`
  var) takes three forms:
  - a bare UUID (legacy minted ids),
  - a bare derived id, `v1:` + 64 lowercase hex characters
    (accepted since #1197; readable from `/api/me` after a wired
    login),
  - an issuer:subject pair, e.g. `https://github.com:82253453`,
    split at the *last* colon (issuers contain `://`).
- A `platform:` prefix marks a genesis entry (below). A plain entry
  grants tenant-admin in the resolved tenant (default `"primary"`).
- Identities are **per (issuer, subject) pair and are not linked
  across providers**. A GitHub login and a Google login are different
  identities with different derived ids, even for the same person.
  Bootstrap entries are therefore per-pair: a GitHub entry grants
  nothing to a Google login, and vice versa.

## The genesis rule

- The **first** `platform:` grant wins, per tenant. The window is
  tracked by a single marker key,
  `iaaa-bootstrap:platform-genesis:<tenantId>`, in SessionStore
  storage (Durable Object-backed). The marker records which internal
  id received the genesis grant.
- Once the marker is set, a `platform:` entry **degrades to
  tenant-admin** (status `genesis-closed-tenant-admin`). A user who
  already holds platform-admin is a no-op (`already-admin`).
- The IAAA admin panel requires **platform-admin**. Tenant-admin
  does not open it. The E*TRADE start/verifier gates require
  `integration:connect` **in the resolved tenant** — a platform
  binding never grants tenant permissions. So panel access and
  E*TRADE access are independent proofs: E*TRADE passing proves
  tenant-admin landed; it says nothing about platform-admin.
- Bootstrap runs on **every wired login** (GitHub and Google alike,
  via the shared login tail) and is best-effort: a failure never
  changes the login outcome, and its status is not surfaced to the
  user. A stale session never runs bootstrap — only a fresh
  logout/login does.
- The genesis marker lives in **SessionStore DO storage, not plain
  KV**. There is no dashboard flip for it. Any reset is a code
  change, not an ops action.

## The incident (Oct 2026)

1. Oct 22 activation set a bootstrap entry naming a minted internal
   id (the owner's then-current id, read from `/api/me`).
2. The owner's wired session id later changed to a different minted
   id. Code paths, subject derivation, and the store backend were
   unchanged since Oct 22, so the cause was environmental
   (deployment-store divergence or production store loss) and is
   **not verifiable from the repo**. The minted-UUID design was
   fragile to exactly this.
3. #1182 replaced minting with derivation. On login, migration
   moves the **current login's** memberships (all tenants) from
   the old id to the derived id, before bootstrap — and nothing
   else's. Memberships belonging to any *other* id are untouched.
4. #1196 replaced the retired minted entry with issuer:subject
   entries for the owner's GitHub identity
   (`platform:https://github.com:82253453` and
   `https://github.com:82253453`) and deployed.
5. The owner's fresh post-deploy GitHub login showed a derived
   `v1:` id and **E*TRADE connected** — proving the entries
   matched, the deploy was live, and tenant-admin had landed —
   while the panel still showed "Not an IAAA admin".
6. That combination is exactly the **genesis-closed branch**: the
   marker had already been set by the Oct 22 activation identity,
   so the `platform:` entry degraded to tenant-admin, and
   migration had moved only the current login's (empty)
   memberships. The platform-admin granted to the retired id was
   **stranded**: it exists, is active, and no login carries it.

## A corrected claim (recorded so it is not repeated)

An earlier claim in this saga said migration covers both outcomes
("either branch lands the owner with both"). That was wrong.
Migration moves only the logging-in identity's memberships. If
genesis fired for a *different, now-retired* identity, migration
cannot rescue that grant — the panel denial is the expected
outcome in that branch, not evidence that the entries or the
deploy failed.

## The fixes (both authorized; each no-ops if the other fixed it)

### #1208 — genesis marker reset in code

In the matched-genesis branch, before reading the marker, delete
the marker key if and only if: the logging-in user matches a
`platform:` entry, does not already hold platform-admin, and the
marker parses with `grantedTo` exactly equal to the retired
activation id (a documented one-time repair constant). The existing
genesis path then grants platform-admin and re-sets the marker to
the logging-in id. The reset is **self-retiring**: after the
grant, both conditions are false forever, including for any future
listed identity. Fail-closed: an unparsable marker is not deleted;
a delete failure yields bootstrap status `error` with the login
unaffected; not-listed, plain-entry, and already-admin logins never
delete. The stranded grant remains in place, dormant.

### #1210 — repair migration

A login-path repair step at the same point as normal binding
migration (not in the post-login bootstrap code #1208 owns). It
fires only for a `platform:`-listed logging-in user when the
retired id holds an **active** platform-admin membership: if the
caller lacks platform-admin, create the equivalent under the
caller, then revoke the retired record (never delete it); if the
caller already holds it (e.g. #1208 granted it), just revoke the
retired record. A revoked or absent retired membership is a no-op
— access is never resurrected, and revoked records are never
mirrored. Once the retired record is revoked, later runs find
nothing to move.

### Interaction and ordering

The PRs serialize: #1208 first, #1210 rebased after it. In that
order the end state is fully clean (marker truthful via the reset
grant, retired record revoked via the repair). If the repair ever
landed first, the end state would still be correct (owner holds
platform-admin, retired revoked) except the marker would stay
`grantedTo` the retired id — inert, because the already-admin
check short-circuits before the marker is ever read for that user.
**The panel opens after the first fix deploys plus an owner
login**; the second fix is cleanup and redundancy, not a second
wait. The admin-grant route (a #945 completion item) cannot fix
this incident on its own: no current platform-admin exists to
call it. It remains the right follow-up for later multi-admin
needs (e.g. a second admin for a Google login).

### #1756 — atomic genesis claim (F-10) and marker hygiene (F-59)

The genesis race is closed: `runWiredPostLogin` claims the marker
with `KvLike.putIfAbsent` before granting, backed in production by
the SessionStore DO's atomic consume op (one serialized request
performs the check and the set, the same op the x402 replay guard
already uses). The claim winner grants platform-admin; the loser
takes the genesis-closed tenant-admin path and never writes the
marker. A claim won but followed by a failed grant releases the
marker so a retry can win — safe only because the atomic claim
has exactly one winner, so the release runs on the atomic path
only. Backends without putIfAbsent keep the legacy create-then-put
order and must serialize their first logins. No enforcement
decision, grant, or role-assignment semantic changes: only which
caller wins the one-shot window, and only once. Pinned by
`tests/iaaa_genesis_atomic_claim.test.ts` (concurrency test written
first, observed failing with both logins winning under the old
code) and by `putIfAbsent` adapter tests in
`tests/durable_session_store.test.ts`.

Marker hygiene, verified on current main 2026-10-28 (no
production read — production marker state is not observable from
the repo, and no production probing was done): the F-59 repair
landed in the #1208-first order. PR #1219 (#1208) merged
2026-10-23T20:09:35Z (main `32a5074`); PR #1220 (#1210) merged
2026-10-23T20:15:00Z (main `ab014f4`); `32a5074` is an ancestor of
`ab014f4` on main; deploy order was #987 then #988; the owner
login after #987 ran the reset + grant and the login after #988
revoked the retired record. End state: marker `grantedTo` the
derived id, retired record revoked — fully clean, no stale
`grantedTo` retired id left by the landed order. A stale marker
could only arise from a pre-#1208 deployment, and it stays inert:
the already-admin check short-circuits before the marker is ever
read for that user, and the #1208 reset (still present in
`runWiredPostLogin` on current main, running before the claim)
would delete it on a listed non-admin login and re-set it to the
logging-in id. The #1210 repair
(`repairStrandedPlatformAdmin`, still present in the login tail
on current main) revokes any remaining active retired record.

## Diagnostics playbook (for the next admin issue)

| Observation | What it proves |
| --- | --- |
| `/api/me` shows a `v1:` id | Fresh wired login, migration ran. A UUID means a stale or pre-migration session — log out and back in first. No id means a legacy (non-wired) session, which never runs bootstrap. |
| E*TRADE connects (PDP passes) | Bootstrap entries matched, deploy is live, tenant-admin landed. |
| E*TRADE still denies `integration:connect` | The login did not take effect (stale session, unmatched entries, or a swallowed bootstrap error) — not a genesis problem. Retry a fresh login before anything else. |
| Panel denies while E*TRADE passes | Genesis-closed branch (or the caller genuinely lacks platform-admin). Tenant-admin is not a panel substitute. |
| Login provider | Entries are per-pair. A Google login never matches GitHub entries, and vice versa. Confirm the provider before concluding anything. |

**Not observable from the repo:** production membership state and
the genesis marker. Only the owner's login results (panel,
E*TRADE, `/api/me` prefix) can confirm or refute a grant. Never
assert a grant landed without that confirmation.

## Rules for future admin changes

- Bootstrap entries are per (issuer, subject) pair. Adding a
  provider means adding entries for that pair; nothing carries over.
- Genesis is one-shot per tenant. Once the marker is set, no new
  `platform:` entry can grant platform-admin — plan a second admin
  through the grant route, not through bootstrap.
- Migration never moves another identity's memberships. If an id is
  retired, its grants need an explicit repair (like #1210), not a
  login.
- Prefer bare `v1:` entries from `/api/me` (post-#1197) over
  issuer:subject entries when the subject is hard to obtain
  (notably Google's `sub`, which the app does not display).
- Keep tenant and platform scope distinct in every check and every
  message: "E*TRADE works" and "panel works" are different claims.

## Status (as of writing)

- #1182 (derived identity): closed, live.
- #1196 (bootstrap config): merged, deployed.
- #1197 (bare `v1:` entries): closed, live.
- #1208 (marker reset): closed, live (PR #1219, main `32a5074`,
  Deploy #987). Owner-confirmed 2026-10-23: after the deploy, the
  owner's next GitHub login ran the reset + grant and the IAAA
  panel opened, API/MCP tabs included.
- #1210 (repair migration): closed, live (PR #1220, main `ab014f4`,
  Deploy #988). Cleanup/redundancy as designed: with #1208 live,
  the retired record is revoked and the end state is fully clean
  (marker truthful, retired record revoked).
