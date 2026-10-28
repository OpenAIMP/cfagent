# Audit store: transactional append, enforced bound, event coverage (#1760)

**Parent program:** #1717 (system-wide duplicate/overlap unification).
**Slice:** #1760 only. **Agent:** #CISO-bhdm. **Lane:** `lane:ciso-bhdm`.
**Source rows:** F-18 (`zero-trust.md` §5.3) and F-21 partial
(`iaaa-admin-ui.md`).

## 1. The race, closed (F-18)

The old Kv audit store was read-modify-write: `recordAuditEvent`
listed the log, computed the chain link, then the store re-read
and rewrote the whole array. Two concurrent appends could read
the same tail, so one event was lost or the chain forked, and
`verifyChain()` only detected it afterward.

The production wiring is now transactional: `createWiredAuditStore`
returns an atomic backend whose appends go through the
SessionStore DO's `audit-append` op. One DO request reads the
tail, chains the event (id, `previousEventHash`, SHA-256
`eventHash`), rotates if needed, and writes back — and a DO
handles one request at a time, so a second appender cannot
interleave between the tail read and the write. The client-side
list-then-link step does not run on this path at all:
`recordAuditEvent` delegates to `store.appendAtomic` whenever
the store exposes it.

Evidence: `tests/audit_store_atomic_1760.test.ts` drives the real
`SessionStore` class (node:sqlite harness; the namespace stub
models the DO input gate with a promise-chain mutex, the same
premise the `consume` replay guard already relies on). 40
parallel appends store all 40 events with a verifying chain.
The contrasting Red evidence for the legacy path — 20 parallel
appends through the old protocol storing 1 event — is recorded
in the PR body. The legacy `createKvAuditStore` is retained for
backends without a DO (tests, in-memory Kv) and is documented
as still racy; it is no longer production wiring, and its
`append()` on the atomic backend throws so a caller-chained
event can never bypass the atomic chaining.

## 2. The bound, enforced — and what it is not

Capacity bound (defaults, live in code, not a retention period):

- Live key: at most 2,000 events. On overflow the oldest 2,000
  events rotate into a new archive segment key
  (`iaaa-audit:archive:NNNNNN`), oldest first, chain order
  preserved, so `list()` over archives + live still verifies
  end to end.
- Archive segments: at most 10, so the whole store caps at
  2,000 + 10 × 2,000 = 22,000 events.
- At the cap, a new append fails with `AUDIT_STORE_FULL`:
  fail-visible, never silent, never by deleting evidence.
- A caller may request SMALLER caps only. The DO clamps larger
  requests to its hard ceilings, so no caller can widen or
  disable its own bound — a bound a caller can lift is not a
  bound.

What this bound is NOT: it bounds bytes/rows, not time. **No
retention period is asserted anywhere in this slice.** Retention
is CARRIED to adoption question Q7 (deciding owner Mubasher, on
a CISO + CDO recommendation — #1757 D-3, unchanged by this
slice). Until Q7 answers, nothing deletes an audit event for
age. Unbounded growth after this bound has a named owner +
trigger: owner Mubasher; trigger = the Q7 retention answer, or
a production `AUDIT_STORE_FULL` observation forcing the
question early. The operator procedure on `AUDIT_STORE_FULL` is:
treat it as an operational event (the login path stays
non-blocking per #1757 D-2, so logins proceed unaudited and
fail-visible; consequential paths fail closed only where #1751
wiring already says so), preserve the store untouched, and
escalate the retention decision — never "make room" by deleting
old events without that decision.

## 3. Audit semantics, preserved

- #1757 D-2 stands: a failed audit write on login is
  deliberately NON-BLOCKING on the live path. New emissions in
  this slice are best-effort with the same rule: a failed write
  warns (fail-visible) and never changes the login/logout
  outcome.
- #1751's evaluator stays fail-closed ONLY for `role:assign` /
  `membership:revoke` / `audit:export` where wired. Nothing in
  this slice wires the evaluator anywhere new, and the bootstrap
  exception grants below are NOT claimed as `role:assign`
  coverage — bootstrap is a genesis exception, not the normal
  grant path.
- Attribution, ordering, and tamper-detection are unchanged:
  events still carry login/tenant attribution (or the explicit
  `"unknown"` marker where no attribution exists), the hash
  chain still verifies end to end across archives + live, and
  corrupt bytes still fail loud and are left untouched.

## 4. Per-occurrence coverage (F-21)

Emitted in this slice (all best-effort, fail-visible, never
blocking):

| Occurrence | Event | Site |
| --- | --- | --- |
| Logout-audit skip, legacy session | `auth.logout_audit_skipped` (outcome `unknown`, `LEGACY_SESSION_NO_INTERNAL_USER_ID`) | `githubOAuth.ts handleLogout` |
| Alias recording | `iaaa.alias.record` | `runWiredPostLogin`, on `recorded` only |
| Ordinary bootstrap grant | `iaaa.bootstrap.grant` (actor `system:bootstrap`) | `runWiredPostLogin`, on `provisioned` and `genesis-closed-tenant-admin` |
| Genesis grant + marker | `iaaa.genesis.grant` (actor `system:bootstrap-genesis`) | `runWiredPostLogin`, on `genesis` only |

Non-occurrences emit nothing: `already-admin`, `not-listed`,
`blank`, `conflict-preserved`, `invalid`, and `error` wrote
nothing, so an event for them would be false evidence. The
logout gate change behind the skip event: `logoutAuditTenant`
no longer requires the session's internal id (pin updated in
the same PR) — the tenant comes from the server-resolved
tenant, never from the session, so resolving it for a legacy
session fabricates no identity; the full logout event is still
emitted only for wired sessions.

Decided silences (explicit, each with a trigger — the silent
list is now exactly these plus the no-backend logout case):

- **PDP denials** — emitting at the etrade 403 branches before
  CTO-lane #945 wiring adopts the #1751 evaluator at live
  routes would create a second, divergent denial-audit path,
  and the live legacy-grace 403s are not evaluator decisions,
  so labeling them PDP denials would misattribute. Trigger:
  CTO #945 route wiring adopting the evaluator.
- **Step-up denials** — single-branch emission at the api-keys
  mint branch would be partial coverage while the catalog
  claimed coverage. Trigger: the step-up enforcement wiring
  slice that carries a store seam to every step-up site.
- **Idle-expiry rejection** — the validator has no store seam
  and runs on every wired route; threading audit through it is
  a cross-cutting enforcement-wiring change, not a bolt-on.
  The rejection is fail-visible to the caller as a 403, just
  not in the audit sink. Trigger: an enforcement-wiring slice
  that carries a store seam into session validation.
- **Logout skip with no store or no tenant** — there is no
  backend to write to (wiring off, or no tenant supplied).
  Trigger: wiring enablement / tenant resolution at the call
  site. A missing session record also emits nothing: no
  session ended, so there is nothing to audit, and emitting
  for unknown cookies would spam the log.

## 5. Tenant-mixed full-read: what changed, what did not

New audit consumers append through `recordAuditEvent` on the
wired (atomic) store; they do not list-and-filter the
tenant-mixed log per request. The admin overview's existing
tenant filter over `list()` stays an admin-only read (the
builder caps at 100 newest), not a per-request path — and
`list()` is now bounded by the total cap instead of unbounded.
No per-request audit path is introduced by this slice.

## 6. Residuals (recorded, not dropped)

- **Catalog method/auth drift** stays a manual-review residual
  gap, as before (see the IAAA tab and its test). This slice
  changes no catalog method/auth data.
- **Legacy Kv store race** persists on the retained legacy path
  (tests, non-DO backends). Production wiring does not use it.
- **Tamper response** (what happens when verification fails)
  is still undecided — #1757 D-4, carried to Q7.
- **Retention period** — carried to Q7 (see §2).
- **Total-cap exhaustion procedure** — operator escalation as
  in §2; no automated alert path is added here (the failure is
  visible in audit results and store_op metrics, not silent).
- **Per-request audit volume** — PDP/step-up/idle emissions,
  when their wiring slices land, must be sized against the
  total cap; this slice does not pre-decide their volume.
