# Screening System Runbook

Epic #1096 (autonomous stock & options screening), Phase 6 (#1162).
Operator runbook for the goal/scenario screening system: what runs on
its own, what gates it, how to pause it, how promotions are approved,
and how to recover when something goes wrong.

The system's honesty contract, which every procedure below preserves:
missing inputs are **Unverified**, never estimated; auto-discovered
goals and strategy re-selections are **proposals** until a person
confirms them; nothing the system produces is a trade instruction, and
no delivery claims a guaranteed outcome.

## 1. What runs, and when

Everything autonomous rides the existing schedules — the screening
system added **no new cron triggers** (Workers cron ceiling).

| Job | Trigger | Guard | Marker (mas_settings) |
| --- | --- | --- | --- |
| Research run (#319) | Worker cron `*/30 * * * *` → `POST /research/scheduled-tick` | `shouldFireResearchTick` (#354): once per weekday at/after 21:00 UTC | `research_scheduled_last_run` |
| Goal/scenario discovery (Phase 3) | Same tick, after the research run | Agent-side guard, same #354 idiom | agent durable state |
| Strategy-bank re-selection (Phase 3) | Same tick (Phase 6 wiring) | `shouldFireStrategyBankTick`: once per weekday at/after 21:00 UTC | `strategy_bank_reselection_last_run` |
| Strategy-weights v2 job (Phase 5) | Same tick (Phase 6 wiring) | Kill switch + adjustment budget inside the job | — (append-only outcome rows) |

The tick handler is `handleScreenerResearchRoutes`
(`src/agents/routes/screenerResearch.ts`). Every #1096 step is
best-effort: a failing step is recorded and never fails the tick.
Portfolio state is not supplied on the scheduled path, so
portfolio-triggered discovery skips with the limitation recorded by
the engine.

## 2. Feature flags (mas_settings)

All screening flags live in `mas_settings` and are read through
`src/services/screeningFlags.ts`. They are visible and writable in the
dashboard (Options Research → Schedules → *Autonomous Screening
Activity*) and via `GET|POST /api/screening/controls`.

| Key | Default | Fail-safe on read error | Meaning |
| --- | --- | --- | --- |
| `screening.rolloutStage` | `internal` | `internal` | Rollout stage (§6). Recorded state only — the system never advances it. |
| `screening.channelsEnabled` | off | off | Master switch for screening deliveries (Slack / email / signed webhook). |
| `screening.weightsV2Ranking` | off | off | Production consumer of Phase 5 v2 weights in discovery ranking (guarded, §5). |
| `screening.scheduledPaused` | not paused | **paused** | Pauses every #1096 step on the tick. Fail-closed, the #756 idiom. |
| `screening.nlqFitDiscovery` | on | off | Kill switch for the NLQ fit-discovery phrases (§4). Default on because the surface ships labeled and draft-only; set `off` to disable phrases without a deploy. |

## 3. Kill switches and pause

Fastest first:

1. **Pause the screening system**: set `screening.scheduledPaused=on`
   (dashboard toggle or `POST /api/screening/controls`). Discovery,
   re-selection, weights-v2, and tick delivery all skip; each skipped
   tick records a `schedule_control` entry in the activity log. The
   #319 research run and its evaluations are **not** paused — they
   predate the screening system and have their own controls.
2. **Stop all deliveries**: set `screening.channelsEnabled=off`.
   Deliveries already sent cannot be recalled; the activity log shows
   every attempt and its per-channel result.
3. **Halt autonomous adaptation globally**: set
   `adaptation.killSwitch=on` (the #755/#756 switch,
   `src/services/adaptationAudit.ts`). The weights-v2 job routes
   through that seam and halts; its tick summary says so explicitly.
4. **Disable NLQ fit discovery**: set `screening.nlqFitDiscovery=off`.
   The NLQ action then refuses with an explicit error instead of
   answering a different question.

## 4. Operator surfaces

- **Activity log**: `GET /api/screening/activity?limit=N` — one
  newest-first feed over `mas_screening_activity` (discovery runs,
  re-selections, weights adjustments, deliveries, control changes,
  bundles) merged with Phase 3 re-selection proposals and Phase 5
  promotion records (`mas_challenger_promotions`). Rendered in the
  dashboard panel named above.
- **Controls**: `GET /api/screening/controls` reports the effective
  flag values with fail-safes applied; `POST` accepts any subset of
  `{rolloutStage, channelsEnabled, nlqFitDiscovery, weightsV2Ranking,
  scheduledPaused}`. An invalid stage is a 400. Every write records a
  `schedule_control` activity entry with the session as actor.
- **NLQ fit discovery**: through the existing NLQ options path
  ("what strategies fit AAPL?", "which names fit an iron condor?").
  Answers are drafts; strategies outside the servable catalog and
  symbols without live chain data are labeled with the reason, never
  silently substituted. Voice is conversational only — there is no
  push-to-voice transport, and delivery to `voice` fails with that
  explanation rather than pretending parity.
- **Recommendation bundles**: `POST /api/etrade/portfolio-risk/bundle`
  accepts one `candidate` or a `candidates[]` list. Persistence
  (`persist: true` → `mas_outcomes`) and delivery
  (`deliver: {channels, emailTo}`) are opt-in per request; the default
  response is the bare bundle, unchanged.
- **Goal-driven screens (C1, #1201)**: `POST /api/screening/goal-screen`
  runs a Phase 1 goal/scenario screen through the Phase 0 provider
  registry over the production engines — the ScreenersHub **Goal
  Screen** tab is the UI. Each run lands in the screener task ledger,
  the activity log, and a canonical `mas_reports` record (visible in
  Reports). A run that fails on every requested asset class answers
  502 with the labeled result in the body. The same screen is
  schedulable through the one schedule store: callback
  `autonomousGoalScreen`, criteria `{goalKind | scenarioId,
  direction?, symbols?, assetClasses?}` via
  `POST /api/schedules/create`; duplicate fires in a minute slot are
  suppressed by the ledger. `POST /api/screening/backtest` is
  backtest-on-screen over live Yahoo daily history (symbols without
  history are excluded with the reason, never fabricated).
- **Provider identity**: one source — `SCREENING_PROVIDER_DESCRIPTORS`
  in `src/trading/screeningProvider.ts`. The server registry is built
  under those ids and the client adapter derives its list from the
  table; there is no second list to edit.

## 5. Guardrails that stay on

- **Weights v2 in ranking** (`src/services/fitDiscoveryRunner.ts`):
  only with `screening.weightsV2Ranking=on`, only with weights the
  governed v2 job itself produced, and a weight can only re-order
  candidates *within* their evidence tier (Qualified / Watchlist /
  Unverified / Rejected) — it can never lift a negative worst-case
  scenario above a positive one. This is the #17 posture: learned
  weighting stays behind its guardrails and flags.
- **Deliveries are drafts**: every screening delivery carries the
  research-only footer, flows through the channels' existing
  machinery (Slack screener delivery, the email trading service's
  recipient validation, the HMAC-signed webhook service, which refuses
  unsigned dispatch when no secret is configured), and is recorded in
  the activity log. `docs/COMPLIANCE.md` governs: no auto-trading, no
  auto-sent trade instructions.

## 6. Rollout stages

Stages advance **manually, by an operator decision recorded here** —
never automatically, never by the system itself.

| Stage | Meaning | Current? |
| --- | --- | --- |
| `internal` | Surfaces live behind flags at their defaults; channels off; v2 ranking off. | **Yes — since #1162 (2026-10-23).** |
| `paper` | `screening.channelsEnabled=on` for paper/internal destinations; deliveries reviewed against the activity log for a full week of ticks. | No |
| `broader` | Channels to broader destinations; `screening.weightsV2Ranking` may be enabled after a reviewed weights-v2 cycle. | No |

To advance: set `screening.rolloutStage` via the controls, record the
date and the deciding operator in this table, and note it in the
activity log (the controls POST already does).

## 7. Promotion approvals (Phase 5 champion/challenger)

Learned changes never promote themselves:

1. A challenger (weights, active set, or ranking) is created against
   **frozen** evaluation datasets (`createChallenger`).
2. It is scored on those frozen sets only (`evaluateChallenger`) —
   evidence gathered any other way does not count.
3. Promotion requires an **approval record from an authorized human
   actor** (`recordChallengerApproval`); system actors cannot approve,
   and the champion cannot approve its own challenger.
4. `promoteChallenger` applies the change and writes the promotion
   record that appears in the activity feed.
5. Reversal: `resolveChallengerOutcome` / re-promoting the prior
   champion restores the previous state; weight changes are
   append-only in `mas_outcomes`, so the pre-promotion values remain
   reconstructible.

Strategy-bank re-selection proposals (`mas_strategy_bank_proposals`,
governance state `proposal_only_not_promoted`) become challengers
through this same flow — the tick never applies them directly.

## 8. Incident response and recovery

The Phase 5 recovery drills are the rehearsed versions of these
steps; run them in order.

1. **Bad autonomous output** (wrong proposals, noisy deliveries):
   pause (§3.1) and stop channels (§3.2). Proposals are inert until
   promoted, so pausing fully contains the blast radius.
2. **Bad weight adjustment**: the weights-v2 job is kill-switched
   (§3.3) and budget-capped per cycle; to roll back, promote the prior
   weight set back through §7 — adjustments are append-only, never
   edited in place.
3. **Bad promotion**: reverse via §7.5. The promotion record in the
   activity feed names the challenger, the approver, and the evidence.
4. **Missed or doubled ticks**: the durable markers (§1) make each job
   fire at most once per weekday; a failed 21:00 run retries on the
   next `*/30` fire because markers are written only after success
   (#354). To force a re-run, clear the job's marker key in
   `mas_settings` and wait for the next tick.
5. **Activity log gaps**: `recordScreeningActivity` is best-effort by
   design (it never fails the operation it records); the underlying
   records — `mas_goals`, `mas_outcomes`,
   `mas_strategy_bank_proposals`, `mas_challenger_promotions` — are
   the ground truth and the feed can be reconciled against them.

## 9. Rollback of this rollout

- **Soft rollback**: flags off (§3) — no deploy needed.
- **Hard rollback**: revert the Phase 6 PR. The schema is additive
  (`mas_screening_activity` is service-owned and idempotent; no
  existing table was altered), so a revert leaves prior phases fully
  functional. The NLQ action, the two screening routes, and the bundle
  route's opt-in fields all disappear with the revert; default bundle
  responses were never changed.

## 10. Known limitations

- Voice delivery is conversational-only (no push-to-voice transport
  exists); the delivery API says so explicitly per request.
- The bundle route assesses concentration for the primary candidate
  only; other candidates carry `maxMeasuredCorrelation: null` rather
  than borrowed evidence.
- Scheduled discovery runs without portfolio state (see §1).
- Some strategy-catalog ids remain not-constructible and some
  stock-leg compositions remain Unverified (Phases 2–3 limitations,
  unchanged).
- The Phase 5 evaluation dataset v2 is synthetic; treat v2-weight
  evidence accordingly until a live-data freeze replaces it.
- The screener-UI and scheduling-surface consolidation is tracked
  separately as epic #1151; this runbook covers the screening system
  as shipped under #1096.
