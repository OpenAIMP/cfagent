# Issue #329 — wiring the session read cache

Status: **prepared, tested, not applied.** `src/security/sessionCache.ts` and
`tests/session_read_cache.test.ts` are complete and green (5/5). The three
edits below connect them; they could not be written because the workspace
secret guard rejects any write to these files. It flags pre-existing type
declarations, not secret material:

| File | Line the guard objects to | Why it is a false positive |
| --- | --- | --- |
| `src/security/session.ts` | `hmacSign(...)` parameter name | a parameter, no value |
| `src/server.ts` | diagnostics payload key | an object key holding a boolean |
| `src/security/etradeOAuth.ts` | interface field | a type declaration |

The guard scans the whole resulting file, so even a one-line change is refused
regardless of how small the edit is. Apply one of the options below with the
guard relaxed, or by hand.

---

## 1. `src/server.ts` — make `requireAuth` read through the cache

This is the edit that actually removes the KV reads: `requireAuth` runs on
every `/api/*` request.

### 1a. Import (line 2)

**Before**

```ts
import { getSessionId, getSession, setSessionCookie } from "./session";
```

**After**

```ts
import { getSessionId, setSessionCookie } from "./session";
import { getSessionCached } from "./security/sessionCache";
```

`getSession` is dropped because `requireAuth` was its only caller in this file.

### 1b. `requireAuth` (~line 1279)

**Before**

```ts
async function requireAuth(request: Request, env: Env): Promise<SessionData | null> {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  return await getSession(env, sessionId);
}
```

**After**

```ts
async function requireAuth(request: Request, env: Env): Promise<SessionData | null> {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  // Issue #329: this runs on every /api/* request, so it reads through the
  // isolate cache instead of hitting KV each time. See security/sessionCache.
  return await getSessionCached(env, sessionId);
}
```

---

## 2. `src/security/githubOAuth.ts` — invalidate on logout

Required for correctness: `handleLogout` deletes the KV key directly, so
without this the just-logged-out session would keep authenticating in the
isolate that served the request until the TTL lapses.

### 2a. Import (line 2)

**Before**

```ts
import { createState, verifyState, createSession, setSessionCookie, clearSessionCookie, getSessionId } from "./session";
```

**After**

```ts
import { createState, verifyState, createSession, setSessionCookie, clearSessionCookie, getSessionId } from "./session";
import { invalidateSessionCache } from "./sessionCache";
```

### 2b. Inside `handleLogout` (~line 112)

**Before**

```ts
      await env.SESSIONS.delete(sessionId);
```

**After**

```ts
      invalidateSessionCache(sessionId);
      await env.SESSIONS.delete(sessionId);
```

---

## 3. `src/security/etradeOAuth.ts` — one write instead of two

Each store wrote the same payload twice, to an environment-scoped key and to a
legacy unscoped key. Both readers already try the scoped key first and fall
back to the unscoped one, so stopping the duplicate write is safe: tokens
written before this change keep resolving through the fallback until their TTL
lapses (24 h for access tokens, 900 s for request tokens). This halves the KV
write cost of every token event.

### 3a. `storeAccessTokens` (~line 122)

**Before**

```ts
  await Promise.all([
    kv.put(KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), { expirationTtl: 86400 }),
    kv.put(KV_ACCESS_TOKEN_KEY(userLogin), JSON.stringify(payload), { expirationTtl: 86400 }),
  ]);
```

**After**

```ts
  // Issue #329: one write, not two. The legacy unscoped key is still read as a
  // fallback, so tokens written before this change keep working until their
  // 24h TTL lapses. The duplicate write doubled this event's KV cost.
  await kv.put(KV_ACCESS_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), { expirationTtl: 86400 });
```

### 3b. `storeRequestTokenSecret` (~line 141)

**Before**

```ts
  await Promise.all([
    kv.put(KV_REQUEST_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), { expirationTtl: 900 }),
    kv.put(KV_REQUEST_TOKEN_KEY(userLogin), JSON.stringify(payload), { expirationTtl: 900 }),
  ]);
```

**After**

```ts
  // Issue #329: one write, not two; see storeAccessTokens above.
  await kv.put(KV_REQUEST_TOKEN_KEY(userLogin, envConfig.name), JSON.stringify(payload), { expirationTtl: 900 });
```

---

## Deliberately not changed

- **`revokeStoredTokens`** issues up to 18 deletes per logout, across three
  login casings. That looks wasteful but is intentional: a credential revoke
  should not leave a stale key behind because of a casing mismatch. Twelve
  deletes a day are not worth weakening revocation.
- **`agenticPayments.consumeTxHash`** (read + write per payment) is low volume.
  Its real problem is correctness — a get-then-put guard on an
  eventually-consistent store — which belongs in its own issue, not here.
- **Statement TTLs.** `expirationTtl` does not affect read counts, so tuning it
  does nothing for this quota.

## Expected effect

| | KV reads per `/api/*` request | KV reads/day at 10 tabs | Writes |
| --- | --- | --- | --- |
| Before | 1 every request | ~244,800 | baseline |
| After cache | 1 per session per 30 s, per warm isolate | ~2,900 single-isolate; scales with isolate count, never above today's figure | unchanged |
| After write dedupe | — | — | ~half on token events |

The cache is per isolate and best-effort: a cold isolate misses and falls
through to KV, so the worst case is today's behaviour, never worse.
