# IAAA Google login — defaults (issue #945)

## Agent #ceo-aimp

This document records the Google login slice: Google as a plugin on
the provider architecture, built exactly the way GitHub is wired,
with no change to any GitHub behaviour. Google is the worked example
of the composable provider architecture documented in
`iaaa-provider-onboarding.md` — a future provider registers
the same way. Anything marked PROPOSED or NOT DECIDED below still
needs its owner decision, and this document must be updated when
that decision lands.

## What the slice wires (all gated, all best-effort where stated)

- **Google as a registry plugin.** `src/security/oidcProvider.ts`
  (`createOidcProvider`) turns endpoint + env + field-mapping
  options into a `LoginProvider`; `src/security/providers.ts`
  registers Google with one factory call. No dispatch code in
  `server.ts` names Google: the new additive routes
  `/auth/login/<providerId>` and `/auth/callback/<providerId>`
  resolve through `resolveLoginProvider` and dispatch through the
  adapter, exactly like the GitHub routes do. The exact
  `/auth/login`, `/auth/callback`, and `/login` GitHub behaviour
  is unchanged.
- **Generic wired tail, reused — not copied.** The Google
  callback funnels through `completeWiredLogin` in
  `src/security/iaaaLogin.ts`, the same tail GitHub's wired
  callback delegates to: Slice 1 binding, extended session, alias
  recording + bootstrap-on-login (when post-login is enabled),
  and login success/failure audit (best-effort, never changing
  the login outcome). The Slice 1/3/5 policy modules
  (`identityBinding`, `authorization`, `iaaaAudit`,
  `iaaaBootstrap`, `iaaaMigration`, `iaaaGithubEndToEnd`,
  `iaaaPdpSeam`) are untouched: they are provider-agnostic and
  key off `internalUserId`, so PDP gates, idle/step-up, and audit
  apply to wired Google sessions exactly as to GitHub ones.
- **Composable login page.** `/login` renders one button per
  enabled, registered provider (computed in `server.ts` and
  passed in — `githubOAuth.ts` does not import `providers.ts`,
  which would create an import cycle). With nothing enabled, the
  page is exactly the legacy GitHub-only page.
- **Alias recording on login.** After Slice 1 binding succeeds,
  the login-key→internalUserId alias is recorded via
  `iaaaMigration.ts`. A conflict records nothing, preserves the
  original, and never fails or changes the login.
- **Bootstrap-on-login.** After binding, `IAAA_BOOTSTRAP_ADMINS`
  is parsed and, if the logging-in user's internal id (or
  issuer:subject) is listed and they hold no membership in the
  tenant, they are provisioned — including the platform-admin
  genesis rule for `platform:` entries, shared with GitHub. If
  the list is unset or blank, NOTHING is provisioned and login is
  unchanged. No hardcoded user ids, emails, or subjects exist
  anywhere. No new secret, no setup endpoint.

## Identity and session mapping (read this first)

- **True identity is Slice 1 `(https://accounts.google.com, sub)`
  → `internalUserId`.** The Google `sub` claim is the stable
  subject; it is the only value the binding is ever keyed on.
- **The email is NEVER identity.** It is only the
  adapter-supplied legacy login key: Google sessions set
  `githubLogin` to the verified email, `githubName` to the
  profile name, and `githubAvatar` to the profile picture, so
  the pre-existing githubLogin-keyed paths (DO routing, E*TRADE
  token keys, `/api/me`) keep working unchanged. A later email
  change or reuse never moves the binding — but it does change
  which legacy key the session carries, exactly as a GitHub login
  change does for GitHub sessions.
- **Fail-closed rules (no binding, no session on violation):**
  a missing/blank `sub`; a missing/blank email; an unverified
  email (`email_verified` must be `true`); a missing OAuth client
  id or secret at start time (error page, never a redirect); a
  bad state (403, before any upstream call); a token or userinfo
  failure. The userinfo fetch with the fresh access token IS the
  proof of control for the binding, as the GitHub profile fetch
  is for GitHub.
- **Session fields.** A Google wired session carries
  `internalUserId`, `providerIssuer`
  (`https://accounts.google.com`), `providerSubject` (`sub`),
  `authTimeMs`, `sessionVersion` 1, and `lastActivityMs`, plus
  the legacy display fields above — the same shape as a GitHub
  wired session.

## Defaults chosen

- **Tenant: `IAAA_TENANT_ID` if set, else `"primary"`.** The
  same single-tenant default as the GitHub end-to-end slice,
  resolved at the call site (`resolveIaaaTenant`); the audit and
  bootstrap modules still take `tenantId` explicitly and invent
  nothing. A multi-tenant deployment must set `IAAA_TENANT_ID`
  explicitly.
- **Bootstrap format: `platform:https://accounts.google.com:<sub>`
  (or a bare internal user id UUID, or a non-prefixed
  issuer:subject entry).** The existing parser resolves it
  through the Slice 1 binding with no change; the `platform:`
  genesis rule (first `platform:` login wins, once, tracked by
  the `iaaa-bootstrap:platform-genesis:<tenantId>` marker) is
  shared with GitHub — a Google genesis and a GitHub genesis
  compete for the same one-time window, by design.
- **PDP flag: shared `IAAA_PDP_ENABLED` (default OFF).** When ON
  and the session is wired, the same gated routes and the same
  `integration:connect` permission apply (see
  `iaaa-github-end-to-end-defaults.md` for the gated set and
  the deliberately-ungated routes). Default-deny within the gated
  set: a wired Google session with no membership is denied, the
  same as a GitHub one.
- **Step-up freshness: 15 minutes. Idle timeout: 30 minutes.**
  PROPOSED defaults from Slice 2, NOT settled CISO thresholds —
  shared with GitHub, recorded here as the values actually
  enforced.
- **Audit retention: NOT DECIDED.** Same as GitHub: the Kv audit
  store is append-only and unbounded until the retention
  decision lands; no retention period is invented here.
- **Revocation propagation: numeric targets (#1750).** Same as
  GitHub: membership revocation 0 ms, API-key deletion 0 ms,
  admin removal 0 ms, token expiry 0 ms past the deadline,
  session revocation 0 ms same-isolate and ≤ 60 s every isolate.
  Full table, measurement rule, and residual gaps:
  [authz.md §9](authz.md) and `src/security/revocationTargets.ts`.

## Known limitation (documented, not hidden)

- **The client-side DID string still renders with the `github:`
  prefix for Google sessions** (`did:user:github:<email>` in the
  UI components that derive it from `user.login`). The prefix is
  display text, not identity — authorization never keys off it —
  but it is factually wrong for a Google session. The follow-up
  is a provider-neutral login key + DID prefix (a session
  generalization across the githubLogin-keyed sites), NOT a
  silent relabelling here. Until that lands, a Google session's
  authoritative identity is always its `internalUserId` and its
  `(issuer, sub)` binding, never the displayed DID.

## Credential setup (owner steps — no secret is invented here)

1. In Google Cloud Console, create an OAuth 2.0 client (web
   application) and add the authorized redirect URI:
   `https://agent.openaimp.com/auth/callback/google`
   (or `${APP_BASE_URL}/auth/callback/google` if the deployment
   base URL differs).
2. Set the credentials as Cloudflare secrets — never in
   `wrangler.jsonc` and never in the repo:
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
   (dashboard, or `wrangler secret put` for each).
3. Enablement (separate PR, same pattern as the GitHub
   enablement): add `google` to `IAAA_ENABLED_PROVIDERS`
   (e.g. `github,google`) with `IAAA_WIRING_ENABLED=1`, redeploy.
   The `/login` page then shows the Google button.
4. Production smoke test: sign in with Google, confirm the
   authenticated app load and logout, and confirm the session
   carries `internalUserId` (visible via `/api/me`).

Until steps 1–3 exist, shipping this code surfaces nothing: the
button is gated on the enabled list, and the adapter fails
closed with an error page if invoked without credentials. GitHub
login is unaffected at every stage.

**Rollback: remove `google` from `IAAA_ENABLED_PROVIDERS` (or
unset `IAAA_WIRING_ENABLED`), redeploy. No code change.**
Existing sessions keep working; memberships and aliases already
recorded are not deleted by rollback (rollback removes the login
path and, with the PDP flag off, enforcement — not data).

## Still owner-decided (not decided by this slice)

- Google OAuth client creation and secret provisioning (above).
- The enablement PR and the production Google smoke test.
- Settled step-up / idle thresholds (15 min / 30 min above are
  proposed defaults only).
- A measurable revocation propagation target.
- Audit retention, tamper response, and the consequential-action
  blocking set — including whether a failed audit write should
  BLOCK a wired login (this slice does NOT block on audit
  failure; that CISO decision remains open).
- The provider-neutral login key + DID prefix follow-up.
- The §15 completion report and the owner decision to close #945.
