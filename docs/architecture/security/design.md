# Security architecture — main document

This folder is the single home for cfagent's security documentation.
Every security workflow is documented as its own document; this page is
the map, not another copy of the content.

## 1. The folder

| Document | What it answers |
| --- | --- |
| [security-workflow.md](security-workflow.md) | The holistic picture: how a request, a user, unattended work, and a secret each flow through the system, and what each failure must do |
| [identity-lifecycle.md](identity-lifecycle.md) | The entire IAAA identity lifecycle: provisioning, active life, deprovisioning/offboarding, re-provisioning — and which parts are live vs machinery |
| [email-communications.md](email-communications.md) | Email lifecycle: what mail exists today (trading channel) vs PROPOSED welcome, daily digest, preferences/opt-out, and deactivation coupling |
| [authn.md](authn.md) | User security: providers, sessions, step-up, identity rules |
| [authz.md](authz.md) | Authorization: PDP, permissions, roles, memberships, delegation, bootstrap/genesis |
| [zero-trust.md](zero-trust.md) | Zero-trust posture (ZTZ) as actually implemented, including the honest gaps |
| [api-security.md](api-security.md) | API surface security: dispatch order, per-route gating, API keys, docs routes, public surfaces |
| [mcp-security.md](mcp-security.md) | MCP + A2A security: transport auth, the scanner exception, catalog vs transport |
| [workflow-security.md](workflow-security.md) | Workflow security: unattended identities, tick guards, kill switches, renewal |
| [etrade.md](etrade.md) | E*TRADE security flow (formerly this file's content): per-user OAuth, token resolution, the `default_trader` exception |
| [iaaa-provider-onboarding.md](iaaa-provider-onboarding.md) | How to onboard a login provider (plugin architecture, checklist) |
| [iaaa-google-defaults.md](iaaa-google-defaults.md) | Google login defaults (worked onboarding example) |
| [iaaa-github-end-to-end-defaults.md](iaaa-github-end-to-end-defaults.md) | GitHub end-to-end defaults: tenant, bootstrap, PDP gates |
| [iaaa-admin-ui.md](iaaa-admin-ui.md) | IAAA admin panel: overview endpoint, tabs, gating, known gaps |
| [assessment/assessment-01.md](assessment/assessment-01.md) | Security assessment (pre-existing) |

Moved here from `docs/` in the #1071 consolidation: the four `iaaa-*.md`
documents (content unchanged except same-directory link fixes) and the
E*TRADE flow (renamed from `design.md` to `etrade.md`, so this page could
become the hub). Deliberately left in `docs/`: `THREAT_MODEL.md` and
`COMPLIANCE.md`, which are not part of the IAAA set this consolidation
covers.

## 2. Reading paths

- **New to the system:** this page → [security-workflow.md](security-workflow.md)
  → [authn.md](authn.md).
- **Auditing a specific surface:** go straight to its document in the table.
- **Identity lifecycle:** [identity-lifecycle.md](identity-lifecycle.md) — provisioning, deprovisioning, and re-provisioning as IAAA defines them.
- **Adding a provider:** [iaaa-provider-onboarding.md](iaaa-provider-onboarding.md),
  with [iaaa-google-defaults.md](iaaa-google-defaults.md) as the example.
- **Changing a gate:** the owning document first, then
  [zero-trust.md](zero-trust.md) §6 (rules for extending the posture).
- **Reviewing the exception:** [etrade.md](etrade.md) §7 and issue #1066.

## 3. Principles the whole folder stands on

1. **One app credential, one token per user.** No user trades on
   another user's token; signing in links nothing by itself.
2. **Default deny, fail closed.** No rule means no access; every
   uncertain state resolves to "no", observably.
3. **Identity is (issuer, subject).** Email and login are never identity.
4. **Revocation is never gated.** The escape hatch must work even when
   policy would say no.
5. **Gaps are documented, not hidden.** A control that is open,
   unverified, or legacy says so in its own document.

## 4. Open items that constrain these docs

- **#945 open list:** provider choice decided (APP-OWNED provider, FOSS
  framework, APP-OWNED tenant — owner direction 2026-10-25), step-up/idle
  thresholds settled as CISO values (#1757 decision record), measurable
  revocation propagation partially settled (#1750 targets; remainder
  carried — see the #1757 record), audit retention/tamper response and
  the consequential-action blocking set carried to Slice 5 adoption (Q7),
  DO-naming cutover beyond aliases, vars externalization, §15 completion
  report.
- **#1066:** remove the `default_trader` static-token exception via the
  explicit service identity (Phases A–C).
- **#1024:** `DOCS_PUBLIC_SURFACES` decision (docs routes are
  provisionally session-gated); A2A POST per-agent authentication
  unverified; framework-adapter conformance must preserve dispatch
  order and the MCP session-or-API-key fallback exactly.
- **#907:** kill switch as a measurable objective and the
  RiskPolicyEngine boundary (proposal, not adopted).

A design that assumes any of these away is wrong. When one closes, its
document is updated in the same change — docs and code move together,
and a doc that contradicts the code is a bug in the doc.
