# 0001. Derived stable identity from (issuer, subject)

- Status: accepted
- Date: 2026-10-23
- Deciders: owner, CEO-aimp
- Issue: #1182
- Implementing PR: #1189 (main `5972a65`)

## Context

The wired session `internalUserId` was a random UUID minted at first
binding and stored under `iaaa-binding:<issuer>\0<subject>` in SessionStore.
That design is fragile to store loss and store isolation (production vs
preview/localhost stores are separate), and it produced the E*TRADE PDP
failures: the session id did not match any bootstrap entry, so
`integration:connect` denied. GitHub's subject is the numeric user id,
never the login handle, which added to the confusion.

## Decision

Derive the internal id from the one pair every IdP supplies:

```
internalUserId = "v1:" + hex(SHA-256(normalize(issuer) + "\0" + normalize(subject)))
```

Normalization is trim-only: no case folding, no URL canonicalization.
New bindings are created with the derived id. Migration runs inside
binding resolution, before post-login bootstrap, on every wired login:
memberships move to the derived id (equivalents created unless one
exists; genuinely-revoked memberships mirror as revoked with their
original `revokedAtMs`; old still-active memberships are revoked, never
deleted), the old→new alias is recorded, then the binding is rewritten
to the derived id. The single choke point is the shared
`completeWiredLogin` tail, used by the GitHub wired callback and the
generic OIDC tail alike — zero per-provider branches, zero mapping
table, no email or login anywhere in derivation.

Golden vector: `("https://github.com", "42")` →
`v1:0962030c695d4b7f3a855132a8d14e814ede67f43f538a4e67bf68a59f99b72a`.

## Consequences

- Identity is stable across stores and provider-neutral: adding or
  removing an IdP needs no identity-code change (registration and
  enablement still do).
- Downstream code consumes an opaque id; nothing else changes
  (sessions, PDP, authorization untouched).
- Email is never identity: it is a contact channel and a legacy login
  key via the alias layer only.
- Known wart (no live effect): after migration, the login-alias record
  keeps pointing at the retired id (conflict-preserved); no production
  code reads login aliases on a live path.
- E*TRADE tokens stay login-keyed, bridged by the alias layer; DID
  strings are not rewritten by this decision.
- Adopting Auth0 later is a migration, not a flip: Auth0's
  issuer/subject differ from raw GitHub/Google, so derived ids would
  change and need migrating again.

## Alternatives considered

- Durable-store minted UUIDs: rejected — the fragility being fixed.
- Raw `(issuer, subject)` as id: rejected — not opaque, leaks provider
  shape into every consumer.
- UUIDv5: rejected — SHA-1 is deprecated, and the shape is
  indistinguishable from minted ids.
- Subject-only: rejected — cross-IdP subject collision.
- Login handle: rejected — handles change and get recycled.
- Central mapping/registry + account linking: rejected as the answer
  here — right only for multi-IdP account merging, a separate feature.
