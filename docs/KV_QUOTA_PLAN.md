# KV free-tier quota: feasibility assessment and plan (issue #329)

Status: **decision required** — plan only, no code changed.
Last updated: 2026-10-19.

## 0. Verdict

**Can this run inside the KV free tier? Yes — but not by batching writes or tuning TTLs. Neither of those touches the dimension that is actually being consumed.**

Three findings drive the plan:

1. **The binding dimension is almost certainly reads, not writes.** Reads scale with *every authenticated API request* (`requireAuth` → `getSession` → one KV read). Writes are event-shaped and tiny: I count roughly 10–60 per day from code, not 500.
2. **Steady-state UI polling alone can exhaust the daily read budget with ~4 idle browser tabs.** The 4-second job poll is the single largest consumer.
3. **The free tier is one quota pair, not one quota — and both dimensions land on the same ceiling.** Every authenticated request costs exactly one KV read *and* one Workers request, and both budgets are 100,000/day. So "~4 tabs" is true of either axis, and **removing the KV read (cookies) does not raise that ceiling** — the request count is unchanged.

**Recommendation: fix request volume first, via polling hygiene. On the free plan that alone is sufficient, and cookies add nothing on top of it, because the request ceiling then binds at the same number. Cookies are worth doing later only for resilience (auth surviving a KV outage) — not for capacity.**

---

## 1. The limit, exactly

Verified against Cloudflare's docs ([KV limits](https://developers.cloudflare.com/kv/platform/limits), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing)):

| Dimension | Free plan | Excess behaviour |
| --- | --- | --- |
| Reads | 100,000 / day | Further reads fail |
| Writes (new keys) | 1,000 / day | Further writes fail |
| Deletes | 1,000 / day | Further deletes fail |
| List | 1,000 / day | Further lists fail |
| Storage | 1 GB | — |
| Same-key writes | 1 / second | Writes above that rate to one key are rejected |

Two details that matter here:

- **All limits reset at 00:00 UTC** and failing is per-operation-type, hard, with no grace period.
- **Dashboard and `wrangler` operations count as billable KV usage.** Any monitoring that inspects KV via `wrangler kv` spends the quota it is measuring.

Correction to the issue's framing: the platform returns **429 on KV operations** once a limit is hit, and `requireAuth` is the first KV call on every `/api/*` request (`src/server.ts:1048`). So at 100% of *reads*, users see **a 401 on every authenticated route** while the quota is exhausted — not merely failing writes. That is the harder outage, and the one worth planning against.

---

## 2. Where the quota actually goes

### 2.1 Read path

One read per authenticated request, no caching in between:

```
/api/*  →  src/server.ts:1048  →  requireAuth (src/server.ts:1248)
                                →  getSession (src/security/session.ts:29)
                                →  env.SESSIONS.get(sessionId)     ← 1 KV read
```

There are 23 `requireAuth` call sites in `src/server.ts` — including the generic gateway at `1048`, which covers every remaining `/api/*` route.

Measured per-tab consumption (one dashboard tab, panels left mounted):

| Client poller | Interval | Requests/day | KV reads/day |
| --- | --- | --- | --- |
| `AsyncJobsPanel.tsx:39` → `/api/jobs` | 4 s | 21,600 | 21,600 |
| `ScreenersHub.tsx:134` → `/api/screener/latest` | 30 s | 2,880 | 2,880 |
| `MarketTickerTape.tsx:115` → `/api/market/quotes` | 12 s (fallback only) | 0–7,200 | **0 KV** — bypasses the auth gateway, and the component prefers WebSocket (`MarketTickerTape.tsx:130`); the 12 s poll only runs while the socket is not open |
| **Total (normal operation)** | | **24,480** | **24,480** |

So **one idle tab ≈ 24% of the daily KV read budget**, and ≈24% of the daily Workers request budget. Four tabs left open ≈ 98k reads ≈ the full day.

Trading routes add a second read per call: `getStoredTokens` (`src/security/etradeOAuth.ts:170`) does an environment-scoped `get` and falls back to a legacy key on miss — 1–2 reads per call, on user-initiated actions only.

### 2.2 Write path

Every KV mutation in the codebase, with its rate:

| Site | Operation | Cost |
| --- | --- | --- |
| `src/security/session.ts:24` (via `githubOAuth.ts:83`) | session create | 1 write per login |
| `src/security/etradeOAuth.ts:122` | access token store | **2 writes** (env-scoped + legacy key, same payload) |
| `src/security/etradeOAuth.ts:141` | request token store | **2 writes** |
| `src/security/etradeOAuth.ts:191` | revoke | **up to 18 deletes** (3 login casings × 6 keys) |
| `src/services/agenticPayments.ts:281` | x402 tx consume | 1 write + 1 delete per payment |
| `src/agents/memory.ts:37` | memory fallback | only when DO SQL is unavailable — effectively never |
| `src/server.ts:903` | Slack install | 1 write per install |

No `list()` calls anywhere in `src/`, so the list budget is untouched. Nothing here is in a loop: the cron handler uses a single hard-coded identity (`default_trader`, `src/server.ts:1159`) and does not fan out across sessions.

**Conclusion: writes are O(10–60)/day. Write exhaustion is not the near-term risk.** Batching writes would optimise the dimension with two orders of magnitude of spare headroom.

### 2.3 A note on namespace accounting

`wrangler.jsonc` binds `SESSIONS` and `ETRADE_KV` to the **same namespace ID** (`f169a71089264590baeef28f851ebfc5`). They are one bucket. Any per-binding mental model of the quota is wrong — sessions, tokens, Slack, and x402 replay keys all draw from one 100k/1k budget.

### 2.4 Direct answers to the questions in #329

| Question in the issue | Answer |
| --- | --- |
| Which namespaces consume the most? (`ETRADE_KV`, `SESSIONS`) | Neither, as a separate matter — they are the **same namespace ID**. Reads dominate; they come from session lookups, which belong to no single binding. |
| What operations drive usage? (token refreshes, session writes, screener runs) | **Session reads on every `/api/*` request.** Token refreshes and session writes are a rounding error; screener runs persist to Durable Object SQLite, not KV. |
| Unnecessary writes to batch or cache? | Writes are not the constraint (~10–60/day). The duplicate legacy-key writes and up to 18 deletes per revoke are worth trimming, but they will not move the number. |

---

## 3. What the 50%-at-00:47 reading implies

The alert is timestamped **00:47 EDT** (per the issue body) = **04:47 UTC**, and the counter resets at 00:00 UTC — so **17,220 seconds** of the day had elapsed, not 47 minutes.

| If the 50% is… | Threshold | Implied rate | Consistent with the code? |
| --- | --- | --- | --- |
| **Reads** | 50,000 | ~2.9 ops/s | One idle tab is ~0.28 ops/s. That is **~10 concurrently open dashboards**. Firmly plausible. |
| **Writes** | 500 | ~0.029 ops/s | Would need ~500 login / token / payment events before 05:00 UTC. The ledger predicts ~10–60 for the *whole day*. **8–50× short.** |

So the reading is consistent with reads under ordinary load, and **no runaway loop is required to explain it**. It also gives a concrete operating figure: roughly ten open dashboard tabs is where the free tier is half spent before breakfast.

**Runway:** at 2.9 ops/s the day's 100,000 reads are exhausted 34,435 s after reset — about **9.6 hours in, ≈09:35 UTC / 05:35 EDT**. The 50% alert therefore carried roughly **five hours** of headroom, checked hourly.

The attribution step (P0.1) still stands, but as confirmation of tab count and path mix rather than a hunt for a loop: if the logs show `/api/jobs` dominating, the model holds; if some path is hot that no client polls on a timer, that *is* a real defect and outranks everything below.

**Monitor threshold.** An hourly 75/90% check is the wrong shape for this profile — it leaves at most a couple of checks between "fine" and 429. Alert at 50%, and alert on **rate** (>5%/hour) rather than on level alone, so a fast climb is visible before it is terminal.

---

## 4. The correlated wall

Fixing KV reads does not end the quota conversation, because the same polling spends the **Workers request allowance: 100,000/day on the free plan**. A tab costs ~24.5k of *both* budgets. After a sessions-off-KV fix, a tab costs 0 KV reads but still 24.5k requests — so ~4 tabs would hit the request wall instead, just as hard.

This is why polling hygiene is part of the same change, not a follow-up optimisation.

**The two walls are the same wall.** Both budgets are 100,000/day and both are spent one-per-request, so the tab ceiling is identical on either axis (~4 today). A signed cookie or a session cache drives KV reads toward zero but leaves the request count untouched — **the ceiling does not move**. Only sending fewer requests moves it. What a cookie buys is *decoupling*: KV reads then stop competing with other KV consumers, and auth survives a KV quota exhaustion. That is a resilience property, not capacity. On the paid plan the ratio is still 1:1 (10M/month each), so the same holds there.

---

## 5. Plan

### P0 — Confirm the attribution and fix the alerting (today, ~15 min, no code, no deploy)

1. Query Workers Logs (invocation logs are enabled at 100% sampling in `wrangler.jsonc:43`) for the 00:00–04:47 UTC window, grouped by path. If `/api/jobs` dominates → the model in §2.1 holds. If any path is hot that no client polls on a timer → real defect, escalate ahead of this plan.
2. Confirm which gauge the monitor reads (reads vs writes vs total ops) and which window it uses. Record both in the issue.
3. Verify the monitor does not itself call `wrangler kv` (that spends quota it is measuring).
4. Repoint the monitor: 50% threshold plus a rate-of-change alert; keep 75/90% as escalation.

**Exit criteria:** the 04:47 reading is attributed to a named path and a tab count in #329, and the monitor alerts at 50%.

### P1 — Fix request volume (the change that actually moves the ceiling, ~2 hours)

| Change | Before | After | Effect |
| --- | --- | --- | --- |
| `AsyncJobsPanel` poll | 4 s, always | 20 s, paused when no job is in flight and when the tab is hidden | 21,600 → 4,320 req/day/tab |
| `ScreenersHub` poll | 30 s | 60 s, pause when hidden | 2,880 → 1,440 req/day/tab |

`document.visibilityState` gating is the cheap half of this — backgrounded tabs are the common case for a trading dashboard left open. Restoring the fast interval only while a job is in flight preserves the UX that motivated 4 s. Combined: **5,760 requests/tab/day, ~17 concurrent tabs.**

Optional further cut: collapse both pollers into one `/api/poll` response, which halves the remaining request cost again.

### P2 — Optional: decouple auth from KV (not required for quota)

Skip this entirely if the goal is only to fit the free tier — P1 already gets there. Do it if you want **auth to keep working when KV is exhausted or degraded**, which is the actual failure mode in §1.

Two ways, neither of which requires switching to cookies:

**P2a — stateless signed cookie.** Payload is small (`SessionData`); `hmacSign`/`verifyState` in `src/security/session.ts:42` already implement the pattern for OAuth state. Zero KV reads on the auth path. Cost: logout can no longer revoke instantly — bound it with a TTL and re-check sensitive actions (`src/server.ts:926`) against an authoritative store.

**P2b — short-TTL session cache, no cookie, KV stays the source of truth.** A bounded `Map` in front of `getSession` with a 30–60 s TTL. At a 20 s poll that is roughly a 3:1 hit ratio, so reads fall ~66%. Note that KV is already eventually consistent with up to ~60 s propagation across colos, so this adds **almost no new staleness** to the guarantee you already have. Requirements: bound the map, keep negative (miss) entries very short-lived, purge on local logout, and bypass the cache on order execution / token revoke so the sensitive paths stay authoritative.

P2b is the lower-risk option and the better fit if the objection to cookies is revocation semantics — it keeps KV authoritative and only shortens how often you ask.

### P3 — Write hygiene (~1 hour)

| Change | Site | Saves |
| --- | --- | --- |
| Drop the duplicate legacy-key write (keep env-scoped, read the legacy key once behind a migration) | `etradeOAuth.ts:122,141` | 50% of token writes |
| Revoke only the keys that exist (resolve environment first) instead of all 18 | `etradeOAuth.ts:191` | up to 12 deletes per logout |
| Move the x402 replay guard into a Durable Object | `agenticPayments.ts:281` | quota-neutral, **fixes a correctness bug** |

That last one is worth doing regardless of quota: `consumeTxHash` is a `get`-then-`put` guard on an eventually-consistent store, so two concurrent requests carrying the same payment hash can both pass in different colos. A DO gives serialised, strongly-consistent dedupe — and the codebase already runs five of them.

### P4 — Guardrail (~1 hour)

Document the budget in `docs/OBSERVABILITY.md` (reads, writes, the 00:00 UTC reset, the "dashboard ops count" trap), and add the rule that no new KV read may be added to a per-request path — new hot-path state belongs in a DO.

---

## 6. Budget after each phase

| State | KV reads/tab/day | Requests/tab/day | Notes |
| --- | --- | --- | --- |
| Today | 24,480 | 24,480 | ~4 tabs exhausts both; they fail together |
| After P1 | 5,760 | 5,760 | **~17 tabs** — both axes move together |
| After P1 + P2a (cookie) | ~0 + token reads | 5,760 | Ceiling unchanged at ~17; auth now survives KV exhaustion |
| After P1 + P2b (cache) | ~1,920 | 5,760 | Ceiling unchanged; KV authoritative |
| After P1 + P3 | 5,760 | 5,760 | writes <30/day, deletes <20/day |

Post-P1, the Workers request allowance is the binding constraint and KV reads sit at the same level — which is why the auth change is optional rather than structural.

---

## 7. Feasibility verdict

**Viable: yes, at current and near-term usage — and P1 alone is enough to get there.**

- Today, no: the free tier is a single-tenant demo budget, and this app's polling profile spends a whole day's allowance per four idle tabs. Consistent with the observed 50% at 04:47 UTC.
- With P1 alone: ~17 concurrent always-open tabs, both axes moving together. **Sufficient for current usage without touching auth.**
- With P1 + P2a/P2b: same ceiling, plus auth that does not depend on KV being healthy. Worth it for resilience, not for capacity.
- Growth limit: the free tier gives out around 17 concurrently open dashboards, or on any new per-request endpoint. **Not a viable steady state beyond modest growth** — a viable *stage*.

**On spending $5/mo:** the paid plan buys ~3.3× on both quotas (10M KV reads and 10M requests per month) and, more importantly, **replaces the daily hard cliff with monthly metered overage**. For a system where exhaustion surfaces as a 401 mid-session, the cliff is the hazard, not the volume. Recommendation: ship P1 and P3 — P1 for capacity, P3 because a racy payment guard is a defect either way — then adopt the paid plan at the first sustained watermark above 60%. P2 can wait for a reason other than quota.

---

## 8. Assumptions and open items

- The read/write attribution in §3 is inferred from code, not measured. **P0.1 settles it.**
- Concurrency is unknown: the per-tab model assumes panels left mounted, which is the normal state for this UI.
- `SessionData` size is small enough for a cookie; to be confirmed against the cookie limit before P2a.
- Not investigated: Worker CPU/DO request quotas, and whether `assets.run_worker_first: true` (`wrangler.jsonc:8`) makes static-asset requests count against the 100k request allowance. If it does, page loads are a larger consumer than polling and that ordering changes. Worth checking before P1 sizing.
