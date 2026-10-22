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
| E*TRADE link start + verifier | `integration:connect`, PDP on + wired session | 403, action not performed |
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

## 8. Legacy sessions and the exemption

Legacy (pre-wiring) sessions stay PDP-exempt even when `IAAA_PDP_ENABLED`
is on: they carry no internal id, no tenant membership can be resolved
for them, and denying them would lock out every session created before
wiring. The exemption ends at re-login, when the session becomes wired.
This is a migration property with a known end state, not a permanent
second class of privilege — but while any legacy session exists, the PDP
is not the only gate in the system, and audits should say so.

## 9. Open decisions (owner, not defaults)

Settled thresholds are still open: the 15-minute step-up window and the
idle window are proposed defaults, not settled CISO values. Measurable
revocation propagation has no numeric target (observed property only:
wired sessions re-validate on fresh reads, bounded by a 60-second
isolate cache). Audit retention, tamper response, and whether a failed
audit write should block a wired login are undecided — today a failed
audit write does **not** block login. See the #945 open list.
