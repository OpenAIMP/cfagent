# Zero-trust posture (ZTZ)

What "zero trust" means in this codebase: not a product or a badge, but a
set of mechanisms that each remove one implicit trust. If a mechanism is
not listed here, it is not part of the posture — and §5 lists the places
where trust is still implicit, honestly.

> Terminology note: this document reads the requested "ZTZ" as
> zero-trust. If that acronym meant something else, this file is the one
> to rename.

## 1. Never trust a session alone — re-validate on fresh reads

A session cookie proves only that a session once existed. Every
enforcement path re-validates wired sessions on a **fresh** read
(`getSession`, never the cached copy) and enforces idle expiry at that
point. The isolate cache is consulted only to decide whether a session is
wired at all. A stolen or stale cookie therefore buys, at most, the idle
window — and the window is enforced at the enforcement point, not at the
edge.

## 2. Default deny, fail closed

- The PDP is default-deny ([authz.md](authz.md)): no rule, no access.
- Unknown provider ids, unlisted providers, and wiring-off are 403s,
  never fallbacks ([authn.md](authn.md)).
- Unknown framework adapter ids fail closed at startup: the service
  refuses to serve rather than silently serving on a wrong adapter (see
  the #1024 drop-in design).
- A step-up gate with a missing `authTimeMs` fails closed.
- A corrupt membership record throws instead of being treated as
  "no membership, proceed anyway" — and a membership index-write failure
  fails the whole grant.
- A missing bootstrap tenant refuses every grant; a blank bootstrap list
  grants nothing.

Fail-closed is the difference between zero trust and a checklist: every
uncertain state resolves to "no", and the "no" is observable (a 403, a
throw, a log) rather than silent.

## 3. Least privilege, enforced at the boundary that matters

- Tenant admins hold all permissions **inside** a tenant and cannot grant
  platform privileges ([authz.md](authz.md)).
- Delegation is an intersection, never a union.
- Grants require `role:assign`, are checked per binding, and always
  record the real granter.
- The admin overview has no list-all API, so even a platform admin's
  panel cannot enumerate other users' memberships — the read path is
  least-privilege by construction, not by policy text.

## 4. Assume breach: audit, rotate, revoke

- **Audit** (Slice 5, `src/security/iaaaAudit.ts`) records §6 fields in an
  append-only, SHA-256 hash-chained store. The chain is verified, not
  trusted: a fork or loss is detected by `verifyChain`.
- **Rotation:** sessions rotate; the renewal cron re-issues stored
  E*TRADE tokens before midnight ET expiry.
- **Revocation is a safety action and is never gated** (see
  [authz.md](authz.md) §7): the escape hatch must work even when the
  policy that normally governs the caller would say no.
- **Step-up** re-proves freshness for the operations where a stale
  session is most dangerous (API-key mint).

## 5. Where trust is still implicit — the honest gaps

A zero-trust claim that omits its gaps is marketing. These are the gaps:

1. **Legacy sessions are PDP-exempt (inside a bound) and idle-exempt.** They predate
   wiring and carry no internal id. The PDP exemption is bounded by the session's
   absolute lifetime (createdAt + 7 days, #1749): past the bound, gated routes deny
   until re-login, and the idle exemption is bounded by the same absolute lifetime,
   since the store record expires regardless of activity. Until the last legacy
   session drains, the PDP is not universal.
2. **Public surfaces exist by design.** The landing page, A2A agent-card
   GETs, strategy pages (served by the asset layer without invoking the
   Worker), and `/mcp/scanner` (where the x402 payment *is* the access
   control for the `screen_options` tool) are reachable without a session.
   Their protection is "there is nothing sensitive here" plus transport
   controls — not identity. Precision added by the #1754 audit: the
   payment gates `screen_options` only — the scanner's free tools
   (`scanner_status`, `get_scan_job` by UUID, `list_scan_jobs` on the
   caller's affinity instance) are ungated too, and callers sharing
   the default `public_scanner` instance can see each other's job
   lists; the outputs are public market-data results, so this stands
   as a recorded residual, not a hidden gap. Full surface inventory:
   [gate-coverage-inventory-1754.md](gate-coverage-inventory-1754.md).
   See [api-security.md](api-security.md) and
   [mcp-security.md](mcp-security.md).
3. **The audit store has a known race.** The Kv audit store is
   read-modify-write: concurrent appends can lose events or fork the
   chain. Verification detects this; it does not repair it. The store is
   also unbounded until a retention decision is made.
4. **Login-keyed state can orphan — cutover DECIDED (#1759).**
   Token and DO state keyed by login string (not internal id)
   can detach on rename. The #1759 decision is alias-forever
   for DO names (`resolveDoNameForUser`) + dual-read for tokens
   (internal-id key first, alias-login key second); copy-cutover
   was rejected because `idFromName` cannot rename a DO and a
   copy can orphan in-flight state. Residual, bounded: DO
   dispatch sites that have not yet adopted the resolver, and
   the login-keyed `getValidTokens` hot path, still address raw
   login — the old DO and old token keys are never deleted, so
   the state is unreachable-by-new-login there until adoption,
   not lost (see `iaaa-login-key-cutover-1759.md`).
5. **Revocation propagation has numeric targets (#1750).** Per
   trigger, at the gate: membership revocation 0 ms (next PDP
   check), API-key deletion 0 ms (next verification), admin
   removal 0 ms (next admin-gate check), token expiry 0 ms past
   the deadline, session revocation 0 ms same-isolate and ≤ 60 s
   every isolate (the isolate-cache TTL; wired sessions deny
   immediately on a fresh read). Full table, measurement rule,
   and residual gaps: [authz.md §9](authz.md) and
   `src/security/revocationTargets.ts`.
6. **A failed audit write does not block login.** That is the current
   behavior and an open CISO decision, stated here so it is a decision
   rather than an accident.

## 6. How to extend the posture

A new surface joins the posture by: (a) authenticating through the
session or API-key path, never a new bespoke check; (b) authorizing
through the PDP with an explicit permission, or documenting why it is
deliberately ungated; (c) emitting audit events through the audit store;
(d) failing closed on every uncertain state; and (e) naming its own gaps
in its doc. Anything that cannot meet (a)–(d) stays outside the posture
and says so.
