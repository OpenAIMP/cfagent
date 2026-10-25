# Multi-Dimensional System — Plan

### Delivery plan for the #1069 multi-dimensional system requirement: security first, the remaining dimensions as sequenced follow-ups

**Source requirement:** #1069 — Multi-dimensional System
**Tracking epic:** #1070
**Agent:** #CAIO-quns (RSI-CAIO lane)
**Date:** 2026-10-22
**Delivery policy:** `docs/agents/gitops.md` — independent issues may proceed in parallel on separate branches; each issue follows issue → branch → PR → merge into `main` → post-merge CI verification → §15 completion report before it is Done.

## Method

#1069 is a classification-and-verification requirement before it is a build list. For every dimension this plan records: identity, ownership, scope, cardinality, lifecycle, isolation, authorization, configuration, limits, observability, and verification — and a status of **supported now**, **extension-ready**, **planned**, or **out of scope**. A dimension is never marked supported because an interface or a configuration field exists; supported means a combination test passes (§10 of #1069).

Security is sequenced first (owner direction, 2026-10-22) because every other dimension inherits its guarantees from the identity, authorization, and execution-context layer. The remaining dimensions follow in dependency order, each as its own child issue under #1070.

## Current-state assessment (verified 2026-10-22, main @ e8809b9)

| Dimension group (#1069) | Status | Evidence / owner |
|---|---|---|
| Multi-tenant, multi-user, multi-membership, multi-workspace | Extension-ready, in flight | Epic #945 (CISO lane) owns multi-tenant IAAA; membership store, PDP seam, enforcement, gates, and audit exist in `src/security/iaaa*`. End-to-end isolation not yet claimed. |
| Multi-role, multi-scope authorization | Extension-ready, in flight | `src/security/authorization.ts`, `iaaaPdpSeam.ts`, `iaaaEnforcement.ts` (#945). |
| Multi-identity-provider | Extension-ready | Google enabled (f4e679a); GitHub OAuth exists (`src/security/githubOAuth.ts`); Microsoft not started. Architecture decision (Auth0 vs application-owned) open in `docs/plans/IAAA-945-spec.md`. |
| Multi-authentication-method | Partial | Federated login + per-user API keys (`cfk_`, #180); passkeys/MFA not started; step-up rules live in #945. |
| Multi-principal, multi-delegation | Partial | `src/security/delegation.ts`, IAAA audit chain; no single validated context contract (Phase S1). |
| Multi-session | Partial | Session policy/store in `src/security/session*.ts`; revocation semantics owned by #945. |
| Shared execution context (#1069 §8) | **Planned — Phase S priority** | Fields exist piecemeal (audit, delegation, task ids); no validated server-side contract, no fail-closed authority binding. |
| Multi-service, multi-agent, multi-model | Supported now (registration pending) | Services under `src/services/`, Think-based agents, model routing in `src/models/`; needs registry entries + verification references, not new capability. |
| Multi-provider (brokerage) | Extension-ready | E*TRADE is the only live provider; Public.com is a data-source reference only (`src/trading/dataSources.ts`). |
| Multi-connection, multi-account | Partial | Per-user E*TRADE token flow documented in #1066, including the legacy `default_trader` exception — an isolation debt Phase S dispositions. |
| Multi-plan, entitlements, metering, budgets | Extension-ready | Premium/payment routes and x402/Stripe flows exist; no coherent commercial dimension yet (Phase F3). |
| Multi-environment | Partial | Sandbox/live on the trading path; no platform-wide environment dimension with promotion rules (Phase F4). |
| Versioned contracts | Partial | OpenAPI spec in `src/security/openapiSpec.ts`; contract versioning policy not defined per dimension. |
| Tenant-scoped audit and recovery | Partial | IAAA audit stores exist (#945); recovery semantics per tenant not yet verified by test. |
| Multi-currency, multi-language, multi-brand, multi-region, dedicated tenant deployments, agent marketplace, multiple payment processors, cross-organization collaboration | Planned / requirement-driven | #1069 §9 expansion list; enter only on a concrete requirement, each as its own issue. |
| Multi-cloud, active-active global writes, arbitrary executable plugins, automatic live-trade/payment provider fallback, every agent protocol, a microservice per capability, shared learning from private tenant data | **Out of scope** | #1069 §9 "do not adopt by default." Re-entry requires an owner decision recorded on #1070. |

## Living registry (F1, #1423 — added 2026-10-25)

The table above is the **2026-10-22 snapshot** and is not rewritten; it stays
as the historical record. The living source is
[`dimension-registry.json`](dimension-registry.json), seeded 2026-10-25
against main `4bb1ba5` and pinned by `tests/dimension_registry.test.ts`
(no `supported` without a resolving verification reference; `out_of_scope`
entries cite the #1070 owner-decision requirement). Seed deltas vs the
snapshot: shared execution context (§8) moved planned → partial (S1 contract
on main, S2 matrix green, enforcement still pending — still NOT supported
per the Phase S exit criteria below), and multi-connection/multi-account
now records the #1185 removal of the `default_trader` static-token exception
instead of the snapshot's isolation-debt note. A status change is a registry
edit, re-verified against main, with its pin test updated in the same PR.

## Phase S — Security (priority)

### S1. Validated ExecutionContext contract (#1069 §8)

Define one server-side execution-context contract carrying: `tenant_id`, `workspace_id`, `principal_id`, `initiating_principal_id`, `task_id`, `agent_run_id` (optional), `delegation_id` (optional), `service_id`, `connection_id`, `external_account_id`, `environment`, `policy_version`, `entitlement_reference`, `approval_reference`, `correlation_id`.

Rules:
- The context is **resolved and validated server-side** from the authenticated principal and stored memberships/connections — never assembled from client-supplied identifiers trusted on appearance.
- Validation is **fail-closed**: missing, malformed, or unauthorized identifiers reject the operation with a correlated, audited error. No silent fallback to a shared or default identity (the failure mode fixed in #180/#183 must not re-enter through context).
- The context propagates unchanged through API → durable task → agent run → tool call; delegation can only narrow it.
- Lands in observe-mode behind a flag first (log validation outcomes), then enforcement; the flag flip is a separate, verifiable step.

TDD: unit tests for shape and authority binding (red first, §7); integration test for propagation across one real API → task → agent path; negative tests for cross-tenant identifiers, environment escalation, and missing approval reference.

### S2. Tenant-isolation combination tests (on #945 enforcement)

Automate the #1069 §10 scenario against the #945 enforcement surface: an authorized Tenant A user runs a premium screening workflow through an approved agent, using a named provider connection and external account in sandbox mode, within budget — and in the same test matrix cannot access Tenant B data, cannot switch to live execution, and cannot bypass approval. S2 starts only when #945's enforcement surface and architecture decision are on main; gaps found are filed to #945, not re-implemented here.

### S3. Isolation-debt disposition

- `default_trader` legacy exception (#1066): inventory production dependents, then remove or formally time-box it with an owner decision recorded on the S3 issue.
- `/mcp/scanner` deprecated `x-user-id` session-affinity alias (#700): confirm no identity propagation remains and close or re-scope #700 from evidence.

Phase S exit criteria: S1 enforced (not just observing), S2 matrix green on main, S3 dispositions recorded. Only then may the registry mark the §1/§8 dimensions supported.

## Follow-up phases (filed as child issues of #1070, in order)

- **F1 — Dimension registry.** A machine-readable registry (dimension, status, owner, verification reference) pinned by a test that fails when a dimension claims `supported` without a passing verification reference. Consumes Phase S outcomes first.
- **F2 — Providers, connections, accounts.** Second-provider vertical slice (Public.com) behind the provider boundary: connection lifecycle, per-tenant/per-user account binding, sandbox-first rollout. No automatic live-trading fallback (out of scope).
- **F3 — Commercial dimension.** Plans, entitlements, metering, and budgets as one coherent model wired into the execution context (`entitlement_reference`), including budget denial as a tested negative case.
- **F4 — Environments dimension.** Platform-wide sandbox/live environment model with promotion rules and approval references, replacing trading-path-only environment handling.

Each follow-up phase is split into focused child issues before implementation (§5 scope discipline); this plan does not pre-authorize their designs.

## Acceptance (program level, mirrors #1070)

- [ ] This plan is on main and linked from #1069 and #1070.
- [ ] Phase S slices delivered sequentially with §15 reports; the #1069 §10 scenario passes as an automated test.
- [ ] Dimension registry (F1) classifies every #1069 dimension; no `supported` status without a verification reference.
- [ ] F2–F4 child issues filed and linked on #1070 before the epic closes.

## Risks and open decisions

- #945's Auth0-vs-application-owned decision is open; Phase S sits on its PDP seam so either outcome works, but S2 cannot start until enforcement is on main.
- Removing `default_trader` may affect production flows; S3 requires an owner decision before removal.
- Program scope is platform-wide by design; the registry + phased follow-ups are the control against a big-bang rewrite. Hierarchy stays as in #1069 §7: users/tenants/tasks are modeled explicitly; products, providers, models, currencies, and regions are independent dimensions, not children of one tree.

## Traceability

- Requirement: #1069 (§1 dimension table, §7 model, §8 context, §9 classification, §10 acceptance scenario).
- Tracking epic: #1070.
- Identity dimension: #945 and `docs/plans/IAAA-945-spec.md`.
- Related: #488 (conformance tracker), #700 (scanner residual), #1066 (per-user E*TRADE tokens), #180/#183 (identity-binding precedents).

#CAIO-quns
