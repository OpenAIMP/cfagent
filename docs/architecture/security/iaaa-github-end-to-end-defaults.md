# IAAA GitHub end-to-end — defaults (issue #945)

## Agent #ceo-aimp

This document records every default chosen by the GitHub end-to-end
slice (the final GitHub wiring slice), as authorized by the user
("implement end-to-end for GitHub with defaults documented, work
autonomously until done"). A default here is a documented choice for
the single-tenant GitHub deployment, not a settled policy for the
whole organization: anything marked PROPOSED or NOT DECIDED below
still needs its owner decision, and this document must be updated
when that decision lands.

## What the slice wires (all gated, all best-effort where stated)

- **Alias recording on login.** In the wired GitHub login path
  (wiring ON only), after Slice 1 binding succeeds, the
  login→internalUserId alias is recorded via `iaaaMigration.ts`.
  An alias conflict (login already mapped to a different user)
  records nothing, preserves the original, and never fails or
  changes the login.
- **Bootstrap-on-login.** In the wired login path (wiring ON only),
  after binding, `IAAA_BOOTSTRAP_ADMINS` is parsed and, if the
  logging-in user's internal id (or issuer:subject) is listed and
  they hold no membership in the tenant, they are provisioned.
  If the list is unset or blank, NOTHING is provisioned and login
  is unchanged. No hardcoded user ids, logins, or subjects exist
  anywhere. No new public route, no new secret, no setup endpoint.
- **PDP route enforcement, flag-gated.** `IAAA_PDP_ENABLED`
  ("1"/"true" = on, default OFF). When ON and the session is wired
  (carries `internalUserId`), the Slice 3 PDP is enforced via the
  `iaaaPdpSeam` helper on the gated routes below. Denial is a 403
  and the action is NOT performed. When the flag is OFF, or the
  session is a legacy session inside its #1749 grace bound
  (createdAt + `SESSION_TTL`), behaviour is byte-for-byte
  the pre-change path — the Phase 2b-part1 contract survives
  only inside the bound. A legacy session past its bound is
  PDP-enforced and denied at the gated routes (see authz.md §8).
- **Audit switch-on.** Login success/failure events (Phase 2a
  builders + Kv audit store) are recorded from the wired callback,
  and the logout hook keeps recording before session deletion,
  both wiring ON only, both BEST-EFFORT: a failed audit write never
  changes a login, logout, or callback outcome.

## Gated routes and their permissions

| Route | Gate | Permission |
|---|---|---|
| `POST /api/api-keys` (mint) | Step-up only (unchanged from Phase 2b-part1) | None — no Slice 3 permission maps to credential minting (there is no `credential:issue` permission), so step-up remains the sole gate. Listing and revoking keys are NOT gated. |
| `/auth/etrade/start`, `/api/etrade/oauth/start` (integration connect start) | PDP when flag ON + (wired session, or legacy session past its #1749 grace bound) | `integration:connect` |
| `POST /api/etrade/oauth/verifier` (integration connect completion — stores broker tokens) | PDP when flag ON + (wired session, or legacy session past its #1749 grace bound) | `integration:connect` |

Deliberately NOT gated: E*TRADE revoke endpoints and API-key
delete (revocation is a safety action and must never be blocked by
staleness or missing membership); `/trade/approve` (trade execution
approval is governed by the downstream Durable Object HITL gate and
draft checks, not by a worker-level PDP permission — gating it here
would duplicate that gate and risk breaking the approval redirect
flow); the generic `/api/*` forwarder (too broad — PDP-gating it
would gate every agent tool call, which is out of scope for this
minimal set); schedule-goal mutations (no clean Slice 3 permission
maps to them).

Default-deny within the gated set: a wired session with no
membership for the required permission is denied. A tenant-admin
holds every Slice 3 permission, so a bootstrapped owner passes;
a member does not hold `integration:connect` and is denied.

## Defaults chosen

- **Tenant: `IAAA_TENANT_ID` if set, else `"primary"`.** This is
  the single-tenant default, and a deliberate, documented departure
  from the earlier "no default tenant" stance of the audit seam and
  the bootstrap module. Those modules still take `tenantId` as an
  explicit argument and invent nothing; the default lives only at
  the end-to-end call-site resolution (`resolveIaaaTenant` in
  `src/security/iaaaGithubEndToEnd.ts`), so it is visible,
  auditable, and reversible. No other tenant value is ever
  invented. A multi-tenant deployment must set `IAAA_TENANT_ID`
  explicitly — `"primary"` is the single-tenant assumption, not a
  multi-tenant answer.
- **Platform-admin genesis: `platform:` entries, one-time window.**
  A bootstrap entry prefixed `platform:` grants platform-admin ONLY
  while no platform-admin genesis has happened in the tenant. The
  window is tracked by a single Kv marker key,
  `iaaa-bootstrap:platform-genesis:<tenantId>`, set on the first
  genesis grant. Once the marker exists, later `platform:` entries
  grant tenant-admin only. Genesis grants carry
  `createdBy`/`grantedBy` `system:bootstrap-genesis`; ordinary
  bootstrap grants carry `system:bootstrap`. The marker is
  claimed atomically (#1756, `KvLike.putIfAbsent`, backed in
  production by the SessionStore DO's atomic consume op): exactly
  one first-login wins and the loser grants tenant-admin only.
  Backends without putIfAbsent keep the legacy check-then-set
  order and must serialize their first logins.
  This replaces the Phase 2b-part2 open question ("no path creates
  a platform-admin") with a narrow, auditable one: the FIRST
  `platform:` login wins, and only once.
- **Step-up freshness: 15 minutes. Idle timeout: 30 minutes.**
  PROPOSED defaults from Slice 2 (the module defaults), NOT settled
  CISO thresholds. They are recorded here as the values actually
  enforced, and they remain open for CISO confirmation.
- **DO-naming cutover: DECIDED (#1759).** Alias-forever for DO
  names + dual-read for tokens (internal-id key first, login key
  second). Login-derived DO names and token keys are kept and
  reached through the alias (`iaaa-alias:` records). No copy, no
  rename, no key deletion. Copy-cutover was rejected (see
  `iaaaMigration.ts` header and
  `iaaa-login-key-cutover-1759.md`); dual-write alone was
  rejected as insufficient for DO names.
- **Revocation propagation: numeric targets (#1750).** Membership
  revocation 0 ms (next PDP check), API-key deletion 0 ms (next
  verification), admin removal 0 ms (next admin-gate check),
  token expiry 0 ms past the deadline, session revocation 0 ms
  same-isolate and ≤ 60 s every isolate (the isolate-cache TTL;
  wired sessions deny immediately on a fresh read). Full table,
  measurement rule, and residual gaps: [authz.md §9](authz.md)
  and `src/security/revocationTargets.ts`.
- **Audit retention: NOT DECIDED.** The Kv audit store
  (`iaaa-audit:events`) is append-only and unbounded until the
  retention decision lands. No retention period is invented here.
  Do not use this store for per-request audit until a bounded,
  transactional backend exists (see its module header for the
  read-modify-write race and O(n)-per-append limits).

## Activation (in order)

1. Set `IAAA_BOOTSTRAP_ADMINS` to the owner's entry (a bare internal
   user id UUID, an issuer:subject pair such as
   `https://github.com:<numeric id>`, or a `platform:`-prefixed
   entry for the first platform-admin). The owner learns their
   internal id from a first wired login's binding record — it is
   never a GitHub login, which the parser rejects.
2. Set `IAAA_TENANT_ID` if the deployment is not the single-tenant
   default (otherwise `"primary"` applies).
3. Set `IAAA_PDP_ENABLED` to `"1"`.
4. Redeploy. The next wired login provisions the listed user (and,
   for a `platform:` entry with no prior genesis, the platform-admin
   genesis); gated routes then enforce the PDP for wired sessions.

**Rollback: unset `IAAA_PDP_ENABLED` (and, if desired,
`IAAA_BOOTSTRAP_ADMINS`), redeploy. No code change.** Existing
sessions keep working; memberships and aliases already recorded are
not deleted by rollback (rollback removes enforcement, not data).
Turning the flag on with no bootstrap list set denies every wired
session on the gated routes, including the legitimate owner — that
is the fail-closed consequence of default-deny, and the reason the
flag defaults OFF.

## Still owner-decided (not decided by this slice)

- Auth0 / social providers (provider choice and costs — see the
  provider decision draft; GitHub is the only wired provider).
- Settled step-up / idle thresholds (15 min / 30 min above are
  proposed defaults only).
- A measurable revocation propagation target.
- Audit retention, tamper response, and the consequential-action
  blocking set — including whether a failed audit write should
  BLOCK a wired login (this slice does NOT block on audit failure;
  that CISO decision remains open and is recorded as such).
- The §15 completion report and the owner decision to close #945.
