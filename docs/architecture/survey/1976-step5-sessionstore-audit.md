> **Filed into the repo 2026-10-30** (CDO lane handover, #1976) — this is the
> step-5 audit as written on its stated base (`75615a7c`, 2026-10-30).
> Line citations are to that base. Since the audit: step 5a (#2432,
> PR #2467) and step 5b (#2433, PR #2484) have landed; 5c #2434,
> 5d #2435, 5e #2436 and Sentinel #2279 pass to a successor lane —
> see the handover note on #1976. The audit's §9 slice drafts were
> filed as those issues with the parent rulings (Q-1–Q-6) recorded
> in each issue's preamble.

# #1976 step-5 audit — session + IAAA stores (ADR 0022 D-I step 5)

**Base:** main `75615a7c915876c4a7b9e87e183ef949363767d9`
(2026-10-30; `git ls-remote` verified; HEAD of this base is the
#2225 mesh S16 merge, PR #2426). **Method:** read-only worktree
`~/workspace/w1976/wt-step5-audit` at that SHA; every count below
is reproduced from a command run against that tree (commands in
§1.1 and inline); line numbers cite that tree. Format mirrors
step1/2/3/4-AUDIT.md. Steps 0–4 **are** all on this base: D1
migrations registered run **1–22** (0016 = `agent_audit_chain`,
0020 IV history, 0021 marketplace, 0022 the step-4f D1 tables);
the global census pin (`tests/global_dd_census_2356.test.ts`)
asserts surface-1 **13**, surface-2 **0**, surface-3 **1** — all
three totals reproduced independently at this base (§1.1).

**What step 5 is, per the ADR.** D-I step 5, verbatim
(ADR 0022 §D-I): "**Session/durableKv + IAAA store last** —
availability- and evidence-critical (#1819 history);
parallel-run / flag gating per the issue's failure/recovery
criterion." The D-0 matrix rows that govern it:

> SessionStore / durableKv — sessions, OAuth tokens, API keys,
> payment drafts (§1.5, §1.6) | (e) a session/token read must see
> the write that just happened; every consumer funnels through
> the one instance (§1.6). Explicitly **not** (f): buckets are
> logical — isolation inside the instance is by key discipline,
> not construction | **DO-justified**, on consistency and funnel
> grounds. The exception that proves the rule: the most
> availability-critical data in the system (§1.6, #1819
> history); migrates last (D-I step 5). (ADR 0022 §D-0, matrix)

> IAAA audit store — whole-log JSON array on durableKv (§1.6,
> §3.3) | (b) its correctness today leans entirely on the
> single-instance funnel's serialization (§3.3) | **Judgement
> call on residency; the mechanism is replaced regardless**
> (D-F.3). Deciding factor: where D-F.3's single-writer append
> port is hosted — the port's contract can be honoured on
> either substrate; G-5 rules the wiring ownership.
> (ADR 0022 §D-0, matrix)

**Headline corrections to the record (evidence in §2–§4, §7):**

1. **Step 5's two halves are one Durable Object.** The IAAA
   audit log is not a separate store that shares a bucket: the
   chained append (tail read, hash linking, rotation, cap) is
   an **op inside `SessionStore.fetch`** (`audit-append`,
   `src/security/sessionStore.ts:268–397`), restricted to the
   sessions bucket's audit key. Any slice split that sequences
   "SessionStore" and "the IAAA store" as independent
   migrations is wrong about the tree; the audit-append op's
   home is a decision step 5 must make explicitly (Q-1).
2. **The census understates step 5's population by an order of
   magnitude.** The pin's step-5 entry is one line —
   `sessionStore.ts`, 2 sites. The measured population is the
   DO class (426 lines, one table, 7 statement templates), the
   client funnel `durableKv.ts` (362 lines, zero SQL, invisible
   to every census surface), two isolate caches on the auth hot
   path, and **~20 composition call sites across 7 buckets**.
   A step-5 pin that only retires the census entry can
   "complete" with the funnel unported — step-4 R-4 repeating
   itself (§1.2, R-2).
3. **The mas_events chain wiring the task record treats as
   outstanding exists on this base** — built by the security
   lane as #2178 (Q7 S1: `src/security/auditChain.ts`, chained
   writer in `src/data/ormRepositoryCore.ts`, verify entry
   point `verifyStoredAuditChain` in `src/data/ormFacade.ts`),
   and a **second, D1-resident chained-evidence port** exists
   beside it (#2183: `agent_audit_chain`, migration 0016,
   `src/data/auditPolicyPorts.ts`, seeded audit-only). G-5 is
   still listed **open** in the ADR's gates table; the tree has
   answered it in practice. Step 5 must not re-wire, re-shape,
   or re-own either chain (§4.3, R-4).
4. **D-F.3's replacement of the IAAA whole-log store has NOT
   landed.** The production IAAA log is still whole-log JSON —
   hardened by #1760 (atomic append inside the DO, rotation
   into archive-segment JSON arrays, enforced cap) but not an
   append-only table behind a port. What D-F.3 describes
   remains unbuilt for this store; whether step 5 builds it or
   ports the existing mechanism is Q-1, and the two must not be
   conflated in a slice's acceptance criteria.

---

## 1. Census today — the step-5 population

### 1.1 Commands (all run in `src/` at the base)

```sh
# the global pin's three patterns, recounted independently
# (pin: tests/global_dd_census_2356.test.ts:94–96)
#   storage-shaped: /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/
#   any-exec:       /\(\s*[\w.[\]]+\s+as\s+any\s*\)\s*\.\s*exec\s*\(/
#   prepare:        /\.prepare\s*\(/
grep -rn "kv_store" src/                 # the step-5 table
grep -rn "createStoreKv(\|createStoreSender(\|listStoreEntries(\|consumeStoreKey(" src/
grep -rn "SESSION_STORE" src/ wrangler.jsonc
```

Recount at this base reproduces the pin exactly: **surface-1 =
13** (`orchestrator.ts` 3 permanent ADR-out lift, `learnings.ts`
7 R-1-gated, `sessionStore.ts` **2 step 5**, `cfAgentsAdapter.ts`
1 SDK shim), **surface-2 = 0**, **surface-3 = 1**
(`transactionAspect.ts`, in-role). The pin's step-5 line is
`tests/global_dd_census_2356.test.ts:111`:

```ts
["src/security/sessionStore.ts", 2, "step 5 (SessionStore / kv_store)"],
```

`kv_store` is named in exactly **one** src file —
`src/security/sessionStore.ts` (grep-complete). `mas_events` is
already a ported table (step 3a): its pinned writer set is
`ormSchema.ts` + `masRetentionIndexSchema.ts` (index only),
census :527–529 — the chain writer lives inside the layer
(§4.2).

### 1.2 What the census cannot see (the real population)

None of step 5's client surface matches any census pattern —
it is HTTP-protocol calls to a DO stub, not SQL:

| Population member | Where | SQL sites | Visible to census? |
|---|---|---|---|
| `SessionStore` DO class | `src/security/sessionStore.ts` (426 lines) | **2** (constructor DDL :138; the single `execCounted` funnel :153) | Yes — the pin's 2 |
| Client funnel | `src/security/durableKv.ts` (362 lines): `createStoreKv` :246, `createStoreSender` :120, `listStoreEntries` :319, `consumeStoreKey` :344 | 0 | **No** |
| IAAA audit client | `src/security/iaaaAuditStore.ts` (264 lines) over the funnel's sender | 0 | **No** |
| IAAA pure model | `src/security/iaaaAudit.ts` (525 lines): `AuditStore` interface :123, `recordAuditEvent` :333, `verifyChain` :209 | 0 | **No** |
| Isolate session cache | `src/security/sessionCache.ts` (108 lines) in front of every `requireAuth` read | 0 | **No** |
| Isolate token cache | `src/security/etradeTokenCache.ts`, epoch-guarded, invalidated by every token write path | 0 | **No** |
| ~20 bucket composition sites | §2.3 table | 0 | **No** |

**Consequence for the slice plan:** step 5's first slice must
extend the census with a step-5 section in the step-4 style —
an exact enumeration of the funnel's composition sites
(`createStoreKv` / `createStoreSender` / `listStoreEntries` /
`consumeStoreKey` call sites, by file) plus a by-table writer
entry pinning `kv_store`'s writer set to
`{src/security/sessionStore.ts}` — or the step's end-state is
unverifiable (the step-4 R-4 lesson, applied prospectively).

---

## 2. SessionStore — measured state

### 2.1 The DO class

`src/security/sessionStore.ts`: `export class SessionStore
extends DurableObject<Env>` (:134), exported as a worker DO
class from `src/server.ts:282`, bound as `SESSION_STORE`
(`wrangler.jsonc:68`, `class_name: "SessionStore"`). It is a
**plain `DurableObject` subclass — not a PortThink agent**
(the user decision on record; nothing in step 5 changes the
class's runtime identity, only its access shape).

- **One instance** (`idFromName("kv")`, client default in
  `durableKv.ts:247`) holds every bucket; buckets are the
  `ns` column, isolation is key discipline (D-0's "explicitly
  not (f)" made literal).
- **One table:** `kv_store (ns TEXT, key TEXT, value TEXT,
  expires_at INTEGER, PRIMARY KEY (ns, key))`, created in the
  constructor (:138–145). **No schema-version marker** — the
  class does not use `src/data/doSchemaMarker.ts`
  (`mas_do_schema_marker`, landed for the ORM DOs under
  D-A.4); SessionStore is the last DO whose schema evolution
  is an unversioned `CREATE TABLE IF NOT EXISTS` (Q-3).
- **Storage surface:** every statement runs through one
  private funnel, `execCounted` (:153–158), which fully
  consumes the cursor and returns the platform-measured
  `rowsRead`/`rowsWritten` (#1819 instrumentation — every op
  reply carries the counts plus the parameterized statement
  template; bound values never appear). Seven statement
  templates (:51–62): point get, expires get, list (prefix,
  unexpired only), upsert (`ON CONFLICT(ns,key) DO UPDATE`),
  delete, archive list, archive insert.
- **Wire surface:** one `fetch` handler dispatching on
  `op` — `get`, `put`, `delete`, `consume`, `list`,
  `audit-append` — over a tiny JSON protocol
  (`https://session-store.internal/kv` on the client,
  `durableKv.ts:59`; 2 s timeout, :60; the client never
  throws). The DO performs **no authorization** — it is
  reachable only via the Worker's internal stub; every list
  caller is route-gated (the class header's own warning,
  :186–197).

### 2.2 The client funnel (`durableKv.ts`)

`createStoreKv(options): KvLike` (:246) is the de-facto port
contract every consumer already codes against — `KvLike`
(`src/security/kvResilience.ts:21–33`: `get` / `put` /
`delete` / `putIfAbsent`, the last documented as an atomic
claim). Semantics a port must preserve deliberately (§3):

- **Never throws.** A DO failure degrades per-op (below); a
  missing namespace degrades to `null` replies and an
  "unavailable" metrics outcome.
- **Legacy KV fallback, per bucket:** `legacyFallback: false`
  means KV is not part of the store at all — no migration
  read, no write fallback, no delete. Every production
  bucket measured at §2.3 passes `legacyFallback: false`
  (the #604 migration window closed; session.ts's header:
  "Auth material stays in the DO (never moves back to KV)").
  Where a legacy KV *is* configured, `get` is a
  read-with-write: miss → legacy read → **copy-through put**
  into the DO (awaited, :275–281).
- **`putIfAbsent` rides the DO `consume` op and has NO legacy
  fallback by design** (:296–313): when the DO is unreachable
  it returns `false` — "not claimed" — so callers fail closed.
- **Metrics are part of the contract:** one `store_op` v2
  record per op on every exit path (`recordStoreOp`, #910 /
  #1819), plus optional forwarding to the #1743 resource sink.
  `storeFull` on audit-append classifies as **failed**, not ok
  (:107–110) — cap exhaustion must stay visible in the T2
  failure rate.

### 2.3 Buckets and key families (the full measured set)

The funnel doc comment (durableKv.ts:36) names three buckets;
the tree has **seven** (R-3). All live in the one instance;
`ns` values and key families:

| Bucket (`ns`) | Key families | Owning module(s) |
|---|---|---|
| `sessions` | session records — bare UUID keys, value = session JSON, TTL = `SESSION_TTL` | `security/session.ts` (`sessionStore(env)` :107–118, `legacyFallback: false`) |
| `sessions` | `iaaa-binding:` — identity bindings, NO expiry, two keys per binding (both lookup directions) | `security/iaaaLogin.ts` (:355, :394), `security/identityBinding.ts` (prefix :129) |
| `sessions` | `iaaa-audit:` — the audit log: live key `iaaa-audit:events` + archive segments `iaaa-audit:archive:NNNNNN`, NO expiry | `security/iaaaAuditStore.ts` (prefixes :84–92); appended by the DO itself (§4.1) |
| `sessions` | `iaaa-membership:` — membership records | `security/iaaaMembershipStore.ts` (prefix :75), composed in `iaaaLogin.ts:628` and `server.ts` (6 sites) |
| `sessions` | `iaaa-access-request:` — access-request records | `security/iaaaAccessRequests.ts` (prefix :69) |
| `etrade` | `etrade:token:<ENV>:<login>` and unscoped `etrade:token:<login>`; `etrade:req_token:…` likewise (ENV ∈ TEST/PROD; login may be the internal id, the wired login, or an alias login — candidate-key set, #2386) | `security/etradeOAuth.ts` (`getKv` :253–260) |
| `public` | `public:token:<login>` (PAT records, verify-before-store); plus arbitrary `sessionstore:<ns>:<key>` credential references resolved through a per-call bucket | `security/publicOAuth.ts` (:120 key fn, :124 store, :298–315 ref resolver) |
| `api_keys` | API-key records — SHA-256 hash of the secret only, `cfk_…` pattern | `security/apiKeys.ts` (:49–57) |
| `payments` | `x402tx:<txhash>` — x402 replay claims (consume + delete-on-release); `draftowner:<draftId>` — payment-draft owner registry | `services/agenticPayments.ts` (:372, :390–395); `payments/draftOwners.ts` (ns :47, prefix :50) |
| `slack_principal_links` | Slack↔principal link claims (consume-based) | `trading/channels/intake.ts` (ns :174) |
| `sessions` (direct) | lifecycle/admin compositions: `server.ts:1521, 2444, 2516` (`"sessions"`), `:2478` (`"etrade"` — the token-list/revocation path) | `src/server.ts` |

Plus the audit store itself: `createWiredAuditStore(env)`
(`iaaaAuditStore.ts:260–264`) is composed at **10 sites in
`server.ts`** (:597, :611, :1509, :1555, :1637, :1722, :1778,
:1920, :2098, :2153) and used for direct `recordAuditEvent`
calls at :2407, :2424.

Note what shares the `sessions` bucket: live login sessions,
identity bindings, membership, access requests, **and the
audit evidence log** — five key families, one bucket. The
registry parser's header says it plainly: "Membership,
binding, audit, and access-request keys share the sessions
namespace but are not sessions" (`iaaaSessionRegistry.ts:15–17`)
— listings must filter by key shape (UUID-only) to see
sessions at all.

### 2.4 Consumers by flow

- **Auth/session routes:** `session.ts` — `createSession`
  (:120–125, put with TTL), `getSession` (:127–138,
  parse-or-null), `updateSessionWithStore` (write at
  remaining-absolute-TTL; refuses past-expiry and invalid
  `createdAt` — absolute expiry is NEVER extended),
  `renewSessionWithStore` (:270), delete (:215).
  `sessionCache.ts` sits in front of `getSession` for
  `requireAuth` on every `/api/*` request: per-isolate,
  positive TTL from `SESSION_LIMITS` (#1750: the positive TTL
  is also the cross-isolate revocation propagation bound,
  pinned against `revocationTargets.ts`), negative caching,
  explicit `invalidateSessionCache` discipline.
- **E*TRADE:** the whole token lifecycle in `etradeOAuth.ts`
  (§3.2) — OAuth connect (request-token secret :354, access
  tokens :309), status/renew/revoke/broker-flag reads through
  the one resolution seam `readResolvedTokenSet` (:182), the
  hot data-plane read `getValidTokens` (:847) behind the
  epoch-guarded isolate cache (`etradeTokenCache.ts`), bulk
  renewal `renewAllStoredETradeTokens` (:796) riding the DO
  `list` op, bulk revocation via `listStoreEntries`
  (:797–808).
- **Public.com:** PAT verify-before-store + credential-ref
  reads (`publicOAuth.ts`).
- **IAAA lifecycle:** bindings, membership, access requests,
  session registry + bulk revocation (`iaaaSessionRegistry.ts`
  over `listStoreEntries` on `sessions`; lifecycle routes are
  admin/self-gated — `iaaaLifecycleWiring.ts`, `lifecycle.ts`).
- **Payments:** x402 replay guard (`consumeStoreKey`,
  agenticPayments) and draft-owner resolution (draftOwners).
- **Audit:** every `recordAuditEvent` call site via
  `createWiredAuditStore` (§4).

---

## 3. Side-effectful behaviours — the deliberate-preservation catalogue

A port contract for these stores that only models
get/put/delete will silently change production behaviour.
Each behaviour below is **load-bearing today**; step 5's
characterization (§9) pins each one *before* any composition
moves, and each port operation names it rather than
rediscovering it.

1. **Expired-row read deletes (DO `get` op).**
   `sessionStore.ts:204–235`: a `get` whose row is past
   `expires_at` executes `STMT_DELETE` and returns null —
   lazy expiry is a write on the read path (and is counted in
   the reply's rowsWritten).
2. **Expired-token read revokes (E*TRADE).**
   `etradeOAuth.ts:902–907` (`getValidTokens`): when the
   resolved token set is past midnight ET
   (`isTokenExpiredEt`, :292–300), the read **calls
   `revokeStoredTokens`** — deleting every access/request
   token key across both environments, scoped + unscoped,
   across case variants and identity/alias logins
   (:428–457) — invalidates the isolate token cache, and
   returns null. "Post-midnight missing" is the designed
   end-state of a token, produced by this read. A port that
   models token read as pure breaks renewal, status, and the
   broker-flag path simultaneously — they all resolve through
   the same seam (`readResolvedTokenSet`, :182–207), whose
   candidate-key order (internal-id → alias → login, scoped →
   unscoped, corrupt candidates skipped) is itself contract.
3. **Renewal is window-bound.** `renewETradeAccessToken`
   (:696–): an expired token yields `TOKEN_EXPIRED` — renewal
   is only possible before midnight ET; `renewAllStoredETradeTokens`
   (:796–820) lists the `etrade:token:` prefix through the
   DO's restricted `list` op and skips expired entries. The
   list op's restriction (sessions ns, or etrade ns with the
   `etrade:token:` prefix only, `sessionStore.ts:173–202`) is
   a security property, not an implementation detail.
4. **`consume` is a claim, not a read.** `sessionStore.ts:237–267`:
   SELECT-then-UPSERT inside one DO request; correctness
   leans on the DO processing one request at a time (D-0
   property (b)). Consumers: x402 replay guard
   (`consumeStoreKey` — `"unavailable"` is a distinct outcome
   the caller must not treat as "fresh"), `KvLike.putIfAbsent`
   (genesis claim, fail-closed), Slack link claims.
5. **Audit append is a read-modify-write of the whole log.**
   `sessionStore.ts:268–397` (§4.1): tail read → chain → cap
   check → rotation inserts → live-key upsert, atomically
   inside one DO request. Corrupt live or archive bytes fail
   the append loud (500, "audit log corrupt") and are **never
   overwritten** (:317, :338).
6. **Session update preserves an absolute deadline.**
   `updateSessionWithStore` writes TTL = remaining absolute
   time and refuses at/past expiry; `getValidatedSession`
   re-checks absolute expiry on every read (a store TTL clamp
   cannot resurrect a session). The caller must invalidate
   the isolate session cache in the same isolate — the module
   cannot (circular import), so the obligation is contractual.
7. **Copy-through migration read** (funnel, where a legacy KV
   is configured): miss → legacy get → awaited DO put
   (`durableKv.ts:266–282`). Dormant for every production
   bucket today (all `legacyFallback: false`) but live in the
   `KvLike` contract and in tests; a port must either carry
   it as a declared adapter behaviour or retire it explicitly
   — not lose it by omission.
8. **Fail-visible audit outcomes.** `recordAuditEvent`
   returns `AUDIT_WRITE_FAILED` / `AUDIT_STORE_FULL` as data
   (never throws into the caller); the Q7 policy in the pure
   model (`classifyAuditFailure`, `iaaaAudit.ts` ~:440–470):
   consequential actions BLOCK on audit failure,
   non-consequential proceed with warning; `isAuditedSuccess`
   — authorization passing is not audit evidence. The
   sensitivity classification is the caller's label, never
   inferred from the action string.

---

## 4. IAAA — measured state

### 4.1 Three modules, one log

- **Pure model** — `src/security/iaaaAudit.ts` (525 lines,
  #945 Slice 5): the `IaaaAuditEvent` shape (full attribution:
  actor + initiating principal, tenant, correlation, decision,
  policy version, outcome — D-F.3's two-part attribution,
  present here), validation with catalog codes
  (`AuditErrorCode`, :229–243), the SHA-256 hash chain over a
  canonical key-ordered serialization (`computeEventHash`,
  `canonicalizeEvent`), `verifyChain` (:209–220 — recomputes
  every hash, checks every link; empty chain verifies), the
  failure policy (§3.8), and audit-access events (reading the
  log is itself an audited event). Header is explicit that the
  module alone is "a testable policy/evidence model", not
  enforcement.
- **Client store** — `src/security/iaaaAuditStore.ts`:
  `AuditStore` has two production-relevant backends.
  `createAtomicAuditStore` (:153) is the production wiring:
  `appendAtomic` speaks the DO's `audit-append` op via
  `createStoreSender`; its plain `append()` **throws by
  design** (a caller-chained event stored verbatim would
  bypass the atomic chaining). `createKvAuditStore` (:129)
  is the legacy read-modify-write backend — **no production
  import exists on this base** (grep-complete outside its own
  file); it survives for tests and pre-#1760 log reads, and
  its F-18 race is documented in its own header.
  `createMemoryAuditStore` (`iaaaAudit.ts:136`) is the
  in-memory leg.
- **The append itself** — inside `SessionStore.fetch`
  (`sessionStore.ts:268–397`), restricted to
  `ns === "sessions" && key === IAAA_AUDIT_LOG_KEY` (:271).
  The DO re-validates the input (defense-in-depth re-check,
  :88–133), clamps the caller's caps to hard ceilings
  (live 2000 / segment 2000 / segments 10 — a caller may
  request smaller, never larger, :67–74, :295–298), reads the
  live log + all archive segments, refuses at the total cap
  (22,000 events) with `storeFull: true` — **the cap is met
  by refusing appends, never by deleting evidence** (:343–355)
  — chains onto the true tail (live tail, else last archive
  segment's tail, else genesis), rotates the oldest
  `segmentSize` events into the next archive key when the
  live key exceeds `liveMax`, and upserts the live key.
  Rotation preserves chain order; `list()` (archives in key
  order, then live) still verifies end-to-end.

### 4.2 mas_events — the relation, and what already landed

`mas_events` is a **different store** (per-orchestrator-instance
DO SQLite, step-3a ported) that `storageRetention.ts` governs:
PRUNE at 365 days (`MAS_EVENTS_RETENTION_DAYS`, default 365,
#786; `storageRetention.ts:35–38, :206–207`) — the retention
the Q7 record ratified. Its relation to the IAAA log is
mechanism, not data: the two chains are independent.

On this base, mas_events **is chained**, by the security
lane's #2178 (Q7 S1), not by any #1976 step:

- `src/security/auditChain.ts` (163 lines): the iaaaAudit
  scheme mirrored for the mas_events row shape — vendored
  **sync** SHA-256 (the live writer is sync; every other
  sha256Hex in the repo is async WebCrypto), `linkAuditRow`,
  `verifyAuditChain` with genesis-boundary semantics
  (pre-chain rows skipped; a missing hash *after* chaining
  started fails).
- Writer: `ChainedAuditRepository extends Repository`
  (`src/data/ormRepositoryCore.ts:217–250`) — every
  `events.create` reads the tail
  (`SELECT event_hash … ORDER BY rowid DESC LIMIT 1`), links,
  inserts, synchronously inside the instance. Comment records
  it was "Moved unchanged in #2345 (gate G-5: the chain's
  shape, hash inputs, and verification rules are frozen)".
- Schema: `mas_events.previous_event_hash` / `event_hash`
  added additively (`src/data/ormSchema.ts:92–93, :195–199`).
- **Verify entry point:** `verifyStoredAuditChain(orm)`
  (`src/data/ormFacade.ts:146–158`), re-exported from
  `src/orm/index.ts:20`. On this base its only callers are
  tests (`tests/audit_chain_store_2178.test.ts`,
  `tests/orm_step3a_characterization_2345.test.ts`) — **no
  production route or job invokes it**; verification is a
  library entry point awaiting a consumer (an integrity leg
  or an admin surface), which is a named gap for the parent,
  not a step-5 build item by itself.
- D-F.3 also specified mas_events "gains a principal column
  and correlation fields": **not landed** — no principal
  column exists on mas_events (`ormSchema.ts`, grep-verified);
  attribution on this table remains the `agent` column the
  chain canonicalizes.

### 4.3 The third chain — `agent_audit_chain` (D1)

#2183 (Q7 audit-policy mechanism, sub-issue of #2012, "proposal
slice for CISO+CDO review under #945, consumed by #1999")
built a separate chained-evidence family **in the data
layer**: `src/data/auditPolicyPorts.ts` (port + pure helpers,
`auditChainEntryHash` :308, `verifyAuditChain` :336),
`d1AuditPolicyAdapter.ts` + `inMemoryAuditPolicyAdapter.ts`,
table `agent_audit_chain` (migration 0016,
`migrationRunner.ts:661–685`). Its header is explicit about
its limits: enforcement mode is seeded **"audit-only"** (the
gate evaluator records would-have-blocked, never blocks);
blocking requires (a) CISO+CDO sign-off AND (b) an operator
setting `enforcement_mode = "enforcing"`; retention there
governs those D1 rows only and pruning is operator-invoked
(`pruneAuditChainForTenant`), with oldest-row deletion
undetectable by that chain by design. Money paths adopt
`src/services/auditGate.ts` only after sign-off — **not
adopted on this base**.

So the tree holds **three** hash chains with three owners:
the IAAA log (SessionStore, §4.1), mas_events (#2178, §4.2),
and `agent_audit_chain` (#2183, audit-only). G-5 — "does
wiring mas_events through the IAAA hash chain + a verify
entry point ride D-F's evidence slice, or stay a separate
security-lane slice the foundation merely hosts?" (ADR Open
gates) — is **still open in the ADR text**, while the tree
shows the separate-slice path is what happened. Step 5's
scope discipline follows from that: **the chains' shapes,
hash inputs, and verification rules are frozen surface**
(the #2345 precedent); step 5 ports store access, it does
not touch chain mechanisms, and it does not activate
#2183's enforcement.

### 4.4 Retention state (Q7)

- mas_events: 365 d, implemented (`storageRetention.ts`, #786).
- IAAA log: **no age-based retention exists or is authorized
  in code.** Both store files record the carry:
  `iaaaAuditStore.ts` header — "Retention itself is CARRIED
  to adoption question Q7 … until Q7 answers, nothing in this
  module deletes an audit event for age, and hitting the cap
  fails new appends visibly"; `sessionStore.ts:343–349`
  comment — destructive retention "needs the Q7 retention
  decision … which has not been made". The programme record
  (parent context) has a CDO sign-off on #945 (2026-10-29:
  blocking set, 365 d retention ratifying the #786 mechanism,
  the iaaaAudit chain as the tamper mechanism) with **CISO's
  half outstanding** — i.e. as far as the code's own record
  goes, the decision process is not closed, and step 5
  treats destructive audit retention as **out of scope**
  (Q-4).

---

## 5. The flag-gating precedent step 5 follows

Two landed shapes exist; they agree on the essentials
(default off, absence = off, flag read from env in code, NOT
added to `wrangler.jsonc`, rollback = unset + redeploy):

1. **#1169 S2 (the closer precedent — a serving-path switch
   behind a flag, fallback untouched).**
   `isKnowledgeServingEnabled(env)`
   (`src/services/knowledgeCorpus.ts:207–214`): plain string,
   `"1"/"true"/"on"` (trimmed, case-insensitive) = ON, absence
   = OFF; header records the var is deliberately NOT in
   wrangler.jsonc — "S2 ships default-off, and enablement is
   a config change only … Rollback is unsetting it".
   `KNOWLEDGE_SERVING_ENABLED` gates the knowledge serving
   path (`src/agents/routes/knowledgeCorpus.ts:92, :215`;
   `src/agents/aiSearchPaths.ts:29, :97`); non-serving
   surfaces (the Search hub) explicitly do NOT depend on it.
2. **Step 2's IV composition (the composition-switch shape).**
   `ivHistoryD1Enabled(env)` (`src/data/createOptionsDiscoveryPorts.ts:127–128`,
   at this base still `env.IV_HISTORY_D1_ENABLED === "true"`)
   + the env-aware builder (:139–150): flag-on ∧ binding
   present → D1 adapter; otherwise the DO adapter; both
   adapters conformance-proven against the same port suite
   before the flag could mean anything. (The cutover that
   inverts this predicate's default is a separate in-flight
   change, not part of this base — step 5 cites the *shape*,
   not the cutover's polarity.)

**Step 5's shape, from the two:** one flag (name in Q-2),
read at the composition factories (`sessionStore(env)`,
`etradeOAuth`'s `getKv`, `createWiredAuditStore`, and the
residual-bucket factories), default OFF; flag-off composition
is **today's funnel, byte-identical**; flag-on composition is
port adapters over the **same SessionStore DO and the same
`kv_store` table** — step 5 migrates the access shape, not
the data (D-0 ruled the store DO-justified; there is no
second backend to parallel-run against, so "parallel-run"
here means dual *client* composition against one backend,
which is exactly what makes the flag safe to flip per
family). Conformance runs both compositions against the §9
characterization before any flag-on is proposed.

---

## 6. Port shape — against the existing families

The `src/data/` precedents step 5 mirrors (all on this base):
per-aggregate ports + DO-SQLite adapter + in-memory adapter +
`create*Ports.ts` composition root — e.g. the settings family
(step 3a read port → step 4g full port:
`settingsReadPorts.ts`, `createSettingsPorts.ts`), the
research family (step 4e: `researchStorePorts.ts`,
`createResearchStorePorts.ts`), the screen-run lock (step 4e:
`screenRunLockPorts.ts` — the closest analogue: a
security-shaped, instance-local claim formalized as a port
without changing its mechanism). The D-H conformance trio
applies: DO adapter + in-memory adapter (+ the existing test
double `tests/fake-session-store.ts` as the protocol fake)
pass one suite unchanged.

Against that template, today's shape has two mismatches the
slices must resolve deliberately:

- **`KvLike` is a bucket-shaped facade, not per-aggregate
  ports.** D-A.1/D-A.5 (one port per aggregate, one owner per
  table) at the bucket level means: one owner per **key
  family**. A single `KvPort` with an `ns` string would
  re-create the facade anti-pattern inside the layer. The
  split in §8 follows the families of §2.3: sessions/identity
  (5b), OAuth tokens (5c), audit log (5d), residual buckets
  (5e) (Q-6).
- **The AuditStore interface already IS a port-shaped
  contract** (`iaaaAudit.ts:123–135`: append / list /
  appendAtomic?, append-only by construction — no update or
  delete exists to expose). Step 5's IAAA work is giving it
  the family treatment (DO adapter named as such, in-memory
  leg, composition root, census entry), not redesigning it.

---

## 7. Corrections to the prior record (R-items)

- **R-1 — "Step 5 = SessionStore + the IAAA audit store" as
  two independent items is wrong about the tree.** The step-4
  audit's boundary note (§6 of step4-AUDIT.md) lists
  "SessionStore / durableKv (sessionStore.ts, kv_store, 2
  literal sites) + the IAAA audit store (KV whole-log JSON)"
  as a pair of separable remainders. Measured: the audit
  append is an op **inside** SessionStore's fetch handler
  (§4.1), the audit client is a consumer of the same funnel,
  and the log physically lives in the sessions bucket. The
  pair is one migration with an internal decision (Q-1: the
  append op's post-port home), not two migrations.
- **R-2 — The census figure "2 sites" describes the DO class
  only; step 5's verifiable population is the funnel.**
  §1.2: ~20 composition sites, 7 buckets, 2 isolate caches,
  and 3 client modules carry no census-visible surface. Any
  step-5 slice whose acceptance reads "census entry retired"
  without the §1.2 enumeration retiring alongside it will
  overclaim (the step-4 audit's R-4 blind-spot pattern:
  bare-executor callbacks and the prepare() surface passed
  two censuses unseen; here the whole client would).
- **R-3 — The bucket inventory in both the ADR and the
  funnel's own doc is stale.** ADR D-0: "sessions, OAuth
  tokens, API keys, payment drafts". durableKv.ts:36:
  "sessions", "etrade", "payments". Measured (§2.3): seven
  buckets — `sessions`, `etrade`, `public`, `api_keys`,
  `payments`, `slack_principal_links`, plus arbitrary
  namespaces via `sessionstore:<ns>:<key>` credential refs —
  and the `sessions` bucket alone hosts five key families
  (sessions, bindings, audit, membership, access requests).
  The D-0 verdict is unaffected (the funnel argument is
  stronger with more consumers), but any port split scoped
  from the ADR's list would orphan the public/api_keys/slack
  families.
- **R-4 — G-5's status in the ADR contradicts the tree, and
  D-F.3 is half-landed in an unrecorded way.** The ADR's
  Open gates table lists G-5 open, blocking "D-F.3 chain
  wiring". Measured (§4.2–4.3): the wiring exists twice over
  (#2178 chained mas_events + verify entry point; #2183's D1
  `agent_audit_chain` port), the 3a slice already treated the
  chain's shape as frozen under G-5's authority, and
  enforcement activation is a separate, still-unmet pair of
  conditions (CISO+CDO sign-off + operator setting). What has
  NOT landed from D-F.3: the IAAA log's append-substrate
  replacement (§4.1 stands) and mas_events' principal/
  correlation columns (§4.2). The parent may want the ADR's
  gate table annotated; step 5 itself proceeds on the
  tree's facts: chains frozen, wiring not step 5's to redo.
- **R-5 — The step-2 IV flag is not yet a "cutover"
  precedent on this base.** At 75615a7c,
  `ivHistoryD1Enabled` is still opt-in (`=== "true"`) and the
  production IV sites still compose the sync root — the
  inversion is in flight in a separate change. Step 5's flag
  design therefore cites the #1169 shape (§5.1) as its
  precedent and the IV builder only for composition shape
  (§5.2). (Recorded so a future reader of this audit does
  not date the cutover from this file.)

---

## 8. Slice plan — step 5 decomposed

Principles (from steps 1–4 practice): characterization first;
file-disjoint where possible; risk order (the token family —
the hottest, most side-effectful read path — after the
session family proves the flag pattern; the audit store
after both, because its append op lives in the DO the first
slices touch); every slice flag-gated (§5), flag-off =
today's behaviour byte-identical; each slice retires its
entries from the step-5 census section slice 5a lands.
Issue drafts below follow the gitops §5 template; the
signature hashtag is the filing lane's (#CDO-mha7).

### 8.0 Order

**5a → 5b → 5c → 5d → 5e.** 5a is measurement/pins only (no
behaviour change, no flag). 5b proves the dual-composition
pattern on the session family. 5c takes the token family
(highest blast radius per line). 5d ports the audit store
(its DO op is by then behind a tested composition seam). 5e
sweeps the residual buckets and retires the funnel's
above-layer life. One PR at a time under the merge-first
discipline, as always.

---

### Slice 5a — Step-5 characterization base + census extension + SessionStore schema marker

**Problem.** Step 5's population is invisible to the global
census (§1.2, R-2), its load-bearing behaviours are
side-effectful reads and claims that no single suite pins
end-to-end (§3), and SessionStore is the last DO evolving
schema without the D-A.4 version marker. Migrating any
family before this lands would be migrating unmeasured.

**Outcome.** A characterization suite over the REAL flows
(session lifecycle, token lifecycle, audit append/verify,
consume claims) that passes against today's code and is
declared the step's conformance base; a step-5 section in
the global census enumerating the funnel's composition
sites and pinning `kv_store`'s writer set; a schema-version
marker recorded by SessionStore (additive, behaviour-free).

**Scope.** New/extended tests under `tests/` (building on
`durable_session_store.test.ts`, `audit_store_atomic_1760.test.ts`,
`etradeTokenResolution2386.test.ts`, `etrade_token_cache.test.ts`,
`session_read_cache.test.ts`, `iaaa_revocation*.test.ts`,
`tests/fake-session-store.ts`); the census pin
(`tests/global_dd_census_2356.test.ts`, new step-5 section);
`src/security/sessionStore.ts` (marker only, via
`src/data/doSchemaMarker.ts`'s mechanism or a recorded
equivalent); `src/security/durableKv.ts` (no change unless a
characterization gap requires an attribution seam).

**Requirements.**
- Characterization covers every §3 behaviour, numbered to
  match this audit's §3 items 1–8, over the real modules
  (not re-implementations).
- The census step-5 section enumerates every
  `createStoreKv`/`createStoreSender`/`listStoreEntries`/
  `consumeStoreKey` call site by file and bucket (the §2.3
  table, mechanically), shrink-only.
- The marker write is additive and idempotent; a
  pre-marker instance and a post-marker instance behave
  identically for every op.
- No flag is introduced in this slice; no composition moves.

**Acceptance criteria.**
- The §9 inventory for 5a is green on the base and on the
  slice, unchanged in expectation.
- Census: surface totals unchanged (13/0/1); the new step-5
  section passes and fails if a new funnel call site appears
  anywhere in `src/`.
- `kv_store` writer set pinned to
  `{src/security/sessionStore.ts}`.
- Marker recorded and readable; full suite green; tsc clean.

**Test plan.** The characterization suite itself is the
deliverable; red evidence = the suite run against a
deliberately mutated behaviour in a scratch worktree (one
mutation per §3 item, each shown red), per standing practice.

**Dependencies.** None within step 5. Consumes the step-0
marker mechanism (D-A.4).

**Rollout.** Tests + one additive marker write; no flag;
revert-safe.

**Risks.** Characterization that pins a *bug* as behaviour —
mitigated by citing each pinned behaviour to its issue
(#1756/#1758/#1760/#1819/#2386) in the test headers; a
behaviour with no issue citation is flagged in the PR, not
silently canonized.

**Traceability.** #1976 step 5 (ADR 0022 §D-I.5, §D-A.4);
audit: this file §1–§3, §9. #CDO-mha7

---

### Slice 5b — Session/identity family behind ports, flag-gated

**Problem.** Session records, identity bindings, membership,
and access requests — the live auth path — are accessed
through a bucket-shaped facade (`KvLike` over the funnel)
with no per-aggregate port, no in-layer owner, and no
conformance leg (D-A.1). Every auth consumer composes the
funnel directly at ~10 sites.

**Outcome.** A session-family port set in `src/data/`
(session records; identity bindings; membership;
access requests — one port per aggregate or one family port
with named sub-contracts, per Q-6's ruling) with a DO
adapter speaking the existing wire protocol to the same
SessionStore instance, an in-memory adapter, and a
composition root; the family factories (`sessionStore(env)`
and its consumers in `session.ts`, `iaaaLogin.ts`,
`iaaaMembershipStore.ts`, `iaaaAccessRequests.ts`,
`identityBinding.ts`, `server.ts` lifecycle sites) compose
through the ports **when the step-5 flag is on**, and
through today's funnel, untouched, when it is off.

**Scope.** New: `src/data/sessionPorts.ts` (name per family
precedent), DO + in-memory adapters, `createSessionPorts.ts`.
Changed: the family factories above (flag read at the
factory, per §5). Explicitly out: the SessionStore DO class
internals (5a's marker excepted), the token families (5c),
the audit op (5d), session cache semantics (the isolate
cache stays in front, its invalidation obligations
unchanged and pinned).

**Requirements.**
- Flag-off path byte-identical: same wire payloads, same
  metrics records, same fallback semantics (`legacyFallback:
  false` preserved as the adapters' declared configuration).
- Absolute-expiry semantics (§3.6) are port contract:
  update-at-remaining-TTL, refusal at/past expiry,
  read-side re-check.
- Listing for bulk revocation (registry over the `list` op)
  is a named port operation with its restriction (sessions
  bucket, UUID-shaped keys) stated in the contract.
- Conformance: the 5a characterization for this family
  passes against BOTH compositions.

**Acceptance criteria.**
- Flag off: full suite green with zero expectation changes.
- Flag on (tests): the family's 5a characterization passes
  against the port composition; the census step-5 section
  shows this family's sites composing ports.
- No consumer outside the factories imports the funnel for
  this family's buckets after the slice (census-enforced).

**Test plan.** 5a characterization (dual-run), port
conformance suite (DO adapter via `fake-session-store.ts`
protocol fake + in-memory adapter, same suite), sabotage
pins: flag ignored → red; update extending absolute expiry
→ red; listing leaking a non-UUID key as a session → red.

**Dependencies.** 5a. Q-2 (flag name/semantics) and Q-6
(port granularity) ruled before build.

**Rollout.** Flag-gated; flag-on is a separate config change
after merge, per the #1169 pattern; rollback = unset.

**Risks.** Auth path — the highest care in the step. The
dual-composition design confines it: one backend, one table,
two clients; the flag-off path is the control.

**Traceability.** #1976 step 5 (ADR 0022 §D-I.5, §D-A.1);
audit §2, §3.1/3.6, §9. #CDO-mha7

---

### Slice 5c — OAuth token families behind ports, flag-gated

**Problem.** The E*TRADE and Public token lifecycles — the
most side-effectful reads in the system (§3.2–3.3) — hang off
module-level functions in `etradeOAuth.ts` / `publicOAuth.ts`
that compose the funnel directly. The expired-read revocation,
the candidate-key resolution order, the renewal window, and
the cache-invalidation contract are conventions in comments,
not a port contract with a conformance suite.

**Outcome.** `EtradeTokenPort` + `PublicTokenPort` (names per
precedent) in `src/data/` with DO + in-memory adapters; the
existing exported functions of `etradeOAuth.ts` /
`publicOAuth.ts` become delegating façades over the ports
when the step-5 flag is on (signatures unchanged — the
#2386 discipline: "existing callers are untouched"), and
today's direct composition when it is off.

**Scope.** `src/security/etradeOAuth.ts`,
`src/security/publicOAuth.ts`, `src/security/etradeTokenCache.ts`
(the cache stays isolate-side; its invalidation contract
becomes a named port-adjacent obligation), new port family
files. Out: token *semantics* changes of any kind (key
shapes, candidate order, midnight-ET rule, revoke sets —
all pinned, none redesigned); the upstream E*TRADE OAuth
protocol code (request/access token flows stay in the
security modules, calling the port for storage).

**Requirements.**
- `getValidTokens`' full decision tree is port contract:
  cache rules (identity-aware reads bypass), epoch guard,
  resolution seam order, unscoped-environment guard,
  expired → revoke-all + null (§3.2).
- Revocation is an explicit domain operation (D-E.3): the
  full key set (both envs, scoped + unscoped, case variants,
  identity + alias logins) enumerated in the contract.
- Renewal reads (`renewETradeAccessToken`,
  `renewAllStoredETradeTokens` incl. the list-op path)
  resolve through the port; the TOKEN_EXPIRED window rule
  is pinned at its boundary (23:59:59 ET renews, 00:00:00
  does not).
- PAT verify-before-store (Public) — a token is stored only
  after upstream verification — is a named precondition in
  the port's store operation contract.

**Acceptance criteria.**
- The token characterization (5a §9 rows for 5c) passes
  against both compositions; `tests/etradeTokenResolution2386.test.ts`
  and `etrade_token_cache.test.ts` expectations unchanged.
- Census: this family's funnel sites retired from the
  step-5 section (flag-on composition), as enumerated.
- No change to any stored key or value shape (a
  pre-slice stored token reads identically post-slice, both
  flag states).

**Test plan.** Dual-composition characterization; boundary
pins on the midnight-ET window with a caller-supplied clock
(the modules' existing time seams); sabotage pins: expired
read that does not revoke → red; candidate-order swap →
red; cache write after invalidation epoch → red.

**Dependencies.** 5b (the flag pattern proven). Q-2 ruled.

**Rollout.** Flag-gated, same flag as 5b unless Q-2 rules
per-family flags; flag-on separately proposed after merge
with the outside-in test steps (connect/status/renew/
revoke in the signed-in app) named on the PR.

**Risks.** A stale-token or missed-revocation regression is
a live-brokerage auth incident; the slice's defence is that
every behaviour it touches is §3-pinned before it moves,
and the flag-off path remains the production default until
the parent flips it.

**Traceability.** #1976 step 5 (ADR 0022 §D-I.5, §D-E.3);
audit §2.3, §3.2–3.3, §9. #CDO-mha7

---

### Slice 5d — IAAA audit store behind the AuditLog port, flag-gated

**Problem.** The production audit backend's contract
(`AuditStore`) lives in `src/security/` with its DO adapter
(the `audit-append` op) embedded in the SessionStore class
and its client embedded in `iaaaAuditStore.ts`; it has no
in-layer family treatment, no composition root, and its
legacy backend's status (test-only) is a header comment
rather than a §22 deprecation.

**Outcome.** The audit family lands in `src/data/` shape:
the `AuditStore` contract carried as the family's port
(unchanged semantics — append / list / appendAtomic,
append-only), a DO adapter whose append remains the
SessionStore `audit-append` op (Q-1's recommended home: the
mechanism does not move), an in-memory adapter, and a
composition root that `createWiredAuditStore` delegates to
when the step-5 flag is on. `createKvAuditStore` is
deprecated in place per §22 (successor named:
`createAtomicAuditStore` / the port), retained for
pre-#1760 log reads in tests.

**Scope.** `src/security/iaaaAuditStore.ts`,
`src/security/iaaaAudit.ts` (contract re-export only — the
pure model, validation, and failure policy do not move),
new family files in `src/data/`, the `server.ts`
`createWiredAuditStore` composition sites (factory-only
change). Explicitly out, by §4.3–4.4: chain shape/hash
inputs/verification rules (frozen); the mas_events chain
(landed, not step 5's); `agent_audit_chain` and any
enforcement activation (#2183/#945 lane); destructive
retention (Q-4); D-F.3's append-substrate replacement
(Q-1's deferred decision, not this slice).

**Requirements.**
- Append atomicity is the contract's centre: one backend
  operation chains and stores; a caller-chained event can
  never be stored verbatim (the atomic backend's `append()`
  keeps throwing).
- Cap semantics preserved exactly: hard ceilings
  (2000/2000/10), smaller-only caller caps, refusal as
  `AUDIT_STORE_FULL` data, corrupt-bytes-fail-loud, rotation
  order, genesis/tail rules across segments.
- `list()` remains an admin/integrity read (archives then
  live, chain order) and is never a per-request path; the
  contract says so.
- Conformance: `verifyChain` over the port-composed store's
  `list()` output, across rotation boundaries, in both
  compositions.

**Acceptance criteria.**
- 5a audit characterization (incl. `audit_store_atomic_1760`,
  `audit_coverage_1760`, `iaaa_audit` suites) green against
  both compositions with unchanged expectations.
- Concurrent-append pin: parallel `recordAuditEvent` calls
  produce one unforked chain (the F-18 regression test) on
  the DO adapter.
- Census: the audit composition sites move under the
  family's entry in the step-5 section.

**Test plan.** Dual-composition characterization; rotation/
cap/corruption pins at boundaries (liveMax−1, liveMax,
totalCap, totalCap+1); sabotage: append that stores a
caller-chained event → red; rotation that reorders → red
(via verifyChain).

**Dependencies.** 5b (flag pattern), 5a. Q-1 and Q-4 ruled
before build.

**Rollout.** Flag-gated; the audit path's flag-on is
proposed separately with a verification read (admin
overview + `verifyChain` over the live log) named on the PR.

**Risks.** Evidence integrity — the slice moves no bytes
and no mechanism; its entire risk budget is spent on
proving that (dual-run characterization over the real log
shapes, including archives written pre-slice).

**Traceability.** #1976 step 5 (ADR 0022 §D-I.5, §D-F.3 as
scoped by Q-1); audit §3.5/3.8, §4, §9. #CDO-mha7

---

### Slice 5e — Residual buckets + funnel retirement

**Problem.** After 5b–5d, four bucket families still compose
the funnel directly (`api_keys`, `payments` claims +
draft-owner registry, `slack_principal_links`,
`sessionstore:` credential-ref reads), and `durableKv.ts`
remains an above-layer store module — the step's end-state
is not reached until the funnel's remaining life is inside
the layer or deprecated in place.

**Outcome.** Each residual family behind its port (per Q-6:
small per-family ports, or one residual bucket port with
named, registered key families — the ruling decides);
`consume`-claim semantics (x402 replay, genesis, Slack
links) carried as the claim port's contract with its three
outcomes (`consumed` / `duplicate` / `unavailable`) intact;
the funnel module either becomes the DO adapters' client
inside `src/data/` or is deprecated in place (§22,
successor named) with zero above-layer importers; the
step-5 census section retires to zero and the global
surface-1 entry for `sessionStore.ts` is re-pointed at the
adapter that then owns the class's statements (or the class
moves behind its adapter — Q-2/Q-6 mechanics, decided in
the slice).

**Scope.** `src/security/apiKeys.ts`,
`src/services/agenticPayments.ts` (claim/release sites),
`src/payments/draftOwners.ts`,
`src/trading/channels/intake.ts`,
`src/security/publicOAuth.ts` (ref resolver),
`src/security/durableKv.ts`, `src/security/sessionStore.ts`
(only if the class's composition changes), census pin.

**Requirements.**
- Claim outcomes are never collapsed: `unavailable` stays
  distinct from `duplicate` at every consumer (the x402
  caller must not treat it as "fresh" — the funnel's own
  contract, `durableKv.ts:344–362`).
- Draft-owner resolution stays never-throws/null-on-miss.
- API-key records stay hash-only (the secret is never
  stored — `apiKeys.ts:42–46`).
- The step-5 flag's end-state is decided in this slice:
  removed (composition unconditional) after a soak period,
  or retained as a permanent rollback lever — recorded on
  the PR, not left ambiguous.

**Acceptance criteria.**
- Census: step-5 section empty; surface-1 total drops by
  the sessionStore entry (13 → 11) or the entry's owner is
  renamed to the owning adapter with the count exact.
- Full characterization (§9, all rows) green; no
  above-layer file imports `durableKv.ts` (source-scan pin).
- Flag end-state recorded; §15 for the step names the
  remaining flag state honestly.

**Test plan.** Residual-family characterization dual-run;
claim-race pins (two concurrent claims, one winner);
sabotage: unavailable-collapsed-to-duplicate → red.

**Dependencies.** 5b, 5c, 5d. Q-6 ruled.

**Rollout.** Flag-gated until the recorded end-state;
funnel deprecation is in-place (§22), no file deletion.

**Risks.** Lowest-risk families by traffic, but the x402
claim is money-adjacent: its characterization (replay
across the release path) is the slice's gate.

**Traceability.** #1976 step 5 (ADR 0022 §D-I.5, §D-D);
audit §1.2, §2.3, §9. #CDO-mha7

---

## 9. Characterization inventory (per slice)

Every row runs over the REAL modules (the existing suites
named are the base to extend, not replace). "Dual-run" =
the same expectations pass against the flag-off (today's)
and flag-on (port) compositions.

| Slice | Characterization that must exist BEFORE the slice's composition moves |
|---|---|
| **5a** (builds the base) | Sessions: create → get round-trip; TTL expiry on read incl. the delete-on-read (§3.1); `getSession` corrupt-value → null. Update: remaining-TTL write, past-expiry refusal, invalid-`createdAt` refusal, absolute deadline never extended (§3.6); renewal path (`session_refresh_renewal`, `session_root_refresh` suites). Cache: positive/negative TTL behaviour, invalidation on revoke, cross-isolate propagation bound = positive TTL (`session_read_cache`, `iaaa_revocation_session_cache_1750`). Revocation: registry listing filters to UUID keys only (bindings/membership/audit/access keys in the same bucket never parse as sessions); bulk revoke removes exactly the principal's sessions (`iaaa_lifecycle_*_1758`, `iaaa_revocation*`). |
| **5b** | All 5a session rows, dual-run. Bindings: both lookup directions resolve; bindings never expire; a binding key never lists as a session. Membership + access requests: create/read/update round-trips over the real wiring (`iaaaLogin` compositions in `server.ts`). List-op restriction: a list against a non-sessions bucket (other than the etrade token prefix) is refused at the DO. |
| **5c** | Token write/read: `storeAccessTokens` → scoped key; candidate resolution order internal-id → alias → login, scoped → unscoped; corrupt candidate skipped for a healthy fallback (`etradeTokenResolution2386`). `getValidTokens`: cache hit/miss/epoch rules; identity-aware bypass; unscoped-environment guard. **Expired read: midnight-ET boundary (pinned with a supplied clock) → revoke set deleted (all envs, scoped+unscoped, case variants, identity+alias) + cache invalidated + null returned (§3.2).** Renew: before-midnight succeeds and re-stores; at/after midnight → `TOKEN_EXPIRED`, nothing written; bulk renew lists via the DO list op and skips expired (`etrade_token_cache`, `session_refresh_renewal`). Revoke: `revokeStoredTokens` full set; `revokeRemoteAccessToken` upstream call + local purge. Public: PAT stored only after verify; `sessionstore:` ref resolution reads the referenced bucket/key and fails with the named errors. |
| **5d** | Append: genesis event (previousEventHash null); chain linkage across live → archive rotation; `verifyChain(list())` true after rotations at liveMax boundaries; cap refusal at totalCap returns `AUDIT_STORE_FULL` and writes nothing; corrupt live or archive bytes → loud failure, bytes untouched (§3.5). Concurrency: N parallel `recordAuditEvent` calls → N events, one chain, no fork (F-18). Policy: `classifyAuditFailure` consequential → block, non-consequential → allow-with-warning; `isAuditedSuccess` truth table (`iaaa_audit`, `audit_store_atomic_1760`, `audit_coverage_1760`). Reads: audit-access events recorded for read/export; admin overview tenant filter stays an admin read. Pre-slice archives (written by the legacy shape) remain readable/verifiable. |
| **5e** | Claims: concurrent `consumeStoreKey` → exactly one `consumed`; second → `duplicate`; namespace absent → `unavailable` (never `duplicate`); release deletes the claim (x402 path). Genesis `putIfAbsent`: first claim wins, DO-unreachable → false (fail-closed). Draft owners: register → resolve round-trip; unknown draft → null, never throws. API keys: create → hash-only record (no secret material in the stored value); verify by hash; revoke deletes. Slack links: claim + resolve over the consume path. |

---

## 10. Risks / open questions for the parent

**Step-specific risks (summary).** This step touches the
live auth path and the evidence log — the two surfaces
where a silent behaviour change is an incident, not a
regression. The mitigations are structural and already in
the slice plan: characterization before composition (5a),
one backend behind both compositions (no data migration,
no dual-write — the IV step-2 shape without its two-store
risk), flag-off = today byte-identical, and the token
family sequenced after the pattern is proven. Two risks
deserve naming beyond the plan: (i) the isolate caches
(session + token) sit *in front of* the store and are
invalidated by convention — a port migration that adds a
write path without the invalidation obligation (§3.6)
creates a revocation lag no store-level test will catch;
the characterization therefore pins cache behaviour, not
just store behaviour. (ii) SessionStore's rows-read budget
is a production capacity constraint (#1819: 5M rows
read/day free-tier; the 2026-10-26 exhaustion took sign-in
down) — any slice that adds a read (a new list, a
verification leg on a hot path) must account rows in its PR
via the existing `store_op` measurement, or the step
re-opens #1819.

**Open questions (Q-items) — a ruling is needed before the
named slice builds.**

- **Q-1 — The audit-append op's home, and D-F.3's deferred
  substrate.** Options: (a) step 5 ports the contract and
  keeps the mechanism — the DO adapter's append IS the
  SessionStore `audit-append` op, whole-log JSON and all;
  D-F.3's append-only-table replacement becomes a separate,
  later decision (its natural drivers are G-5's formal
  closure and the Sentinel's published-plane needs under
  D-F2, neither of which step 5 owns). (b) Step 5 builds
  D-F.3's substrate now (append-only table + single-writer
  port) and migrates the log onto it.
  **Recommended: (a).** Basis: D-I step 5 scopes a migration
  step ("Session/durableKv + IAAA store last … flag
  gating"), while the mechanism replacement is D-F.3's
  text, gated by G-5 — and the D-0 IAAA row's deciding
  factor is "where D-F.3's single-writer append port is
  hosted", a substrate question the ADR deliberately left
  open. The whole-log store's known costs (whole-log read
  per append) are bounded by the #1760 caps and rotation;
  its known virtue is that its atomicity *is* the funnel's
  serialization, proven in production. Option (b) inside
  step 5 would couple the riskiest migration in the
  programme to an unbuilt substrate and a lane gate (G-5)
  this lane cannot close alone. What (a) must not become:
  a quiet burial of D-F.3 — the 5d issue (§8) names the
  deferral, and the step's §15 should carry it as a filed
  follow-up, not a footnote.
- **Q-2 — Flag identity and semantics.** Options: (a) one
  flag for the step (e.g. `SESSION_STORE_PORTS_ENABLED`),
  read at every family factory, #1169 semantics (absence =
  off, not in wrangler, rollback = unset); per-family
  flag-on still possible operationally only as all-or-
  nothing. (b) One flag per family (session / tokens /
  audit / residual), same semantics.
  **Recommended: (b), with (a)'s semantics.** Basis: the
  families' risk profiles differ by an order of magnitude
  (the token family's flag-on wants its own outside-in
  verification in the signed-in app; the audit family's
  wants a verification read of the live log); a single flag
  forces the step's riskiest flip to gate its safest. The
  precedent cost is nil — flags here are env reads at
  factories, and #1169/IV both read exactly one predicate
  per composition site. Names should say what they gate:
  e.g. `SESSION_PORTS_ENABLED`, `TOKEN_PORTS_ENABLED`,
  `AUDIT_PORTS_ENABLED`, `BUCKET_PORTS_ENABLED`.
- **Q-3 — SessionStore's schema marker: in 5a, or deferred?**
  D-A.4's marker landed for the ORM DOs
  (`src/data/doSchemaMarker.ts`); SessionStore — the last
  unversioned DO — creates `kv_store` in its constructor
  with no marker. **Recommended: land it in 5a** (already
  scoped there, §8). Basis: it is additive and
  behaviour-free; every later step-5 slice edits this
  class's neighbourhood, and the first time the class needs
  a schema change (an index for listings is the obvious
  candidate) the marker must already exist to version it.
  Deferring saves nothing and re-opens D-A.4 for the one DO
  where an unversioned change would be least visible.
- **Q-4 — Audit retention: confirm out of scope.**
  The store files record destructive retention as awaiting
  Q7; the programme record has CDO's #945 sign-off (365 d,
  ratifying #786's mechanism) with CISO's half outstanding.
  **Recommended: step 5 implements no age-based deletion of
  IAAA events; the cap-refusal (`AUDIT_STORE_FULL`) is
  preserved verbatim, and the step's §15 names the residual
  explicitly.** Basis: the code's own record (both headers)
  treats the decision as unmade; a migration step is the
  wrong vehicle for a retention decision, and deleting
  evidence under a half-closed gate is irreversible in a
  way no other step-5 act is. If the parent wants retention
  built, it is a separate issue gated on Q7's formal
  closure — and note the mas_events side is already
  implemented (365 d prune), so the residual is IAAA-log
  only.
- **Q-5 — `verifyStoredAuditChain` has no production
  consumer: step 5's problem, or a filed gap?** The verify
  entry point for the mas_events chain is test-only on this
  base (§4.2). **Recommended: not step 5's build — but the
  parent should file it as a named gap** (an integrity leg
  on an existing tick, or an admin-surface read, in the
  #1169 S4-4 corpus-sync shape) rather than let "verify
  entry point exists" read as "verification happens".
  Basis: D-F2's publication-honesty rule (a silently
  unverified chain is a blind spot of exactly the kind the
  substrate exists to remove); step 5's slices neither add
  nor remove verification surface, so folding it in would
  blur two acceptances. Flagging here because this audit is
  where the gap is measured.
- **Q-6 — Port granularity for the residual buckets.**
  Options: (a) per-family micro-ports (ApiKeyPort,
  ClaimPort, DraftOwnerPort, SlackLinkPort, CredentialRef
  reader); (b) one residual `BucketPort` (get/put/delete/
  consume over a registered key-family list).
  **Recommended: (a) for claims, (b) for the rest — i.e. a
  named ClaimPort (consume's three-outcome contract is a
  domain operation, D-E.3-shaped, shared by x402/genesis/
  Slack), and per-family thin ports elsewhere; a generic
  BucketPort only if a family is genuinely key-value-shaped
  with no domain rule (draft-owner registry is the
  candidate).** Basis: D-A.1's per-aggregate rule plus
  D-E.4 ("a port that degenerates into a query passthrough
  is a layer defect") — `consume` has a real contract
  (atomicity, three outcomes, fail-closed) that a generic
  bucket port would dissolve into convention, while
  draft-owner get/put has no rule beyond never-throws,
  which a thin named port still states better than a shared
  one. The ruling shapes 5e's file count, nothing else.

**Carried items this audit does not decide:** the ADR's
gate table (G-5's formal status, R-4) is the parent's to
annotate; #2183's enforcement activation is the #945 lane's;
the learnings two-host question (R-1, step 4) remains open
and untouched by step 5 — after 5e, the census's surface-1
remainder is exactly: learnings 7 (R-1), orchestrator lift
3 (permanent), cfAgentsAdapter 1 (permanent) = 11.

#CDO-mha7
