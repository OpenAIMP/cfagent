# IAAA-with-Auth0 — Assessment and Specification (PROPOSED)

> Status: **PROPOSED, not adopted.** This document is the assessment-first
> step required by GitHub issue #945 §10 ("Begin with assessment,
> architecture options, provider costs, schemas, permission matrix, tests,
> and migration plan"). It does not change production identity, secrets,
> permissions, or infrastructure, and it does not select a provider.
> No code is changed by this document alone.
>
> Issue: [#945 — [EPIC] IAAA-with-Auth0](https://github.com/OpenAIMP/cfagent/issues/945)
> Agent: #ceo-aimp
> Ownership per #945: CISO owns security requirements + assurance,
> CTO owns implementation, CDO owns identity-data integrity/lifecycle,
> Independent Evaluation verifies. Reserved approvals stay with named humans.

## 1. Outcome

Every human or agent action in cfagent must be able to answer, from
evidence: who initiated it, how they authenticated, why it was authorized,
which agent or service executed it, and what actually happened.

IAAA = Identification, Authentication, Authorization, Accountability
(including auditing). This is broader than "users can log in and have
roles": a login must not be treated as authorization, a role name must not
be treated as a credential, and ordinary logs must not be treated as
non-repudiation proof (#945 §2, §10).

## 2. Assessment — current state (verified 2026-10-21, `main` @ 975c3ed)

### What exists

- **Human login:** GitHub OAuth only (`src/security/githubOAuth.ts`).
  State is HMAC-signed with a 10-minute expiry; the OAuth code is
  exchanged server-side and the GitHub profile is fetched server-side.
- **Sessions:** `src/security/session.ts` — UUID session IDs in the
  SessionStore Durable Object (issue #329, KV fallback removed in #604),
  7-day TTL, `HttpOnly; Secure; SameSite=Lax` cookie, logout deletes the
  session and revokes stored E*TRADE tokens.
- **Per-user scoping today:** the GitHub login is used as the scoping key
  throughout `src/server.ts` (E*TRADE tokens, Durable Object instance
  names, `x-user-login` forwarding). `src/agents/did.ts` derives a DID
  from the GitHub login.
- **Audit:** `src/agents/routes/audit.ts` — GET/POST `/api/audit` and
  POST `/api/audit/event` over the `mas_events` table (#270, #359-04),
  scoped by `session_id`. Tests: `tests/audit-event-endpoint.test.ts`,
  `tests/audit_routes_extraction.test.ts`.
- **Adjacent identity work:** API keys (`src/security/apiKeys.ts`),
  agent payments identity binding tests
  (`tests/agentic_payments_identity_binding.test.ts`), DID proof tests
  (`tests/did_proof_honesty.test.ts`).

### Gaps against #945 (each gap is a future slice, not a claim)

| #945 requirement | Current state | Gap |
|---|---|---|
| Stable internal identities for humans, services, agents, runs, tasks, delegations, approvals (§3) | `SessionData` is only `{ githubLogin, githubAvatar, githubName, createdAt }` (`src/types.ts`) | No internal user ID, no service principal, agent definition/instance, run, task, delegation, or approval identity |
| External identity mapping by validated issuer + subject (§3) | GitHub login string is the identity | Email/login can change; no issuer/sub binding, no linking proof, no duplicate-account handling |
| Google/GitHub login through maintained integrations, extensible provider boundary (§10.3) | GitHub only | No Google login, no Auth0, no OIDC issuer/audience/expiry validation layer |
| Secure sessions: duration, idle/absolute expiry, rotation, revocation, step-up (§4) | 7-day TTL, logout delete | No idle expiry, rotation, revocation propagation contract, or step-up freshness |
| Tenant/workspace membership and scoped role bindings (§10.5) | None found; scoping is per-GitHub-login | No tenant, workspace, membership, or role model |
| Fine-grained, default-deny, server-side authorization (§5, §10.6) | No authorization decision point found; routes check session presence | No policy decision point (PDP), no permission matrix, no resource/context/delegation checks |
| Bounded, revocable agent delegation (§5) | None found | No delegation scope, expiry, budget, re-delegation, or revocation behavior |
| Attributable, integrity-protected audit evidence (§6) | `mas_events` rows: id, type, agent, payload, created_at, session_id | No initiator, tenant/workspace, policy version, decision, approval, correlation, or outcome fields as required by #945 §6; no tamper-detection or audit-failure policy |
| Revocation, recovery, offboarding (§7) | Logout deletes one session | No defined behavior for cached decisions, API credentials, running tasks, pending approvals, or queued actions |

### Reference implementation note

#945 names cfpay #252 as the existing reference implementation,
described in the epic as "code-complete, dark pending owner OAuth/secret
actions". That pattern is the warning for this epic too: provider
integration must not be presented as live until the owner OAuth/secret
actions it depends on are actually completed. No provider is wired in
this spec step, so no such dependency is created yet.

## 3. Architecture options (decision required, not made here)

### Option A — Auth0 as identity provider, application-owned authorization

- Auth0 (or Auth0 Organizations) issues human identities; the
  application binds `(issuer, subject)` to a stable internal user ID,
  owns tenant/workspace memberships, roles, delegation, and the PDP,
  and owns audit evidence.
- Fits #945's title and its provider-selection matrix (§9), and keeps
  the authorization decision inside the application where resource,
  tenant, delegation, and approval context live.
- Cost/complexity: Auth0 pricing for custom roles, enterprise
  federation, organization scale, and audit features is **not verified
  in this document** — see Open decisions. Free-tier availability
  must not be assumed to cover production needs (#945 §9).

### Option B — Application-owned OIDC (Google + GitHub first, Auth0 later)

- Keep the existing GitHub OAuth, add Google through the same
  integration boundary, and implement the internal identity, membership,
  PDP, delegation, and audit layers first. Auth0 becomes a later
  provider behind that boundary, not a prerequisite for the core.
- Lower immediate provider dependency and secret surface; the core
  layers are provider-independent and survive a later provider change.
- Trade-off: the application owns more of the provider-integration
  burden (session, step-up, recovery) that Auth0 would otherwise
  provide.

### Option C — Auth0 for identity AND authorization

- Delegate roles/permissions to the provider's authorization features.
- Rejected as the default in this spec (to be challenged in review):
  #945 §5 requires resource, tenant, delegation, approval, and context
  checks that live in application state, and §9 warns that a provider
  may charge for exactly the custom-role/organization/audit features
  this epic needs. If this option is chosen, the spec must show how
  each §5 check is evaluated server-side, not only in the UI or token.

**Recommended default for review: Option A for identity, with
application-owned authorization (i.e. A, not C), unless the cost
verification in Open decisions changes it. Option B is the fallback
if Auth0 cost or owner OAuth actions block A.**

## 4. Proposed data model (additive, backward-compatible)

No existing field is renamed or removed in this spec. New fields are
optional until a migration slice adopts them, so existing sessions
keep working.

```typescript
// Proposed — not yet implemented.
interface IdentityBinding {
  internalUserId: string;          // stable, never derived from email/login
  providerIssuer: string;           // validated issuer, e.g. GitHub / Google / Auth0
  providerSubject: string;          // provider-stable subject, never email alone
  linkedAt: number;
  proofOfControl: "oidc" | "invitation" | "recovery";
}

interface Membership {
  membershipId: string;
  internalUserId: string;
  tenantId: string;
  workspaceId?: string;
  roleBindings: RoleBinding[];      // roles bundle permissions; they are not the decision
  createdBy: string;
  createdAt: number;
  revokedAt?: number;
}

interface RoleBinding {
  role: string;                     // e.g. tenant-admin, workspace-admin, member, approver, auditor
  scope: "platform" | "tenant" | "workspace" | "resource";
  resourceId?: string;
  grantedBy: string;
  expiresAt?: number;
}

interface Delegation {
  delegationId: string;
  initiatorId: string;              // initiating human/service principal
  agentInstanceId: string;
  taskId: string;
  allowedActions: string[];         // explicit, not "all"
  resourceScope: string[];
  expiresAt: number;
  budget?: { maxActions?: number; maxCost?: number };
  reDelegation: "forbidden" | "scoped";
  revokedAt?: number;
}

interface AuthorizationDecision {
  principalId: string;
  membershipId?: string;
  action: string;                   // e.g. artifact:export, task:cancel
  resourceId?: string;
  tenantId: string;
  workspaceId?: string;
  delegationId?: string;
  approvalId?: string;
  decision: "allow" | "deny";
  policyVersion: string;
  reason: string;
  decidedAt: number;
}

// IAAA audit event — extends mas_events, does not replace its existing
// session-scoped rows until a migration slice says so (#945 §6).
interface IaaaAuditEvent {
  id: string;
  timestamp: number;                // trusted time
  type: string;
  actorPrincipalId: string;
  actorType: "human" | "service" | "agent";
  initiatingPrincipalId: string;
  tenantId: string;
  workspaceId?: string;
  taskId?: string;
  agentInstanceId?: string;
  agentRunId?: string;
  delegationId?: string;
  correlationId: string;
  action: string;
  resourceId?: string;
  decision: "allow" | "deny";
  policyVersion: string;
  approvalId?: string;
  outcome: "succeeded" | "failed" | "pending" | "unknown";
  errorCode?: string;
  // Never raw credentials or tokens. Authentication assurance/session
  // references only.
}
```

Session evolution (future slice, not this document): extend
`SessionData` with `internalUserId`, `providerIssuer`,
`providerSubject`, `tenantId`, `authTime` (for step-up freshness),
and `sessionVersion` (for revocation propagation) — all optional
until adoption, so old sessions are not invalidated by the spec.

## 5. Permission matrix (from #945 §5; grant rules to be confirmed)

Default: **deny**. Possessing a permission must not automatically
grant permission to grant it to others. Platform administration is
separate from tenant administration; a tenant administrator cannot
grant platform privileges.

| Permission | Platform admin | Tenant admin | Workspace admin | Member | Approver | Auditor |
|---|---|:---:|:---:|:---:|:---:|:---:|
| membership:invite | — | ✓ | ✓ (workspace) | — | — | — |
| membership:revoke | — | ✓ | ✓ (workspace) | — | — | — |
| role:assign | ✓ (platform) | ✓ (tenant) | ✓ (workspace) | — | — | — |
| task:create / task:read / task:cancel | — | ✓ | ✓ | ✓ (own scope) | — | read |
| artifact:read / artifact:edit / artifact:export | — | ✓ | ✓ | ✓ (own scope) | — | read |
| integration:connect / integration:use / integration:manage | — | ✓ | ✓ | use (granted) | — | — |
| action:propose / action:approve / action:execute | — | ✓ | ✓ | propose | approve (assigned) | — |
| audit:read / audit:export | ✓ (platform) | ✓ (tenant) | ✓ (workspace) | — | — | read |

Every permission above is evaluated at the PDP as:
principal + active membership + role permissions + resource
relationship + tenant/workspace policy + delegation limits +
approval requirements + relevant context. Role alone never decides.

## 6. Acceptance tests (from #945 §8, mapped to future test files)

| #945 demonstration | Future test (TDD, red first) |
|---|---|
| Email changes do not create a new identity or transfer another user's account | `tests/iaaa_identity_binding.test.ts` |
| Unproven provider linking is rejected | `tests/iaaa_identity_binding.test.ts` |
| Invalid, expired, wrong-issuer, or wrong-audience tokens are rejected | `tests/iaaa_oidc_validation.test.ts` |
| Sensitive actions enforce authentication freshness / step-up | `tests/iaaa_step_up.test.ts` |
| Tenant A cannot access Tenant B's resources via direct IDs, search, exports, or jobs | `tests/iaaa_tenant_isolation.test.ts` |
| A tenant administrator cannot grant platform privileges | `tests/iaaa_authorization.test.ts` |
| Agents cannot expand delegated scope or reuse revoked authority | `tests/iaaa_delegation.test.ts` |
| Material proposal changes invalidate prior approval | `tests/iaaa_approval.test.ts` |
| A consequential action traces to initiator, workload, delegation, policy, approval, outcome | `tests/iaaa_audit.test.ts` |
| Audit failures are detected and handled per policy | `tests/iaaa_audit.test.ts` |
| Membership revocation affects sessions, queued work, active tasks per contract | `tests/iaaa_revocation.test.ts` |
| Interrupted execution reconciles without blindly repeating side effects | `tests/iaaa_recovery.test.ts` |
| Legitimate workflows still succeed (a system that denies everything fails) | every test file above, positive cases |

## 7. Migration plan (incremental, per #945 §10 order)

1. **This spec** — review by CISO (security requirements), CTO
   (implementation), CDO (identity-data integrity), Independent
   Evaluation. No code, no secrets.
2. **Slice 1 — stable internal identities + provider binding
   (pure, no provider wiring).** `IdentityBinding` resolution from
   `(issuer, subject)`; email/login never creates or transfers an
   identity; unproven linking rejected. Tests in §6, row 1–2.
3. **Slice 2 — login/session hardening.** Provider boundary for
   Google alongside GitHub (or Auth0, per Open decisions); session
   rotation, idle/absolute expiry, revocation propagation contract.
4. **Slice 3 — membership + scoped authorization (PDP).** Tenant/
   workspace memberships, role bindings, permission matrix (§5),
   default-deny enforcement at APIs, jobs, tools, storage, retrieval,
   artifacts, exports, notifications — not only UI.
5. **Slice 4 — delegation.** Bounded, expiring, revocable delegation;
   re-check authority before delayed/consequential execution.
6. **Slice 5 — accountability.** IAAA audit events (§4), audit
   failure policy (which consequential actions block when audit
   cannot be recorded), retention, tamper detection, audit-access
   logging.
7. **Slice 6 — lifecycle verification.** Revocation, recovery,
   offboarding, and the §8 acceptance suite end-to-end; then, and
   only then, rollout behind a flag with rollback.

Each slice is one issue → branch → PR → merge into `main` →
post-merge verification (AGENTS.md §11), TDD red→green, never over a
red required check, agent hashtag on every issue/PR, pins updated in
the same PR if altered, §15 completion report on close.

## 8. Open decisions (owners, due before the slice that needs them)

| Decision | Owner | Due before |
|---|---|---|
| Auth0 (Option A) vs application-owned OIDC first (Option B) | CTO + CISO, human owner approves provider | Slice 2 |
| Auth0 production costs: custom roles, federation, org scale, audit | Finance + CTO | Slice 2 |
| Tenant model: Auth0 Organizations vs application-owned tenants | CTO + CDO | Slice 3 |
| Step-up thresholds: which actions require freshness, and how fresh | CISO | Slice 2 |
| Revocation propagation requirement (measurable, not "instant") | CISO + CTO | Slice 2 |
| Audit retention, tamper-detection mechanism, audit-failure blocking set | CISO + CDO | Slice 5 |
| Migration of existing GitHub-login-scoped data (E*TRADE tokens, DO names) to internal IDs | CDO + CTO | Slice 1 |
| Whether #945 stays one epic issue or is split into slice issues | CEO-aimp + human owner | Slice 1 |

## 9. Explicit non-goals for this spec

- No Auth0 tenant, application, secret, or callback is created.
- No production user, session, token, or permission is changed.
- No claim that social login establishes legal identity or a
  particular assurance level (#945 §2).
- No weakening of existing controls, no privilege expansion, no
  change to protected criteria, and no self-promotion of this spec
  (#945 §10).
