# IAAA login-keyed state cutover + provider-neutral login key and DID prefix — issue #1759

## Agent #CISO-bhdm

Parent program #1717. Source rows F-13, F-19, F-23, F-24,
F-31 (partial). Decision recorded on #1759 before the build
(comment 6468577822); this doc is the durable record of that
decision and its execution.

## 1. The decision: alias-forever + dual-read

**DO names: alias-forever. Tokens: dual-read (internal-id key
first, alias-login key second, current-login key third).
Copy-cutover: REJECTED. Dual-write alone: REJECTED as
insufficient.**

Why, in one paragraph each:

- Copy-cutover fails the safety bar. `idFromName` cannot rename
  an existing DO, so a copy must duplicate live DO state — and
  in-flight agent state can orphan mid-copy. A rename must
  never orphan live state, and a copy can. Token copies would
  also have to preserve env-prefixed variants, and old
  login-derived DIDs would break without the alias record
  anyway. The copy needs the alias; the alias does not need
  the copy.
- Dual-write alone does not solve DO names at all, and doubles
  token writes for no reachability gain over dual-read.
- Alias-forever has zero copy risk and trivial rollback: stop
  resolving through the alias and behavior is exactly today's.
  Old keys and old DO names are never deleted or renamed, so a
  rename can never lock a user out of state that still exists.
  The cost is stated honestly: login remains a naming input,
  which weakens the "login is not identity" claim for naming
  (never for authorization — the PDP never consults a login).

Rollback story: this slice adds resolution, not migration. No
data is moved, copied, or deleted. Rolling back the code
restores pre-#1759 reads (login key only, raw-login DO names);
aliases, internal-id token keys, and provider DIDs already
written are inert under old code. Existing sessions keep
working across the change in both directions.

## 2. What was executed (not just decided)

### DO names — `resolveDoNameForUser` (`iaaaMigration.ts`)

A wired user with an alias resolves to the alias login — the
name their DO state already lives under. After a rename this
is the OLD login, so the renamed session reaches its existing
state instead of addressing a fresh empty DO. A user without
an alias resolves to their current login: behavior identical
to today. The resolver never invents a name, never follows a
conflicted alias (conflicts preserve the original — a recycled
login can never hand one user's DO to another), and never
deletes or renames anything.

Live wiring in this slice: the session-driven SearchAgent
lookup in `server.ts` (telemetry enrichment). On any alias
failure it falls back to the current login — enrichment is
best-effort and a lookup failure never denies the request.
The header sent to the DO carries the resolved login so the
instance and the identity it scopes by agree.

### Tokens — identity-aware dual-read (`etradeOAuth.ts`)

`getStoredTokens`, `getRequestTokenSecret`, and
`revokeStoredTokens` accept an optional `{ internalUserId }`
(from the verified session — never from a caller-supplied
body). With an identity: the internal-id scoped key is tried
first, then the alias-login scoped key (the pre-rename key),
then the current-login scoped key, then the unscoped alias
and login keys. Without an identity, behavior is byte-identical
to before (scoped login, then unscoped login). New access
tokens stored with a known identity also land under the
internal-id scoped key (dual-read's primary). Request secrets
are dual-read only — they are 15-minute handshake state with
no long-lived key to migrate. Revocation with an identity
deletes the internal-id, alias, and login keys: a revoke must
never leave a token reachable through the fallback.

Identity-safety rule, restated because this slice moves
identity keys: the identity parameter must come from the
verified session. Passing another user's internal id would
read that user's token — the same trust rule as passing
another user's login today. No route in this slice accepts an
identity from a request body.

### Provider-neutral DID — `getLoginDid`, `getSessionDid`, `getDisplayUserDid`

- `getLoginDid(providerId, loginKey)` (`agents/did.ts`):
  `did:user:<providerId>:<cleanedKey>`. Cleaning matches the
  legacy derivation (lowercase, strip `[^a-z0-9_-]`).
- `getSessionDid(session)` (`security/iaaaLoginKey.ts`):
  resolves the provider segment from the session's own
  `providerIssuer` via the provider registry — the same source
  `/api/me` uses. No `providerIssuer` (legacy session) → the
  legacy `github:` derivation, historically accurate. Known
  issuer → that provider's id. Unknown issuer → `unknown:`,
  never a guessed provider.
- `getDisplayUserDid(login, providerId?)` (client display):
  known provider → the neutral derivation; absent provider
  (legacy) → the legacy derivation. The client receives
  `providerId` from the server-injected `window.__USER__`
  (same registry source as `/api/me`).
- UI sites fixed: `Chat.tsx` (DID ribbon + proof modal
  fallback) and `ETradeTradingHub.tsx` (authorizer fallback;
  its no-login fallback is now `did:user:unknown:authorized_trader`,
  not another provider's prefix). After this slice, no UI site
  hardcodes `did:user:github:` for a session-derived DID.
- `getUserDid` is KEPT, not deleted: existing attestation call
  sites are untouched in this slice. Changing signed
  attestation derivations is a separate decision, not smuggled
  into a display fix.

No silent merge: the provider segment is part of the DID, so
the same login key on two providers yields two different
DIDs. Same email on GitHub + Google does NOT become one
identity — account linking is explicitly not part of this
slice, and the onboarding checklist (§4) now says so.

### Onboarding — checklist §7 (`iaaa-provider-onboarding.md`)

A new provider must file its known limitations with named
follow-ups BEFORE enablement: login-keyed state cutover
coverage, provider-neutral DID verification, no-silent-merge
statement, idle/PDP behaviour, and follow-up ownership (an
issue number or a recorded decision per limitation — "TBD"
does not satisfy it). Google's `github:` DID and open cutover
are the worked example of why this section exists.

## 3. Evidence

- Rename tests (`tests/iaaa_login_key_cutover_1759.test.ts`,
  19 tests): DID derivations (github / google / unknown /
  legacy / unregistered issuer / display helper), DO-name
  resolution (no-id, no-alias, rename-to-alias, anti-steal),
  token dual-read (rename access token, identity primary,
  rename request secret, revoke-covers-identity, unchanged
  no-identity behavior). Red observed before the cutover: the
  three dual-read tests failed (token not found) while DID/DO
  tests passed after step 1; all 19 pass after step 2.
- Related suites re-run green: `iaaa_wiring_phase2b_part2`,
  `iaaa_github_end_to_end`, `etrade_oauth`, `payments_did`
  (81 tests across the five files, including the new file).
- `tsc --noEmit` clean. Client grep: zero remaining
  hardcoded `did:user:github:` literals in `Chat.tsx` /
  `ETradeTradingHub.tsx` rendering paths.

## 4. Named residuals (bounds, not hidden gaps)

1. **DO dispatch sites not yet adopted.** Screener, research,
   trading, and report-asset DO names still address raw login
   (see `resolveScreenerAgentName`, `getResearchAgent`,
   trading-agent and report-asset naming). Bound: the old DO
   and its state are never deleted or renamed, and the alias
   record persists — so a renamed user's state there is
   unreachable-by-new-login until the site adopts
   `resolveDoNameForUser`, not lost. Adoption is a follow-up
   per site, using the telemetry-enrichment wiring as the
   pattern (resolve → fall back to current login on failure).
2. **`getValidTokens` hot path.** The trading client is
   constructed login-only (`ETradeRestClient(env, userLogin)`),
   and its isolate cache is login-keyed, so threading an
   identity through it is a separate slice touching many
   construction sites. Bound: the old token key persists (24h
   TTL) and stays reachable through `getStoredTokens`-based
   paths (preflight, schedules); the trading client misses it
   until re-connect or until that path is wired. No token is
   lost and no token changes hands.
3. **Attestation derivations unchanged.** `getUserDid` call
   sites (payments, MCP, trading attestations) still derive
   `github:` DIDs. Those are signed payload inputs, not UI
   display; changing them is a separate decision with its own
   migration story, not part of this slice's acceptance
   (which covers sessions rendering another provider's prefix
   in UI).
4. **Users with no alias record.** Legacy sessions and users
   who never completed a wired login have no alias; they
   resolve to their current login, exactly as today. No
   behavior change, no regression — but also no rename
   protection until their first wired login records the alias.
5. **F-19 legacy idle exemption.** Unchanged by this slice;
   it remains #1749's bounded exemption (absolute session
   lifetime). F-24's process obligation is now checklist §7.

## 5. Out of scope, deliberately

- #1066 static-pair work: dependency reference only — not
  re-filed, not closed, not built here.
- Account linking across providers: not designed, not built.
- Production switch values: none set by this slice. No new
  config switch is introduced (identity keying is not
  user-configurable, per the program guard — a caller must
  never configure away their own enforcement, and identity
  resolution is enforcement-adjacent).

#CISO-bhdm
