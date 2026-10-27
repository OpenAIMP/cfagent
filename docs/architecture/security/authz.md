# Authorization — the PDP, roles, memberships, and delegation

How cfagent decides whether an authenticated caller may do something. Who
the caller is (authentication) is in [authn.md](authn.md); the end-to-end
picture is in [security-workflow.md](security-workflow.md).

## 1. Default deny, always

Authorization is Slice 3 (`src/security/authorization.ts`): `authorize()`
is default-deny. Nothing is permitted unless a rule grants it. A grant
requires `role:assign` in scope, every binding is checked with
`canGrantRole` before any write, and `grantedBy` is always overwritten
with the granter — a caller cannot launder provenance.

There are 17 permissions (spec §5). The full list lives in the module;
the ones that appear at enforcement points in this folder include
`integration:connect` (link an integration) and `role:assign` (grant roles).

## 2. Roles and the tenant-admin trap

## 2. RBAC: roles, scopes, and grants

Authorization is role-based access control. A membership carries
**role bindings**; each binding names a role, a scope, and optionally a
workspace or resource; bindings may expire. `authorize()` grants a
permission only when an active, unrevoked binding grants it **and** the
scope, tenant, and resource checks pass on top. The role table is the
whole model — there are no ad-hoc permission checks outside it:

| Role | Grants (within scope) | Scope notes |
| --- | --- | --- |
| `platform-admin` | `role:assign`, `audit:read`, `audit:export` — only these three | Platform scope only; this set **never** grants tenant permissions. Platform scope is a hard boundary: only a platform-admin binding at platform scope grants, whatever tenant roles the actor holds |
| `tenant-admin` | All 17 permissions | Tenant scope; cannot grant platform privileges |
| `workspace-admin` | All 17 permissions | Workspace scope (binding's `workspaceId`) |
| `member` | `task:create`, `task:read`, `task:cancel`, `artifact:read`, `artifact:edit`, `artifact:export`, `action:propose` | Propose, never approve or execute |
| `approver` | `action:approve` | One permission: approve what others propose |
| `auditor` | `task:read`, `artifact:read`, `audit:read` | Read-only, including audit |

The 17 permissions are: `membership:invite`, `membership:revoke`,
`role:assign`, `task:create`, `task:read`, `task:cancel`,
`artifact:read`, `artifact:edit`, `artifact:export`,
`integration:connect`, `integration:use`, `integration:manage`,
`action:propose`, `action:approve`, `action:execute`, `audit:read`,
`audit:export`.

Grant rules (`canGrantRole`, enforced for every binding before any
write): a platform target (platform-admin role or platform scope)
requires a platform-admin granter, full stop; tenant-scope grants
require a tenant admin; workspace-scope grants are confined to the
binding's workspace. A denied binding denies the whole grant atomically,
and `grantedBy` is always overwritten with the granter.

Two consequences worth stating plainly. First, **platform-admin is not
omnipotent**: it is the only role that can grant platform privileges,
but it holds only three permissions at platform scope, while
tenant-admin and workspace-admin hold all seventeen inside their
scopes. "Highest privilege" means "can grant across the boundary", not
"can do everything". Second, **revocation is a permission too**:
`membership:revoke` is in the table, but the revocation *actions*
themselves (session logout, E*TRADE revoke, key delete) are deliberately
ungated safety actions (§7) — the permission governs who may revoke
*others*, never whether you may revoke your own.

- **Platform admin:** the highest privilege; granted only through the
  genesis window below, or by an existing platform admin.
- **Tenant admin:** holds **all** permissions, including
  `integration:connect` — but tenant admins **cannot grant platform
  privileges**. That boundary is the point: a tenant admin is powerful
  inside a tenant and powerless to escalate out of it.
- **Membership** is per (user, tenant, role), stored in the Kv
  MembershipStore (`src/security/iaaaMembershipStore.ts`):
  `iaaa-membership:<id>` records plus a `iaaa-membership:user:<userId>`
  index. The store fails closed on index-write failure, and corrupt
  records throw instead of being silently overwritten. There is **no
  list-all API**: the admin overview reads the caller's own memberships
  only, which is why the panel can never leak another user's roles.

## 3. Bootstrap and the genesis window

Bootstrap (`src/security/iaaaBootstrap.ts`) provisions the first admins
from `IAAA_BOOTSTRAP_ADMINS`, parsed strictly:

- Bare entries must be UUIDs. A pasted GitHub login is **rejected** with a
  reason (logins are renameable and recyclable — see
  [authn.md](authn.md)).
- Provider entries split at the **last** colon.
- Blank or unset means zero entries, zero error, no fallback.
- Grants are tenant-admin only, for a caller-supplied tenant; an empty
  tenant refuses everything. `createdBy` / `grantedBy` are
  `system:bootstrap`.

The genesis rule: entries prefixed `platform:` grant platform-admin
**only while** the marker key
`iaaa-bootstrap:platform-genesis:<tenantId>` is absent. Once the marker
is set, later `platform:` entries grant tenant-admin only. Genesis grants
use `system:bootstrap-genesis`. The marker is check-then-set, **not**
transactional — a small, documented race. Bootstrap fires on wired login
when the caller is listed and holds no membership yet; a blank list means
zero writes.

## 4. Tenant resolution

The tenant for a request is `IAAA_TENANT_ID` if set, otherwise the
documented single-tenant default `"primary"`. Multi-tenant deployments
must set the variable; the underlying modules always take the tenant
explicitly, so a missing variable can never silently resolve to another
tenant's data. Underlying detail (defaults, gated set, and the exact
enforcement points) is in
[iaaa-github-end-to-end-defaults.md](iaaa-github-end-to-end-defaults.md).

## 5. Delegation

Delegation (`src/security/delegation.ts`, Slice 4) is an intersection,
not a union: effective authority = initiator ∩ tenant ∩ resource ∩
delegation ∩ approval. Delegations expire and carry action budgets. A
delegate can never exceed what the initiator, the tenant, the resource,
and the approval each independently allow.

## 6. Where enforcement actually happens

| Enforcement point | Gate | Denial behavior |
| --- | --- | --- |
| E*TRADE link start + verifier | `integration:connect`, PDP on + wired session, or PDP on + legacy session past its §8 grace bound | 403, action not performed; grace-expired legacy denials carry code `legacy_pdp_grace_expired` |
| Public link start + token connect | `integration:connect`, same PDP rule as the E*TRADE gates | 403, action not performed; grace-expired legacy denials carry code `legacy_pdp_grace_expired` |
| API-key mint | Step-up (fresh authentication), not PDP | 403 for stale and legacy sessions until re-login |
| `GET /api/iaaa/overview` | Platform-admin, server-side | 401 no session; 403 legacy session; 403 wired non-admin with no data; 500 generic on corrupt store |
| IAAA admin panel | Same gate, client-side | Shows "not an admin" on 403 |

## 7. Deliberately ungated — and why

- **E*TRADE revoke and API-key deletion.** Revocation is a safety action;
  gating it would let the policy it escapes from block the escape.
- **`/trade/approve`.** A downstream Durable Object human-in-the-loop
  gate owns that decision.
- **The generic `/api/*` forwarder and schedule-goal mutations.** Not
  PDP-gated; the forwarder itself is session-gated (see
  [api-security.md](api-security.md)).

## 8. Legacy sessions and the bounded exemption (#1749)

Legacy (pre-wiring) sessions carry no internal id, so no tenant
membership can be resolved for them — and denying them outright
would lock out every session created before wiring. Their PDP
exemption is therefore BOUNDED, not open-ended: a legacy session
is PDP-exempt only while it is inside its absolute session
lifetime (createdAt + `SESSION_TTL`, 7 days; `isLegacyPdpGraceExpired`
in `src/security/iaaaGithubEndToEnd.ts`, enforced through the
single choke point `shouldEnforcePdp` that every gated route
already calls). Inside the bound it takes the pre-change path at
the `integration:connect` gates (§6). Past the bound it is
PDP-enforced and denied there (403, code
`legacy_pdp_grace_expired`) until it re-logs in through wiring
and becomes wired — that re-login is the migration path, not a
lockout cliff: ungated routes are unaffected, and login itself
is never PDP-gated. A legacy session with no provable createdAt
cannot prove it is inside its bound and fails closed.
The bound is not configurable at any scope: it reuses
`SESSION_TTL`, so no caller can widen, narrow, or disable their
own enforcement. The SessionStore record already expires at the
same deadline, so the gate is explicit policy plus defense in
depth, not the only thing standing between a stale record and a
gate. This is a migration property with a deadline, not a
permanent second class of privilege — but while any inside-bound
legacy session exists, the PDP is not universal, and audits must
say so (see §10).

## 9. Open decisions (owner, not defaults)

Settled thresholds are still open: the 15-minute step-up window and the
idle window are proposed defaults, not settled CISO values. Audit
retention, tamper response, and whether a failed audit write should
block a wired login are undecided — today a failed audit write does
**not** block login. See the #945 open list.

### Revocation-propagation targets (#1750)

Revocation propagation HAS numeric targets now (they replace the
previous observed-property-only wording). The single source of truth
is `src/security/revocationTargets.ts` — frozen constants, not
configuration: no env var, session value, run value, or user value
can widen, narrow, or disable them, because a caller-extendable
revocation grace would let a caller disable their own enforcement.
Every number below reuses a value the system already enforces; this
slice invents no new threshold.

Measurement (all rows): the clock starts when the revoking write
COMPLETES (the store put/delete returns), and ends at the first gate
check at or after that moment. A bound of 0 means the very next gate
check denies. For token-expiry there is no revoking write: the clock
starts at the deadline, and a gate check at or after the deadline
must deny (0 ms past the deadline).

| Trigger | Target | Gate |
| --- | --- | --- |
| Membership / grant revocation | 0 ms — next PDP check denies | PDP check (`checkRoutePermission` / `authorize`) on PDP-enforced routes. The PDP reads the membership store fresh on every check; no membership cache sits between store and PDP. Binding expiry is exact the same way: a binding denies at the first check at or after its `expiresAtMs`. |
| Session revocation | 0 ms same-isolate; ≤ 60,000 ms every isolate | Session gate (`requireAuth`). The logout path invalidates the isolate cache before deleting the record, so its own next read denies. Any other isolate serves its stale cached copy until the 60-second isolate-cache TTL lapses, then re-reads the store and denies. A wired session is denied immediately on every isolate: the wired validation path fresh-reads and denies on a missing record even when a cached copy exists, so the 60 s tier never applies to it. |
| API-key deletion | 0 ms — next verification denies | API-key verification (`verifyApiKey`) at the MCP transport. Verification reads the key store fresh (hash lookup, then record read) with no cache layer. API keys carry no expiry; deletion is the only key-revocation trigger. |
| Admin removal | 0 ms — next admin-gate check denies | Admin gates (GET `/api/iaaa/overview` gate, PDP, grant gate), all fresh membership reads. Admin removal IS membership revocation applied to an admin binding, so it shares the membership mechanism and bound. |
| Token expiry | 0 ms past the deadline | Session gate (wired validation) and OIDC claim validation. Absolute session expiry: first wired gate check at or after `createdAt + SESSION_TTL` (7 days) denies. Idle expiry: first wired gate check at or after recorded last-activity + the enforced idle default (30 minutes) denies. OIDC claims: a claim with `exp` at or before now denies on presentation. The idle and step-up windows themselves remain unsettled CISO values (#1757); these targets reuse the enforced defaults without settling them. |

Proving tests: `tests/iaaa_revocation_targets_1750.test.ts` (one
group per trigger, revoke-then-gate at the bound) and
`tests/iaaa_revocation_session_cache_1750.test.ts` (the 60-second
isolate-cache interaction: same-isolate invalidation, cross-isolate
TTL expiry at exactly 60,000 ms, and the honest stale-serve window
inside the TTL).

### Residual gaps — NOT covered by the targets above

These are named here, with their own follow-ups, not folded into a
passing target:

- **Legacy sessions inside the §8 bound are PDP-exempt.** For them,
  membership revocation and admin removal do NOT deny at the
  integration gates until the §8 bound expires (at most 7 days from
  session creation, then 403 `legacy_pdp_grace_expired`) or the
  session re-logs in through wiring. The 0 ms membership/admin
  targets bind PDP-enforced sessions only.
- **The PDP is not a universal gate.** Session-gated-only routes
  (the generic `/api/*` forwarder, schedule-goal mutations) and the
  §7 deliberately ungated routes never consult memberships, so
  membership/admin revocation does not deny those routes at all.
  Gate coverage is #1754's audit (scan F-06), not this slice.
- **Sessions the store cannot see cannot be revoked by id.**
  Bulk revocation / offboarding requires caller-supplied session
  ids — there is no session listing — so an offboarding that does
  not know all of a principal's session ids misses the unknown
  ones (scan F-16, #1758 lifecycle wiring).
- **Admin removal does not terminate the removed admin's session.**
  The removed admin stays authenticated for session-gated routes
  until session revocation or expiry; only admin gates deny
  immediately. That is the mechanism as designed (revocation is a
  permission), stated here so it is not mistaken for session
  revocation.
- **API keys have no expiry.** A key lives until deleted. Deletion
  is immediate (0 ms), but there is no rotation or expiry bound,
  and none is invented here.
- **Idle expiry is exact against RECORDED activity, not true
  activity.** Recorded activity lags true activity by up to 60 s
  (touch precision: touches persist at most every 60 s), and a
  session with no recorded activity at all (legacy / Phase 1) is
  idle-exempt by contract — its only expiry bound is the absolute
  deadline. Neither slack is hidden inside a looser gate bound.

## 10. XACML mapping — conceptual, not conformant

This section names the XACML roles this system already plays. It is a
mapping, not a claim of conformance: cfagent implements no XACML policy
language, no XACML request/response protocol, and no standalone XACML
engine. The vocabulary is useful because it separates four jobs that are
easy to conflate in code — who writes policy, who decides, who
enforces, and who supplies attributes. Where the code does not cleanly
separate them, this section says so.

| XACML concept | cfagent equivalent (verified on main) |
| --- | --- |
| PAP — Policy Administration Point: authors and manages policy | Three places, in decreasing order of permanence. (1) The policy itself, as code: the `ROLE_GRANTS` table in `src/security/authorization.ts` (with `PERMISSIONS` and `AUTHORIZATION_POLICY_VERSION = "iaaa-authorization-1"`). Changing a grant means changing this table and shipping it — there is no policy store or policy editor. (2) Bootstrap provisioning: `IAAA_BOOTSTRAP_ADMINS` parsing in `src/security/iaaaBootstrap.ts`, which seeds the first grants (§3). (3) Runtime grants: the IAAA admin panel (`src/client/IaaaAdminPanel.tsx`, "Access requests" section) driving `POST /api/iaaa/access-request/decision`, which calls `grantMembership` (`src/security/iaaaMembershipStore.ts`) under `canGrantRole` enforcement (`src/security/authorization.ts`). |
| PDP — Policy Decision Point: evaluates a request against policy | `authorize()` in `src/security/authorization.ts`, reached through the seam `checkPermission()` in `src/security/iaaaPdpSeam.ts`. The PDP is a pure function of stored memberships: given a subject, a permission, and a scope, it answers allow or deny. It performs no enforcement and no side effects. |
| PEP — Policy Enforcement Point: enforces the PDP's answer at the boundary | Several, one per surface — there is no single gateway. (1) `requireAuth()` in `src/server.ts`: the session gate, which rejects unauthenticated callers before any permission is evaluated. (2) `checkRoutePermission()` in `src/security/iaaaGithubEndToEnd.ts`, called from the E*TRADE start, E*TRADE verifier, Public start, and Public connect routes in `src/server.ts` for `integration:connect` (403 on deny; see §6). The callers first check `shouldEnforcePdp`, which enforces for wired sessions and for legacy sessions past their §8 grace bound, and exempts only legacy sessions inside the bound; a grace-expired legacy denial carries code `legacy_pdp_grace_expired`. (3) The `canGrantRole` checks on the access-request decision route in `src/server.ts`. (4) The `requireAuth` gate at the top of the `/api/schedule/` block in `src/server.ts` (401 before the ScheduledAgent stub is reached). A PEP that cannot reach the PDP denies: a missing session, a legacy session past its grace bound (no internal id to evaluate), or an unresolvable tenant all fail closed. The one documented exception is a legacy session inside its grace bound (§8), which takes the pre-change path at the `integration:connect` gates. |
| PIP — Policy Information Point: supplies the attributes the PDP reads | The SessionStore Durable Object, read directly — there is no separate attribute service. Memberships under `iaaa-membership:` keys (`src/security/iaaaMembershipStore.ts`), identity bindings under `iaaa-binding:` keys (`src/security/iaaaLogin.ts`), migration aliases under `iaaa-alias:` keys (`src/security/iaaaMigration.ts`), and sessions via `sessionStore(env)`. The tenant attribute defaults to `"primary"` (`IAAA_DEFAULT_TENANT_ID` in `src/security/iaaaGithubEndToEnd.ts`; see §4). |
| Context Handler — assembles the request the PDP evaluates | The `CheckPermissionInput` in `src/security/iaaaPdpSeam.ts`: subject = `internalUserId` (the derived `v1:` identity, never a login handle or email), resource = `tenantId` plus `scope` / `resourceScope`, action = `permission`, environment = `nowMs` plus caller-side facts the PDP does not itself fetch — session validity (established by `requireAuth` before the call), step-up freshness (`DEFAULT_STEP_UP_FRESHNESS_MS` in `src/security/sessionPolicy.ts`), and the `IAAA_PDP_ENABLED` flag (callers check `shouldEnforcePdp` before calling; the PDP seam itself does not read flags). |
| Obligations / Advice — things that must or should happen alongside the decision | Partial equivalents only. Audit-on-decision: security events are written to the hash-chained store under `iaaa-audit:` keys (`src/security/iaaaAuditStore.ts`) — the record that a decision happened, not a condition on it. Step-up re-authentication: a fresh-authentication requirement enforced at sensitive gates (API-key mint; see §6), which functions like an obligation to re-authenticate, but it is enforced ad hoc at each gate, not declared as an obligation attached to a policy. There is no obligation service and no advice channel: the PDP returns allow/deny, and everything else is the caller's job. |

### Combining rule

Default-deny, with deny-overrides. The PDP permits only when an active,
unrevoked binding grants the permission **and** the scope, tenant, and
resource checks pass (§1, §2). Unknown permissions, missing
memberships, revoked memberships, cross-tenant requests, and
scope/resource mismatches all deny. For grants, the rule is atomic: a
single denied binding denies the whole grant, and nothing is partially
written (§2). There is no permit-overrides path anywhere in the system,
and no rule ordering to configure — the combining behavior is
hardcoded, not policy.

### Honest gaps — what this mapping is not

- **Policy is TypeScript tables, not portable XACML.** `ROLE_GRANTS`
  cannot be exported, imported, or evaluated by any other XACML
  implementation. Policy versioning is a single string constant
  (`iaaa-authorization-1`), not a policy set with versioning semantics.
- **The PDP is an in-process library, not a service.** There is no
  network boundary between PEP and PDP, no PDP endpoint, and no
  independent PDP deployment. A bug in the PDP ships with the Worker.
- **There is no attribute service.** The PDP reads stores directly
  through the membership store. Attributes cannot be federated,
  transformed, or cached by a PIP layer; what the store holds is what
  the decision sees.
- **There is no obligation service.** Audit and step-up are ad-hoc
  caller behavior (see Obligations above), not obligations declared in
  policy and enforced by a handler.
- **The PDP is not the only gate.** Legacy sessions inside their
  grace bound are PDP-exempt (§8), deliberately ungated routes
  exist (§7), and the `/trade/approve` decision belongs to a
  downstream Durable Object gate. While any inside-bound legacy
  session exists, "the PDP decided" is not a complete description
  of how a request was authorized, and audits should say so.

Until those gaps close, describe this system as XACML-*inspired*: the
separation of PAP / PDP / PEP / PIP is real and load-bearing, but
conformance is not claimed and must not be implied to reviewers,
auditors, or users.
