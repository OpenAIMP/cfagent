# Issue #329 - session cache wiring (applied)

**Status: applied and superseded.** Kept as a pointer, not as instructions.

The wiring described here landed in #414:

- `src/session.ts` re-exports `getSessionCached as getSession`, so `requireAuth`
  reads through the cache.
- `src/security/githubOAuth.ts` calls `invalidateSessionCache` before deleting
  the session, closing the logout gap this document described.
- #416 then moved the backing store to the `SessionStore` Durable Object, so
  `getSessionCached` is now a latency layer in front of the DO rather than a KV
  read reducer.

Current architecture lives in `src/security/session.ts`,
`src/security/sessionCache.ts` and `src/security/durableKv.ts`; budget rules are
in `docs/OBSERVABILITY.md` §3.
