# OpenAIMP/cfagent — RSI-Data Plan: Recursive Self-Improvement of Data Capabilities

_Synced 2026-10-20 from a full data-layer survey: all 60 open issues read and classified, plus a code cross-check of current main @ `5ca67612`. Repo: https://github.com/OpenAIMP/cfagent_

## Status — ACTIVE (2026-10-20)

Epic: **#798** — [RSI-Data plan] Recursive self-improvement of data capabilities + paired user offerings.
Sibling plans: #764 (RSI-InfoSec), docs/plans/rsi-ai-plan-2026-10-20.md, docs/plans/rsi-product-plan.md.

Working rule (gitops): one issue at a time — one branch, one focused PR, merge, post-merge check verification — before the next item starts.

## Why this plan exists

The survey's headline: the filed data issues are mostly one migration story (#415, off KV) plus feature-data gaps. The dangerous part was **not filed at all** — the schema/ORM/persistence-integrity cluster had no owning issue, and the code cross-check found the persistAudit failure pattern (a write that silently never lands, #700 point 2, fixed by PR #772) generalized across the data layer.

The recursive loop this plan runs:

**Integrity → Coverage → Consolidation → Offerings.** Each tier's output is the next tier's input: records that provably land and read back (Tier 1) make coverage features honest (Tier 2); honest, complete data justifies removing the storage ceilings (Tier 3); and only then do user-facing offerings built on the data (Tier 4) mean anything. Every tier names its **paired user offering** — what a user can newly trust or do — alongside the internal fix.

## Tier 1 — Persistence integrity: make stored data trustworthy

_No open issue owned this tier before this plan. Children filed 2026-10-20._

| Issue | Item | Essence |
|---|---|---|
| #781 | C1 — stub-ORM black hole | 7+ sites fall back to `new DatabaseORM({ exec: () => [] })` (voice/slack/email agents, unifiedOptionsService, scheduledTasks ×4): reads return empty, writes vanish, no error ever. Production paths pass a real ORM today; nothing pins it. Fail loud at construction + pin. |
| #782 | C2 — dual DDL | 7 core `mas_*` tables defined twice (`orm/index.ts` initializeSchema vs orchestrator `ensureTables`), byte-identical today, first-to-run wins. Single-source + drift pin. `initializeSchema` is called in exactly one place. |
| #784 | C4 — reflection swallows | 5 bare `catch {}` in `reflection.ts` hide `mas_learnings` write failures while runs report success counts. The RSI loop (#753/#757/#775) is about to build on this substrate. |
| #783 | C3 — write-only report store | ScreenerAgent's own `mas_reports` (the #732 fix) is written on every scheduled screen and read by nothing; readers use the orchestrator's copy. Remove the dead write. |
| #785 | C5 — dual payment ledgers (audit) | agenticPayments (→ `mas_transactions`) vs PaymentsAgent DO's single whole-array storage blob (read-modify-write race, unreconciled). Audit and name the authoritative ledger; consolidation scoped from evidence. |

**Paired user offering:** every promise the product already makes — audit trails, reports, learnings, payment records — becomes actually true, and stays true under a pin.

## Tier 2 — Data coverage & quality: give features the data they're missing

| Issue | Essence |
|---|---|
| #16 | Earnings/dividend event calendar. Verified: zero `daysToEarnings` in `src/`; no calendar source exists; `eventPolicy: 'exclude'` is binary-broken because verification is impossible. Unblocks #18's EVENT_NEAR and honest event-risk labels everywhere. |
| #14 | Discovery Phase 1: run store + delta (the epic's "Remember") with provenance (modelVersion, config hash). Substrate exists (`mas_discovery_runs`, 365-day prune) but stores scheduled-request runs, not detect→infer items. |
| #773 | "Evaluation datasets and scores sit in the database. Nothing reads them." Feed stored evaluation outcomes into screener gates. |
| #753 | Wire reflection output (#705) into the strategy-review queue (#653) — the data exists, the queue doesn't read it. |
| — | IV history maturation (#15, closed): collecting since 2026-10-17; warming-up mode until ~60 observations/name. A coverage surface, not a build. |

**Paired user offering:** candidates stop carrying "event risk unverified"; discovery gains memory across runs; the screener starts learning from its own track record — the first user-visible compounding.

## Tier 3 — Migration & consolidation: remove the ceilings

| Issue | Essence |
|---|---|
| #605 | [415 phase 3] PDFs → R2. Code merged (PR #631); blocked on bucket + `r2_buckets` binding — **neither exists** (verified). |
| #606 | [415 phase 4] Remove KV bindings/namespaces from wrangler (both still bound, to the *same* namespace id; zero code references). Blocked on #605. |
| #338 | R2-vs-DO split for report bodies — design posted 2026-10-20 (body → R2 `reports/<id>.json` in bucket `cfagent-reports`; metadata + search stay in `mas_reports` + `body_r2_key`). Build waits on design acceptance. |
| #786 | C6 — no retention for `mas_events` / `mas_transactions` / `mas_memory` (unbounded per-instance growth; #772 added a write per paid scan). |
| #789 | C7 — SessionStore is ONE global DO instance for all tenants' sessions/tokens/keys (design + trigger condition; sharding only when warranted). |
| #791 | C8 — dead `SESSIONS`/`SESSIONS_KV_FALLBACK` type declarations + stale "KV" terminology (quick win; tsc is the proof). |
| #792 | C9 — parallel idioms audit: `usage_events` vs `mas_events`; ScreenerAgent blob task ledger. Determine: consolidate or document. |
| #329 / #402 | KV free-tier incident family — root cause fixed; ripe for a verify-and-close pass once #606 lands. |

**Owner decision blocking this tier:** the provisioned bucket is named **"screener"**; #605 and #338 both name **"cfagent-reports"**. One name must win before anything is bound — this single decision unblocks #605 → #606 → #338 in sequence.

**Paired user offering:** reports/PDFs stop consuming DO storage; the free-tier quota incident class closes for good; report delivery can link canonical bodies instead of inlining them.

## Tier 4 — Offerings built on the data

| Issue | Essence |
|---|---|
| #755 | Adaptation budgets + immutable audit-trail store for autonomous changes — the store does not exist; foundational for the chain below. |
| #754 / #757 / #759 / #760 | Calibration-driven weight adjustment; improvement-candidate generation; adaptation gates — all derivative of #755's store and #583/#340 evaluation data. |
| #654 | Calibration dashboard (UX consumer of #17 data). |
| #768 | Secrets inventory + rotation policy. |
| #769 | Model/prompt supply chain: version pins + eval gates (a governance registry for behaviour-bearing config). |
| #488 | Conformance tracker (carries data lines: #415 checklist; per-tenant observability). |

**Paired user offering:** governed self-improvement with a human-readable trail, calibration users can see, and the compliance posture the RSI plans promise. All fiction until Tiers 1–2 make the underlying records real.

## Data-layer map (verified on main @ 5ca67612)

Eight DO classes are bound in `wrangler.jsonc` (`SearchAgent` aliases `OrchestratorAgent`).

- **OrchestratorAgent** (per-user) — the main data home. Inline DDL `ensureTables()`: `mas_messages`, `mas_async_jobs`, `mas_events`, `mas_memory`, `mas_autopilot`, `mas_settings`, `mas_report_confirmations`, `mas_policy_verdicts`, `mas_referrals`, `mas_ads`, `mas_watchlists`, `mas_transactions` (evolution by additive ALTERs). ORM `initializeSchema()` adds `mas_categories`, `mas_external_ads`, `webhook_replay_nonces`, `mas_trades`, `mas_options_chain_cache` (and duplicates 7 of the above — #782). Lazy self-ensuring stores on the same SQL: `mas_reports`, `usage_events`, `mas_learnings`, `mas_strategy_reviews`, `paused_schedules`, `mas_opportunity_scans` (365-day prune), `mas_discovery_runs` (365-day prune), `mas_iv_history`, `mas_strategy_profiles`.
- **SessionStore** — one global instance; generic `kv_store (ns, key, value, expires_at)` holding sessions, E*TRADE tokens, API keys, payment nonces for all users (#789).
- **ScreenerAgent** (per-user) — `ctx.storage` keys (`screener:history`, `screener:pdf:*`, slot claims, `screener:task:*` ledger) + its own write-only `mas_reports` (#783) + an ORM it constructs but never initializes.
- **ResearchAgent** (per-user) — own `ensureTables()`: `research_settings`, `research_runs`, `research_evaluations`, `research_task_store`; reports forward to the orchestrator's `mas_reports`.
- **PaymentsAgent** — no SQL; the ledger is one `ctx.storage` blob + a BudgetGuard blob (#785).
- **ScheduledAgent** — `ctx.storage` blobs (`goals`, `tickHistory` capped 50). **ReportAssetAgent** — key/value asset puts. **OptionsScannerMCP** — no local audit persistence since #772; forwards to the orchestrator.
- **Residue:** `SESSIONS` + `ETRADE_KV` still bound (same namespace id, zero code refs — #606); `REPORTS_BUCKET` typed optional, never bound; no `r2_buckets` in production config; `VECTOR_MEMORY` bound and used.

Already resolved (do not re-pick up): sessions/tokens off KV (SessionStore, `legacyFallback: false`); scanner persistAudit (#772); silent-empty E*TRADE contracts (#155/#168); #764's P0 persistAudit item is stale (acknowledged in-thread by its lane).

## Survey method & evidence standard

All 60 open issues were read (title + body) via the GitHub API on 2026-10-20 and classified; every code claim above was verified against a fresh copy of origin/main @ `5ca67612`. Two claims are absence-of-evidence and are labelled as such in the child issues: C1's production reachability of the stub (no pin exists — that absence is the finding) and C5's "no reconciliation" (full-repo grep).

## Progress log

- 2026-10-20 — Plan filed as epic #798; Tier-1 children #781–#785 and Tier-3 children #786/#789/#791/#792 filed. Build order starts at #781 (C1).
