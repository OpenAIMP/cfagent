# IAAA provider onboarding — checklist (issue #945)

## Agent #ceo-aimp

This is the composable, extensible provider architecture: a new
login provider plugs into cfagent without changing dispatch,
without touching the Slice 1/3/5 policy modules, and without
changing any existing provider's behaviour. Enablement is config
only, with rollback by config only. Google is the worked example
of every step below (see `iaaa-google-defaults.md`); GitHub
predates the factory and keeps its own adapter, but dispatches
through the same registry and the same generic wired tail.

## The pieces (what plugs where)

| Piece | File | Role |
|---|---|---|
| Registry | `src/security/providers.ts` | `LoginProvider` interface (`providerId`, `protocol`, `issuer`, optional `displayName`, `startLogin`, `handleCallback`); `defaultRegistry`; `resolveLoginProvider` (never falls back); `enabledProviders` / `isProviderEnabled` from `IAAA_WIRING_ENABLED` + `IAAA_ENABLED_PROVIDERS`. |
| Generic OIDC factory | `src/security/oidcProvider.ts` | `createOidcProvider(options)` → `LoginProvider` for any authorization-code provider. Owns start redirect, state, code exchange, userinfo fetch, validation, normalization. |
| Generic wired tail | `src/security/iaaaLogin.ts` | `completeWiredLogin(env, issuer, normalizedProfile, options)`: Slice 1 binding, extended session, alias + bootstrap post-login, login audit. Every adapter funnels through it. |
| Generic routes | `src/server.ts` | `/auth/login/<providerId>`, `/auth/callback/<providerId>` (registry dispatch, same wired-callback options as GitHub); `/login` renders one button per enabled, registered provider. |
| Policy (DO NOT MODIFY for a new provider) | `src/security/identityBinding.ts`, `authorization.ts`, `iaaaAudit.ts`, `iaaaBootstrap.ts`, `iaaaMigration.ts`, `iaaaGithubEndToEnd.ts`, `iaaaPdpSeam.ts` | Provider-agnostic: they key off `internalUserId` and `(issuer, subject)`. A new provider needs no change here — if you think it does, the adapter's normalization is wrong. |

## Checklist

### 1. Decide the subject (before writing code)

- What is the provider-stable subject? It must be immutable
  and unguessable-enough to bind: a numeric user id (GitHub),
  an OIDC `sub` (Google), a tenant-scoped id (Auth0). It is
  NEVER a login, username, or email — those change and recycle.
- What is the legacy login key? The value that fills the
  pre-existing `githubLogin`-keyed paths (DO routing, token
  keys, `/api/me`) and the alias record. For GitHub it is the
  login; for Google, the verified email. It is display/lookup
  data, not identity.
- What proves control? The server-side code exchange plus a
  profile/userinfo fetch with the fresh token — the same proof
  GitHub and Google use. No unproven linking, ever.

### 2. OIDC / authorization-code provider: one factory call

Register in `src/security/providers.ts` (the `defaultRegistry`
block), mirroring Google:

```ts
registry.registerProvider(
  createOidcProvider({
    providerId: "<id>",            // lowercase, URL-safe: it becomes /auth/callback/<id>
    issuer: "https://<issuer>",    // validated issuer for the binding, never for display
    displayName: "<Name>",         // login page button label
    authorizationEndpoint: "https://<provider>/authorize",
    tokenEndpoint: "https://<provider>/token",
    userinfoEndpoint: "https://<provider>/userinfo",
    clientIdEnv: "<PROVIDER>_CLIENT_ID",
    clientSecretEnv: "<PROVIDER>_CLIENT_SECRET",
    scope: "openid email profile", // or the provider's equivalent
    subjectField: "sub",           // default; set only if the provider differs
    loginKeyField: "email",        // userinfo field for the legacy login key
    requireEmailVerified: true,    // when the login key is an email
  })
);
```

Add the two env names as optional fields on `Env` in
`src/types.ts`, with the comment that they are owner-set secrets
(dashboard or `wrangler secret put`), never committed and never
in `wrangler.jsonc`. No other production file changes: no route,
no dispatch, no policy module.

### 3. Non-OIDC provider: implement `LoginProvider`

If the provider does not speak the authorization-code +
userinfo flow (like GitHub's OAuth2 + profile fetch), write a
small adapter module that owns its own start/callback, then:

- normalizes the fetched profile to
  `{ subject, loginKey, displayName, avatarUrl }`,
- fails closed on every validation failure (no binding, no
  session), and
- delegates to `completeWiredLogin(env, issuer, profile, options)`
  for binding, session, post-login, and audit.

Register it in `defaultRegistry` the same way. Do not copy the
wired tail into the adapter — a copied tail drifts, and the next
provider inherits the drift.

### 4. Fail-closed tests (TDD-first, mocked fetch, fake credentials)

Cover, at minimum: start redirect parameters + state; missing
client id/secret at start time → error page, never a redirect;
bad state → 403 before any upstream call; token/userinfo
failure → error page; missing subject → no binding, no session;
missing/unverified login key → no binding, no session;
successful flow → session carries `internalUserId`,
`providerIssuer`, `providerSubject`, `sessionVersion` 1, and the
legacy display fields; same subject re-binds to the same
internal id. Then route tests: wiring off → 403; unlisted →
403; listed-but-unregistered → 403; listed + registered →
dispatch; `/login` shows one button per enabled provider and
the legacy page is byte-identical with nothing enabled.

### 5. Docs

- A `<provider>-defaults.md` mirroring
  `iaaa-google-defaults.md`: identity/subject mapping,
  login-key choice + fail-closed rules, tenant default
  (`"primary"` unless `IAAA_TENANT_ID` is set), bootstrap
  format (`<issuer>:<subject>`, optionally `platform:`-prefixed
  for the genesis rule), PDP/idle/audit behaviour (shared, via
  `internalUserId`), credential setup steps, rollback, and
  known limitations with their follow-ups.
- Update this checklist if the onboarding path itself changes.

### 6. Enable (separate step from shipping code)

1. Owner creates the provider-side OAuth client with the
   redirect URI
   `${APP_BASE_URL}/auth/callback/<providerId>`
   (default base `https://agent.openaimp.com`).
2. Owner sets the client id/secret as Cloudflare secrets.
3. Enablement PR (config only, same pattern as the GitHub
   enablement): add `<providerId>` to `IAAA_ENABLED_PROVIDERS`
   with `IAAA_WIRING_ENABLED=1`, redeploy.
4. Verify: the `/login` button appears; a sign-in completes;
   logout works; the session carries `internalUserId`
   (visible via `/api/me`).
5. Bootstrap (if the new provider's user is an admin): add
   `<issuer>:<subject>` (or a bare internal id, or a
   `platform:`-prefixed entry for the genesis window) to
   `IAAA_BOOTSTRAP_ADMINS`, redeploy, and have that user log in
   once to provision the membership.

**Rollback at any stage: remove `<providerId>` from
`IAAA_ENABLED_PROVIDERS` (or unset `IAAA_WIRING_ENABLED`),
redeploy. No code change.** Sessions already created keep
working; recorded memberships and aliases are not deleted by
rollback.

## 7. Known limitations: file the follow-up before enablement (issue #1759)

A new provider MUST NOT land as "done" while its known
limitations are undocumented. Before the enablement step (§6),
the provider's `<provider>-defaults.md` MUST carry a "Known
limitations" section naming, for each limitation that applies to
that provider, the limitation, its user-visible effect, and its
follow-up issue (or the decision that closes it). The checklist
items below are obligations, not suggestions — an enablement PR
whose defaults doc omits one of them is incomplete:

- **Login-keyed state cutover.** State keyed by login string
  (DO names, token keys) follows the #1759 decision:
  alias-forever for DO names (`resolveDoNameForUser` in
  `iaaaMigration.ts`) + dual-read for tokens (internal-id key
  first, alias-login key second in `etradeOAuth.ts`). The new
  provider's defaults doc MUST state whether its login key is
  covered by the alias recorded at wired login (it is, via the
  generic wired tail) and MUST name any dispatch site that still
  addresses raw login for that provider (see the adoption list
  in `iaaa-login-key-cutover-1759.md`) as a follow-up.
- **Provider-neutral DID prefix.** No session of the new
  provider may render another provider's prefix in UI. The
  defaults doc MUST confirm the provider's sessions render
  `did:user:<providerId>:<key>` via `getSessionDid` /
  `getDisplayUserDid` (server + client), and MUST name the UI
  sites verified. A hardcoded `github:` (or any other
  provider's) prefix in a rendering path for the new provider
  is a defect, not a cosmetic issue.
- **No silent identity merge.** The same login key (e.g. the
  same email) on two providers MUST NOT become one identity
  unless account linking is explicitly designed and separately
  approved. The defaults doc MUST state that the provider's
  bindings are `(issuer, subject)`-keyed and independent, and
  MUST NOT claim cross-provider linking.
- **Idle / PDP behaviour for the new provider.** The defaults
  doc MUST state the step-up freshness, idle timeout, and PDP
  behaviour that apply to the new provider's wired sessions
  (shared values or provider-specific ones, with the reason),
  and MUST name any legacy-session-style exemption that still
  applies, with its bound.
- **Follow-up ownership.** Each named limitation MUST carry
  either a follow-up issue number or a recorded decision
  closing it. "Known limitation, TBD" with no issue and no
  decision does not satisfy this section.

This section exists because Google's onboarding shipped with
its `github:`-prefixed DID and its cutover question documented
as known limitations with follow-ups owed — and the follow-ups
arrived as #1759. The next provider's limitations get their
issues at onboarding time, not discovered later.

## Flexibility notes (what the architecture deliberately allows)

- **Composition:** providers compose, they do not replace each
  other. The enabled list can hold several ids; the login page
  renders one button each; a user may hold one binding per
  provider, each mapping to their own internal id (cross-provider
  account linking is a separate feature, not implied here).
- **Config-first enablement:** nothing about a provider's
  availability lives in code paths that need redeploying logic —
  only the config list. A provider can ship registered but
  unlisted (invisible, unreachable except by direct route, which
  still 403s when unlisted).
- **Fail-closed by construction:** unlisted, unregistered, and
  unconfigured are three distinct 403/error outcomes, and none
  falls back to another provider. A misconfigured new provider
  cannot break GitHub login, because dispatch never falls
  through to it.
