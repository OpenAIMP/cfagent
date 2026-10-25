# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release discipline

- **How to cut a release:** open a PR that moves the `## [Unreleased]` entries into a
  versioned `## [X.Y.Z] - YYYY-MM-DD` section. CI's *Test & Build* job
  (typecheck + vitest + build) is the required gate on every release PR.
- **Tagging and publication:** the `tag-release` job in `deploy.yml` tags every
  successful `main` deploy (`v0.1.<patch>`) and publishes the matching GitHub
  Release, whose body is this file's section for that version (falling back to
  `## [Unreleased]`) followed by the deploy's commit list. Tag by hand only to
  backfill a missed tag: `git tag -a vX.Y.Z <merge-sha> && git push origin vX.Y.Z`.
- **Semver rules:** MAJOR = breaking contract or API changes; MINOR = new
  capabilities, backward-compatible; PATCH = fixes with no contract change.

## [Unreleased]

### Added

- **NLQ fit rewire with real falsification evidence (#1256, parent #1151):** the NLQ strategy-direction fit path now runs through the kernel ranking path carrying genuine falsification evidence from the fit's own gate record (`buildFitFalsificationEvidence`) — evidenced fits keep qualified/watchlist status through falsify, evidence-less fits still demote, no placeholder evidence, no falsify exemption. #COO-spr9

- **IAAA #945 assurance review filed as a document (DRAFT, not adopted):** `docs/architecture/security/iaaa-945-assurance-review.md` — CISO assurance review of the #947 Phase 0 spec against epic #945 §§3–7: verdict is adopt subject to the §4 clarifications, not unconditionally; §2 assessment stale (frozen at main `975c3ed`); genesis/bootstrap, delegation cost budget, scoped re-delegation, and approval proposal-binding gaps named with required negative tests; provider recommendation Option A, fallback Option B, Option C not recommended. Filed in the repo per owner directive 2026-10-25; not posted to any issue. #CISO-bhdm

### Fixed

- **Options flow: no generated universe in PROD — all-sources-failing returns empty + explicit unavailable state (#925, parent #913 S7):** `getDynamicLiveFlowItems` step 6 returned the template-generated sample universe (`generateDynamicFlowUniverse`, stamped `generated`) whenever no chain data was available at all, so a PROD outage rendered invented flow numbers. The fallback is now demo-regime only: the generated universe is served only when the #65 demo gate is enabled AND the caller passes an explicit `dataMode: "demo"` (the same two-condition regime as calibrated chains — gate alone, or a demo request alone, still yields empty); every other all-sources-failing call returns `[]`, and the `/api/options/flows/live`, `/historical`, and `/summary` envelopes carry an explicit `dataUnavailable: true` + `unavailableReason` instead of substitute numbers (the route accepts `?dataMode=demo` and forwards it; `getDynamicFlowSummary` forwards it too). Chain-derived items still flow unchanged when a chain source succeeds (control pin), and modelled/derived items now carry an explicit `modelled` label: `FLOW_PROVENANCE_LABELS["chain-derived"]` is "Modelled chain-derived estimate" and the OptionsFlowsHub per-item badge reads "modelled · chain-derived" (the hub's empty state and the envelope's `isModelled` + notice already disclosed the modelled basis). Pins: new `tests/options_flow_925.test.ts` (11 tests: PROD failure → empty, gate-only → empty, demo-request-only → empty, demo regime → generated, chain-derived control, empty + demo-regime summaries, modelled label map, UI badge source pin, live + summary envelope unavailable pins; Red 8/11 before the fix, the 3 passes being the pre-existing unconditional-generated behaviour and the control). Two existing pins are updated in this PR per the pin rule because they asserted the forbidden fallback: `tests/options_flow_provenance.test.ts` GET /live (unknown ticker now expects empty + `dataUnavailable`) and `tests/options_flows.test.ts` FlowSummary (stubbed-failing Yahoo + no fixtures now expects an empty summary). #CISO-bhdm
- **Client DEFAULT_QUOTES removed — no hardcoded prices or invented unknown-symbol values (#924, parent #913 S6):** `src/client/options/StrategyDiscoveryPanel.tsx` served 14 hardcoded preset prices (SPY 586.20, NVDA 138.50, …) as initial state and as the quote-fetch failure fallback, and invented 250.0 for an unknown initial symbol and 5000.0/150.0 (futures/equity) on symbol select — each stamped `delayed: true`, so a stale-looking number was indistinguishable from a real quote. All of it is removed: the preset table is now symbols + names only (`POPULAR_SYMBOLS`, no price fields), the initial quote state is empty (never priced), and the quote cache holds live-fetched quotes only. Panel states are now loading → live quote → explicit error/unavailable: a failing fetch for a symbol with no live quote sets an explicit `Quote unavailable for <symbol>` state (badges, dropdown rows, and implied move all render "Quote unavailable", never a number); a failing refresh for a symbol with a previously live-fetched quote keeps that genuine last-live quote, flagged as a failed refresh. Consequences, fixed in this PR rather than papered over: the auto-discovery effect, schedule capture, strategy-library select, and fast-order preview all refused to run on a placeholder price — discovery now skips its run and reports unavailable with no quote, schedule capture and strategy select toast-and-return, and the trade preview requires a live quote; the target price starts unset (0) and is derived from the first live quote for a newly selected symbol, so later refreshes never override a user-set target. Out of scope, unchanged and routed elsewhere: the separate `POPULAR_TICKERS` price table in `src/client/components/StockSearchBar.tsx` and the `marketStream` baseline ticks belong to other #913 slices (notably S11 #929). Pins: new `tests/strategy_discovery_default_quotes_924.test.tsx` (7 tests: 4 source pins + failing-fetch, unknown-symbol, and live-quote control behaviour pins; Red 6/7 before the fix, control passing throughout). One existing pin is updated in this PR per the pin rule: `tests/discovery_schedule_capture.test.tsx` stubbed an empty quote payload with the comment "the panel keeps its default quote" — i.e. it depended on the forbidden preset fallback — so its quote stub now serves a realistic live quote (the unavailable path is pinned by the new test file instead). #CISO-bhdm
- **FOSS substrate is live-only — synthetic bars, invented profiles, and static fallbacks removed (#923, parent #913 S5):** `src/services/fossResearch.ts` served synthetic sine/random-walk bars (`generateHistoricalBars`) whenever a live Yahoo/Alpaca bar fetch failed, hash-invented full profiles (`getOrCreateProfile`: price, bid/ask, targets, analyst counts) for any unknown symbol, and static-table prices through every provider sync accessor, with the Yahoo live quote inventing bid/ask as price ± 0.05 when the payload carried none and backfilling PE/market-cap from the static table. All of it is removed: `generateHistoricalBars` and `getOrCreateProfile` are deleted, every async provider path throws an explicit "FOSS … unavailable" error on live-fetch failure (the service bars path tries the live providers in order and throws an aggregated unavailable error), every sync accessor throws the same explicit error (a sync path cannot fetch live data), the Yahoo live quote carries bid/ask only when the payload actually carries them (`FossQuote.bid/ask` are now optional; the hub renders "—" when absent and the Alpaca platform adapter maps absence to its existing 0 sentinel), and live Yahoo quotes no longer backfill PE/market-cap from the static table. The hybrid quote still serves a live price when fundamentals fail, but with valuation fields omitted, never backfilled. The bundled `FOSS_MARKET_UNIVERSE` table itself survives only as exported symbol metadata for other modules; no price/bar field in it is consumed in this file. Consequences, fixed in this PR rather than papered over: the sync NLQ research actions (fundamentals/snapshot/quote/compare/report) returned profile data, so they now return an explicit unavailable result (count 0, status "error", no rows, no numbers) — live FOSS data for NLQ flows through the async report path and the `/api/foss/*` routes; MCP command descriptions that advertised the fallback are rewritten to live-only; unconfigured Alpaca's provider status now reports mode `not_configured` instead of `simulated_engine`. Out of scope, unchanged and routed elsewhere: the static-table consumers outside this file (`betaService` static beta fallback, `correlationService` sector metadata, `marketStream` baseline ticks, `calibratedOptionChains` spot fallback) belong to other #913 slices. Pins: new `tests/foss_substrate_live_only_p923.test.ts` (21 tests, Red 20/21 before the fix); `tests/foss_provenance.test.ts` and `tests/foss_research.test.ts` fallback pins rewritten to rejection/unavailable pins in this PR; three further suites that passed only via the fallback are updated in this PR: `tests/yahoo_quote_cache.test.ts` (the "never caches the deterministic fallback" pin becomes "failed quotes reject and are never cached"), `tests/agentic_payments.test.ts` (the paid market-research success path now stubs realistic live Yahoo chart + quoteSummary payloads instead of relying on fallback profiles), and `tests/consolidation_c1_execution_path.test.ts` (the backtest chart stub now serves realistic live payloads for the platform verification conformance kit — quote, bars, and fundamentals — since a meta-less stub now correctly fails verification and degrades history to zero trades). #CISO-bhdm
- **Sync E*TRADE quote paths no longer serve a curated static price in the live env (#922, parent #913 S4):** `ETradeService.getQuote` (sync) and `ETradeTradingPlatform.getQuote` served the curated universe table's `defaultPrice` (e.g. JPM 222) stamped `STATIC_FALLBACK` with a fresh timestamp whenever the symbol missed the screener universe — an honestly labeled but still static substitution, which the #913 directive prohibits regardless of label. In the live environment both paths now fail explicit with an "E*TRADE live quote unavailable" error and serve no substitute numbers; previews and sync NLQ orders priced off such a quote fail at the quote step instead of drafting. Non-live (sandbox/test) behavior is unchanged — the curated path still serves the labeled `SIMULATED_LEVEL1` quote — and the cached-screener-universe provenance (#118) is untouched. Blast-radius consequence, fixed in this PR rather than papered over: the TradingView webhook handler drafted MARKET orders through the sync preview path, so a live-env alert for a curated-only symbol now threw uncaught instead of drafting off the static price — `processTradingViewAlert` now converts a preview failure into its structured 502 failure response (no draft, explicit message). Pins in `tests/etrade_quote_provenance.test.ts` updated in this PR; the sync relative-order refusal pin in `tests/nlq_relative_pricing_provenance.test.ts` is updated to the fail-explicit form (still no draft); the TradingView replay pins in `tests/webhook_replay_ssrf.test.ts` now assert the live-env 502 plus a sandbox-env draft-success case; the TWAP honesty pins in `tests/mcp_twap_preview_honesty.test.ts` now run in an explicit sandbox context with a real ORM (they pin preview honesty, not live pricing). #CISO-bhdm
- **Dependabot CI workflow run volume reduction:** assessed the root causes of high Dependabot Action run volume (automatic branch updates triggered on every `main` commit via `auto-update-prs.yml`, default Dependabot auto-rebase, missing `open-pull-requests-limit`, and un-grouped major / actions updates). In alignment with the repository's reference-only posture for Dependabot (`docs/plans/rsi-infosec-plan-2026-10-20.md`), `.github/workflows/auto-update-prs.yml` now skips Dependabot PRs so pushes to `main` no longer re-trigger 9 CI jobs per open reference-only Dependabot PR. In addition, `.github/dependabot.yml` is optimized with `open-pull-requests-limit: 1`, `rebase-strategy: "disabled"`, and wildcard grouping (`patterns: ["*"]`) for both `npm` and `github-actions` ecosystems. Pinned by `tests/auto_update_prs_workflow.test.ts` and `tests/dependabot_config.test.ts`.

- **Best Trade v2 bundle panel: Build button no longer silently dead (#1205):** the Recommendation Bundle section of the Portfolio Risk panel shipped (#1135) with a candidate textarea whose placeholder is a JSON skeleton full of literal `…` characters — it looks like pre-filled input but is not a value — and a Build button disabled on the empty box with no explanation anywhere, so a user who filled beta and clicked got literally nothing. The section now states its state next to the box: empty → a hint naming the skeleton as a placeholder (not input), why Build is disabled, and the next step; invalid → the parse/validation problem rendered adjacent to the textarea, with Build disabled until the text parses as a candidate. A new **Insert example candidate** action loads a real, parseable, minimal `StrategyCandidate` (mirroring the Phase 4 fixtures) that passes `parseBundleCandidate`, the bundle route's `normalizeBundleCandidates`, and an end-to-end `buildRecommendationBundle` in tests. Success path and API contract unchanged; the systemic fix (candidates flowing from screen/discovery results, no paste box) remains #1151 slice C5. Pins in `tests/portfolio_risk_panel.test.ts` + `tests/portfolio_risk_bundle_panel.test.tsx`. #COO-spr9

- **Demo holdings seeder is unreachable from live accounts (#921, parent #913 S3):** the E*TRADE Trading Hub's "Load Demo Holdings" / "Load Curated Demo Positions" buttons rendered unconditionally, so a user on a live/PROD account could seed hardcoded positions (NVDA/AAPL/MSFT/SPY at invented prices) and a fake paper account into the live brokerage view. Both buttons are now render-gated on `!isLive`, and `handleSeedDemoPortfolio` itself refuses when live (defense in depth). Sandbox/TEST behavior is unchanged. Pins in `tests/demo_seeder_live_gate.test.ts`; the portfolio render pin that asserted the affordance in the (default-PROD) render is updated in this PR. #CISO-bhdm
- **NLQ relative orders price only off a live E*TRADE quote (#920, parent #913 S2):** `extractOrderParameters` derived the limit price for "% below/above market" orders from the static curated universe's `defaultPrice` — an unlabeled static price on a production order path. The parser now records only the offset; both NLQ execution paths (sync + async) refuse a relative-priced order with an explicit error and create no draft unless the E*TRADE quote is live (`quoteStatus` not a non-live pricing status and a real last price present), in which case the limit derives from that live quote. MARKET and explicit-dollar-limit previews keep the existing #118 non-live disclosure behavior. Pins in `tests/nlq_relative_pricing_provenance.test.ts`; the parser pin in `tests/nlq.test.ts` updated in this PR. #CISO-bhdm
- **Yahoo screener no longer fabricates quotes (#916, parent #913 S1):** `YFinanceMarketScreener.getQuote` returned an invented $100.00 quote (bid 99.9 / ask 100.1 / volume 1,000,000, 52-week 120/80) stamped `source: "Yahoo Finance FOSS Engine"` whenever the live Yahoo fetch failed, and the success path invented fields (52-week range = day high ×1.25 / day low ×0.75, `peRatio` default 25.0, market-cap default 10.0, RSI default 50). The fabricated quote block is removed: a failed or non-live lookup now throws an explicit "Quote data unavailable" error; the screener only accepts provider quotes with `provenance: "live"` (the FOSS provider's static/generated sync fallback is rejected at this seam, never re-stamped as live Yahoo data); success-path fields pass through only values the provider actually returned (`ETradeQuote.week52High/week52Low` are now optional — unknown means absent, never computed from the day's range); RSI-bound screen filters reject with "RSI-14 unavailable" instead of assuming 50. Pins in `tests/yfinance_quote_provenance.test.ts` (behavioral + source). #CISO-bhdm

### Added

- **Trading approvals queue (#1327, program #1323):** the Trading hub's order tab now opens with a pending-approvals queue: proposed orders from the existing orders endpoint (previewed drafts only) with proposer, price/total, and a live 15-minute countdown derived from the preview flow's own HITL timer. Approve opens a confirm dialog with the exact order details and executes through the existing approval door; reject closes the proposal through the same door. Expired rows disable Approve and the server refuses execution on any non-previewed draft, so expired proposals cannot execute. No new backend route. #cpo-dhmp
- **Repo-side enforcement: policy gate + main audit so gitops cannot be bypassed (#1487):** new `.github/workflows/policy-gate.yml` (required check, job "Policy Gate") fails a PR missing any of a linked issue, a §21 lane label, an agent hashtag, or a CHANGELOG entry under `## [Unreleased]`; new `.github/workflows/main-audit.yml` (daily + workflow_dispatch) checks every new main commit is reachable from a merged PR and, on a direct-push commit, files an `[audit] Direct push to main detected` issue and fails — read-only except for that filing; new `.github/CODEOWNERS` requiring owner review for `.github/workflows/*`, `docs/agents/gitops.md`, and `AGENTS.md`; and a new gitops §22 enforcement section. Correction of record, verified live 2026-10-25: Jules did NOT push directly to main — the six cited Jules commits landed via merged PRs (#1006, #1021, #1028, #1061, #1137), each with zero labels and no agent hashtag, #1137 with zero issue refs — so the gap closed here is missing gates and shared-account attribution, not a direct push. No .gitleaks changes, no Jules access changes, no branch-protection or repo merge-method setting changes in this PR (owner-side). #CISO-bhdm
- **Morning digest of overnight runs (#1328, program #1323):** ScreenersHub now opens with a morning digest over the overnight window (18:00 previous day → 09:00 today, viewer-local; in progress before 09:00): what ran, what was partial with its qualification stamp, what failed with coded errors, what is held for review, and per-run PDF/XLSX artifacts. Every run entry links to its run detail (#1326 RunDetailView) and held items link to the pending-review queue (#1324). No new backend route: runs come from the feed rows already loaded and held items from the existing pending-confirmations endpoint. #cpo-dhmp
- **Engine rationalization design record (#1261):** new `docs/architecture/recommendation-engine-rationalization.md` lands the design of record for epic #1151's engine rationalization — the grep-verified inventory of the discovery / recommendation / repair / hedge / bundle engines on main (≈17 engine modules: three discovery stacks, three quant rankers + LLM annotation overlay + bundle-internal CVaR optimizer, two live weight systems, two promotion pipelines — one dormant, two repair levels, one hedge engine, one bundle god-module) and the pattern-oriented target architecture (GoF/GRASP/SOLID): one Recommendation Kernel — Facade (`RecommendationService`) over a Template Method pipeline, gates as Chain of Responsibility over one candidate contract, Composite leg-graph as the structure representation, Strategy policies for candidate builders and ranking (weights and LLM-compare as Decorators, annotate-never-reorder), BundleBuilder with `CvarOptimizer` extracted, Abstract Factory per asset class behind the provider seams; survivors named per family (researchPipeline-hosted discovery generalized; v2 weights + championChallenger governance behind the live `/adaptation/*` routes; `hedgeProposals` as sole HedgePolicy). Carries the owner correction of record: `llmIdeas` is a permanent, first-class LLM candidate-generation path (quant vs LLM paradigms) — never deprecated — rationalized as the kernel's `LlmIdeaBuilder` CandidateBuilder under the same gates/pricing/falsification as the quant builders. Also records the owner's 3-way comparison design (§4 of the document): `llm` / `quant` / `hybrid` end-to-end arms over one snapshot — differing only in generator×scorer — with per-arm attrition reported and per-arm outcomes in the ledger, no winner by assertion (epic comment 6376168666). Implementation tracked as #1256 (discovery, C4 core) and #1257 (recommendation family, C4/C5 window); the document was first posted as epic #1151 comment 6375867524 with the correction in comment 6376050382. Status snapshot dated 2026-10-23. #COO-spr9
- **System overview document (#1230):** new `docs/architecture/business/system-overview.md` records what the screening program is building — the #1096 capability layer (closed), the #1151 consolidation (in execution), and the reliability lanes (#1204; #1173/#1200) — how it integrates with the existing systems (research agent/pipeline, ScreenersHub + Runs API, `mas_reports`, channel transports), which competencies it enables, and how the user uses each capability to solve their problems, stated per service as verified-on-main vs target. Also records the channels×capabilities delivery matrix (what is delivered on web/chat/Slack/email/signed-webhook/voice, manual vs automated, with the #1209 delivery impairments stated plainly), the stage-layered scheduling verdict (feed→generate→store→serve→deliver cannot be scheduled per-stage today — the stages are fused inside the run and the one completion-chained follow-up has no per-stage timing; the enablement is tracked as #1236 under #1151, implementation home C3+C4), and alignment with the platform A2A agent card (orchestrator/search/payments/tasks/memory/trading — this program is the trading competency's screening engine; payments is not used, only its budget-guard pattern). Includes the correction of record on strategy discovery: the options Discovery panel is a thin client of the server `OptionsAgentPipeline` (#29 — "pure display layer"), the remaining local engine is the Builder's modeling layer by design, and the real duplication is server-vs-server (panel pipeline vs the #1096 research-discovery mode, reached via NLQ only); converging them is an open decision owned by #1151 C2/C4. Status snapshot dated 2026-10-23. #COO-spr9
- **Consolidation C2 — one nav entry, one hub (#1246, parent #1151):** the five screening-adjacent navigation entries collapse to ONE — **Screening** — leading to the one ScreenersHub for stock + options screening. The Trading Hub's S8 "Screening Moved" redirect stubs are retired: its scanner/options/iv-history/reports/schedules subtabs render the hub directly on the equivalent tab, and Reports + Schedules move INTO the hub as tabs (legacy tab ids still deep-link and read as active on the one entry). The hub gains two tabs that surface what #1096 built but users could not reach: a **Review** inbox — champion/challenger adaptation candidates driven through the EXISTING governed endpoints (evaluate / gate / approve / decide, plus two new read routes for the approval and gate-verdict records those endpoints already wrote), proposed goals with activate/dismiss decisions (`POST /api/screening/goals/decide` — proposed-only until a person decides; dismiss archives, nothing deletes), read-only strategy-bank re-selection proposals, and the strategy-weights summary — and a **Track Record** tab over the outcomeTracking ledger (`GET /api/screening/outcomes`): per-recommendation outcomes with honest states (Unverified stays Unverified, unknown P&L renders "Not recorded"), deliberately distinct from the #340 research track record, whose store is untouched. The Options Research panel's schedules mode now switches in-hub to the Schedules tab instead of pointing elsewhere, and the options-data exporter fold completes the S6 convergence: `optionsDataExporter.tsx` is deleted, its fetch/build/download functions live in `runExport.ts` (the one client exporter), and only its dropdown component remains (`options/OptionsDataDownloadDropdown.tsx`). Server governance is unchanged — the inbox is UI over the existing endpoints, no self-promotion path was added, and discovery engines are NOT rewired (the #29-vs-#1096 convergence is the C4 decision; a modeling-only import allowlist pins StrategyDiscoveryPanel's local-engine imports). Pins in `tests/consolidation_c2_hub.test.tsx` + `tests/consolidation_c2_routes.test.ts`; the S8 redirect/nav pins and the route-inventory pin are updated in this PR per the pin rule. #COO-spr9
- **Consolidation C1 — the unified screening stack is reachable, and there is one provider registry (#1201, parent #1151):** the #1096 goal-driven screen and backtest-on-screen had no production caller (only tests imported them), and the provider registry existed twice (server `screeningProvider.ts` vs the client's hand-mirrored `screeningAdapters.ts`). Now: `POST /api/screening/goal-screen` runs a Phase 1 goal/scenario screen through the Phase 0 ScreeningProvider registry over production engines (live listing-feed stock engine — the NLQ/MCP path — plus the dynamic options screener) under the screener task ledger, records a canonical `mas_reports` report + screening activity entry, and delivers over the Phase 6 channels on request; the ScreenersHub gains a **Goal Screen** tab (status incl. labeled PARTIAL with failed classes/reasons, hits with provider provenance, in-place backtest of the stock hits); goal screens are schedulable via the new `autonomousGoalScreen` callback in the one schedule store (schema-validated payloads, ledger-suppressed duplicates); the options screen + strategy-recommend routes execute through the Phase 0 options provider; and the client adapter is **derived** from the server registry's new descriptor table (`SCREENING_PROVIDER_DESCRIPTORS`) — one source, drift-pinned. Raw-filter hub/scheduled stock screens keep executing through the ScreenerAgent pipeline (the provider contract cannot carry its richer run record — decision recorded on #1201). Pins in `tests/consolidation_c1_execution_path.test.ts` + `tests/consolidation_c1_goal_screen_panel.test.tsx`; route inventory updated in the same PR. #COO-spr9
- **CI shard split keeps the required gate reporting (#1146, PR #1134):** `.github/workflows/ci.yml` now runs typecheck+build in a `fast-gates` job and the suite in four `--shard=n/4` test jobs, and adds a `test-and-verify` aggregator that re-publishes the check name the `protectmain` ruleset requires — `Test & Build (Node 22) [PROD]`. The aggregator needs `fast-gates` + `test-shard` and runs on `if: always()`, so a failed gate reports red instead of vanishing (a skipped required check can be treated as acceptable). Without it the shard split would have removed the only job emitting that name, leaving every PR on `main` blocked at "Expected". No test content changed: `test:ci` is `vitest run --reporter=verbose`, so the shards run the same suite with the same reporter and no coverage loss. #autoclaw
- **Epic #1096 Phase 6 Channels & rollout — the screening system goes live behind flags (#1162):** channel parity for discovery results, goal screens, and recommendation bundles over the system's existing transports — Slack via `screenerSlackDelivery`, email via the E*TRADE email service with recipient validation, signed webhook via `ETradeWebhookService` (which refuses unsigned dispatch) — through new `src/services/screeningDelivery.ts`; every delivery is a draft carrying the research-only footer, per-channel failures never block other channels, and there is no push-to-voice transport, so `voice` fails with that explanation instead of pretending parity. NLQ phrases for Phase 2 discovery land on the existing NLQ options path as the `options_fit_discovery` action ("what strategies fit AAPL?", "which names fit an iron condor?") executed by new `src/services/fitDiscoveryRunner.ts` over the research provider + `researchDiscovery` mode; unservable phrases (unknown symbol, unrecognized strategy, runner disabled) fail explicitly, and the runner is also the guarded production consumer for Phase 5 v2 weights — only behind `screening.weightsV2Ranking`, only within a candidate's evidence tier, never lifting a negative worst-case scenario above a positive one (the #17 posture). Production wiring: the scheduled tick now runs Phase 3 strategy-bank re-selection and the Phase 5 weights-v2 job (own #354-idiom guard and durable marker; no new cron trigger), and the bundle route accepts `candidates[]`, opt-in `persist: true` into `mas_outcomes`, and opt-in delivery, with the default response unchanged. New `src/services/screeningFlags.ts` (mas_settings idiom: rollout stage internal/paper/broader, channels, v2 ranking, NLQ discovery, and a fail-closed scheduled pause) and `src/services/screeningActivity.ts` (`mas_screening_activity` merged with re-selection proposals and challenger promotions) back `GET /api/screening/activity` and `GET|POST /api/screening/controls` (route-inventory pin updated) and a Screening Activity section in the Options Research schedules view with the pause toggle. `researchTrackRecord` ideas now carry their producing run's recorded regime and contract counts so the Phase 5 builders get real per-idea inputs. Operator runbook at `docs/SCREENING_SYSTEM_RUNBOOK.md`; rollout stage recorded there as **internal**, advanced manually only. Pins in `tests/phase6_channels_rollout.test.ts`. #COO-spr9
- **Epic #1096 Phase 4 Portfolio optimizer + Recommender v2 — every recommendation a bundle (#1135):** new `src/services/recommendationBundle.ts` extends the RecommendationAgent Best Trade pick into a Recommendation Bundle that is never a bare trade: the trade priced from first principles by `researchEconomics` and evaluated on the Phase 1 scenario grid; a `researchFalsification` record plus pre-mortem as required evidence (a bundle without one cannot be Qualified and is capped at LOW confidence; the #534 no-view caps — never "recommended", never HIGH — survive into the bundle); post-trade portfolio state composed through the #34 `evaluatePostTradeTotals` path; an optimizer that sizes through #36 `sizeCandidateAgainstPortfolio`, scores the scenario grid (expected P/L penalized by CVaR-25), states budget breaches at the desired size, and issues an improves/worsens/neutral verdict with evidence including the #35 concentration/correlation assessment — and can decide **no trade** when no candidate beats doing nothing; a hedging plan on a stated budget breach built by #54 `buildHedgeProposals` on the post-trade totals and ranked by cost per dollar of beta-weighted delta removed; and a repair plan ranking #355 ratio repairs (carrying their `noDownsideProtection` honesty verbatim; risk-removed unmeasurable there, so cost-first ranking with the limitation stated) alongside Phase 2 composition repair/roll candidates ranked by risk removed minus cost. Stock-leg candidates are Unverified (options-only pricing core) and cannot be Qualified. Surfaced via `POST /api/etrade/portfolio-risk/bundle` (route-inventory pin updated), a Best Trade v2 section in `PortfolioRiskPanel`, a deterministic report formatter for the mas_reports seam, and persistence as paper records in the existing `mas_outcomes` store (no new table; Phase 5 owns outcome tracking). The SPY-put expiry/chain resolution is extracted from `hedgeProposals.generateHedgeProposals` into `resolveSpyPutContract` so the bundle route reuses the single owner. Draft-only, `humanApprovalRequired` always true. Pins in `tests/phase4_recommender_v2.test.ts`. #COO-spr9
- **Epic #1096 Phase 3 Screeners v2 — goal/scenario-driven screens, nightly strategy-bank re-selection, backtest-on-screen (#1122):** new `src/services/goalDrivenScreen.ts` turns a Phase 1 scenario into a screen plan (goal outlook, the taxonomy's gate-admissible structures, filters derived from the scenario's own constraints — DTE window, liquidity floor, spread cap — with caller base filters winning per-field) and runs stock + options screens through the Phase 0 `ScreeningProvider` registry only; one asset class failing is a qualified partial (screenerEvents contract — other class's hits plus the failed class and its reason), both failing is a failure, and zero hits is a legitimate complete. Goal-driven runs adopt the screener task ledger (#607) for durability: idempotent by run key (duplicate delivery returns the existing record and never re-executes), heartbeat, the ledger's deterministic evaluation, and total failure ending escalated for a human. Phase 1 discovery is wired into the research agent (#319) as a run type: a `run_goal_discovery` tool and `runDiscovery`/`runDiscoveryIfDue` methods run the Phase 1 engine over the agent's own provider seam and persist proposals proposed-only (the scheduled path is guard-gated by the #354 idiom with an agent-local marker on the existing every-30-minutes tick — no new cron trigger — and is invoked best-effort from the scheduled-tick route; an absent portfolio skips portfolio triggers with the limitation recorded rather than assumed healthy, a Phase 3 change to `goalScenarioEngine.runGoalScenarioDiscovery`). New `src/services/strategyBankReselection.ts` is the Holly pattern hardened: a pure per-regime re-selection over `researchTrackRecord` evidence joined to run regimes plus current `strategyWeights` values, under a hard per-run cost cap (#495 pattern — strategies past the cap are logged not-evaluated, never dropped), recording an append-only per-tenant transparency log (`mas_strategy_bank_proposals`) that includes losers with their metrics and reasons; governance is explicit — re-selection proposes/records only, never writes strategy weights (source- and behavior-pinned), because promotion stays with Phase 5 champion/challenger — and its schedule guard follows the `researchScheduleGuard` idiom under its own durable marker. New `src/services/screenBacktest.ts` backtests any screen result walk-forward at portfolio level: contiguous folds, equal capital split across traded candidates, options repriced only by `researchEconomics.valueAtHorizon` (no second pricing engine; source-pinned), round-trip costs netted from the research config fee/slippage snapshot, and every result labeled with its data provenance (live/static/generated) and explicit limitations (constant-IV repricing, close-price fills, per-contract cost model); candidates with insufficient history in a fold are excluded with reasons, never fabricated. Pins in `tests/phase3_screeners_v2.test.ts`. #COO-spr9
- **Epic #1096 Phase 2 Name↔Strategy discovery + strategy composition algebra (#1114):** new `src/services/strategyComposition.ts` — a leg-graph model over the strategy catalog (legs, signed ratios, expiries, stock legs; identical contracts consolidate and zero-net legs drop) with composition operators overlay (wings on uncovered shorts → condor-wrapped strangle), combine (condor + butterfly), transform (straddle → strangle; any structure → defined-risk), repair (losing vertical → butterfly; refuses a non-losing position), and roll (next expiry / strike shift); defined-risk is computed from tail slopes (net short call tail or short stock = undefined-risk), is the default posture, and undefined-risk compositions are rejected unless explicitly enabled (then capped at Watchlist). Composed candidates pass the same quant gate as catalog strategies: priced only by `researchEconomics.ts` (new `composedStructureEconomics` export of its existing numerical grid — no second pricing engine) and admitted only by the real `researchGates.ts` stage gates, with leg-cap, per-leg liquidity (inside the gates), margin (= contractual max loss when defined-risk), and assignment-risk reporting; stock-leg compositions are represented and risk-analyzed but reported Unverified rather than priced, since the researchEconomics grid is options-only. New `src/services/researchDiscovery.ts` hosts bidirectional discovery as a researchPipeline mode over the pipeline's own provider seam and structure builder (helpers exported from `researchPipeline.ts` for reuse, not duplicated): Name→Strategies enumerates the full catalog registry (admissible / not-constructible / inadmissible all recorded) plus composed candidates, priced, gated, and ranked by the Phase 1 scenario grid (`goalScenarioEngine.evaluateScenarioGrid`); Strategy→Names ranks a universe by a fit score with named components (liquidity, IV fit, term-structure fit, earnings distance, portfolio correlation from caller-supplied `correlationService` estimates, strategy-on-name/regime record from `researchTrackRecord`) where a missing component is reported absent and excluded — never fabricated — and only live chains can yield Qualified candidates (calibrated caps at Watchlist, inside the real gates). NLQ phrases for the research discovery mode have no clean seam in this phase (the NLQ options path is the trading-side discovery service, #14/#23) and are deferred to Phase 6 channel work per the issue's outcome 3. Pins in `tests/phase2_discovery_composition.test.ts`. #COO-spr9
- **Epic #1096 Phase 1 Scenario/Goal engine (#1107):** new `src/services/goalScenarioEngine.ts` — a 9-kind goal taxonomy mapped gate-true to research outlooks and structure families (admissibility computed with `researchGates.ts`' own `structureFamily()` and pinned against the real thesis-coherence gate); a scenario builder producing typed price × IV × time shock grids + constraints with the effective `ResearchConfig` snapshot embedded (the `researchConfig.ts` snapshot idiom), persisted through the Phase 0 `mas_scenarios` store; a scenario grid evaluator priced exclusively by `researchEconomics.ts` `valueAtHorizon` (no second pricing engine — source-pinned) with worst/best cells and constraint verdicts (max loss, budget, DTE window, liquidity floor) that distinguish breach from not-evaluable; and deterministic auto-discovery (portfolio concentration/unhedged-delta/expiring-leg/losing-position triggers, regime triggers, event triggers, plain-language intent mapping) hosted as a research-pipeline mode over the existing `ResearchDataProvider` seam. Discovered goals persist only as `source: "discovered"` / `status: "proposed"` for user confirmation — discovery never activates a goal or emits a trade — and the missing catalyst feed is flagged per symbol following the `researchProviders.ts` pattern, never fabricated. Pins in `tests/phase1_goal_scenario_engine.test.ts`. #COO-spr9
- **Epic #1096 Phase 0 foundations (#1098):** unified server-side `ScreeningProvider` contract + registry (`src/trading/screeningProvider.ts`) wrapping — not rewriting — the E*TRADE/Yahoo stock screener (`IMarketScreener`) and `DynamicOptionsScreener`, with explicit typed failure for unregistered asset classes (no silent provenance-mislabeling fallback); and a tenant-scoped DO SQLite store (`src/services/goalScenarioStore.ts`) creating `mas_goals`, `mas_scenarios`, and `mas_outcomes` following the existing `mas_*` service-DDL pattern and the #584 `user_login` tenant-scoping precedent, with cross-tenant isolation and no-orphan attachment rules. Schema + CRUD only; goal/scenario evaluation is Phase 1. Per the epic §1.1 research-reuse amendment, this phase builds no parallel discovery subsystem: the provider contract is the screening seam behind which `researchProviders.ts` remains the discovery data fabric, goal/scenario payloads follow the `researchConfig.ts` snapshot idiom, and `mas_outcomes` is seeded from the `researchTrackRecord.ts` (#340) model. Pins in `tests/phase0_screening_provider.test.ts` and `tests/phase0_goal_scenario_store.test.ts`. #COO-spr9
- **Repo policy enabled + agent attribution rule (#859):** owner direction (2026-10-20) — every agent puts their name as a hashtag on each issue/PR — is now written into `docs/agents/gitops.md` §5/§9 as a required `## Agent` field in both templates, and the policy is made reachable: a new root `AGENTS.md` points every arriving agent at gitops.md with the headline rules, `.github/copilot-instructions.md` carries the same pointer, and new `.github/pull_request_template.md` + `.github/ISSUE_TEMPLATE/task.md` make the field structural in GitHub's UI. The enabling issue, PR, and completion report are the first artifacts carrying an agent hashtag (#CAIO-quns). The hard enforcement layer (CI check + branch protection) remains with #745. Docs/config only.
- **RSI-InfoSec plan records the Dependabot posture (#764):** the plan document now states the owner's reference-only directive (2026-10-20) — Dependabot alerts and PRs are never merged in either repo; they are a visibility/triage signal only, and a wanted bump is re-implemented as a lane-authored PR. The plan's #765 config is documented as a visibility configuration and #766's bridge as filing code-scanning alerts only. Docs-only; no runtime change.
- **Security findings join the self-heal loop (#766):** the new *Security Findings Watch* workflow sweeps the repo's security alerts — after every CodeQL run, every 6 hours, and on demand — and files one deduped `[SecOps self-heal]` issue per open alert into the fixer queue (`self-heal` + `security` labels, alert link/severity/location in the body), auto-closing the issue when its alert is fixed or dismissed. Code-scanning alerts are the primary source (readable by the workflow token); secret-scanning and Dependabot alert lists are attempted each run and their token limitation is logged explicitly rather than silently skipped, pending a read-capable token. Part of the RSI-InfoSec plan (#764, P1).
- **SAST + dependency automation (#765):** CodeQL (`javascript-typescript`) now analyzes every PR, every push to main, and weekly, publishing to code scanning — the repo previously had secret scanning only. `.github/dependabot.yml` gives Dependabot a defined policy (npm weekly with minor/patch grouped, GitHub Actions monthly, `dependencies` label); security updates continue to arrive as their own PRs. All Dependabot/CodeQL output flows through the standard merge gate — no auto-merge. First-run CodeQL findings, if any, are triaged as the baseline for the #766 findings bridge. Part of the RSI-InfoSec plan (#764, P1).
- **RSI-InfoSec plan published (#764):** `plans/rsi-infosec-plan-2026-10-20.md` prioritizes every information-security issue (AppSecOps, DataSecOps, AISecOps, MLSecOps, AgentSecOps, DevSecOps, identity) by recursive leverage in dependency order — P0 audit & enforcement integrity (#700 residual: scanner `persistAudit` audit writes silently never persist, verified on main; #143/#237 tracker reconciliation; #290 compliance remainder), P1 closing the detection loop (new #765 CodeQL SAST + Dependabot config, new #766 security-findings → self-heal bridge), P1 AISecOps (new #767 prompt-injection defense + red-team eval set; #237 judge evals), P1 AgentSecOps (#754 bounded adaptation, #755 budgets + audit trail, #756 kill-switch verification, #759 promotion gate, #760 staged rollback — the #752 stack), P2 DataSecOps (#415/#605/#606 KV migration, #338 storage split, retention, new #768 secrets inventory + rotation), P2 conformance (#488), P3 MLSecOps (new #769 model/prompt version pins + eval gates, gated on the P1 eval substrate), with a user offering paired to every stage and four owner decisions named (branch protection, COMPLIANCE.md questions, `mcp_config.json` classification, #623 verdicts). Docs only.
- **RSI-AI plan published (#752):** `plans/rsi-ai-plan-2026-10-20.md` prioritizes every AI/ASI/AGI-related issue by recursive leverage in dependency order — P0 measurement integrity (#17 calibration + learned-weighting experiment, #654 dashboard, #488 scorecard), P1 closing the remember→reflect→review loop (#16, #18, and new #753 wiring reflection output into the #653 review queue), P2 bounded adaptation (#158, new #754 weight adjustment within #79 bounds, #755 adaptation budgets + audit trail, #756 kill-switch verification), P3 governed self-modification (new #757–#760: candidate generation, isolated paper evaluation, held-out significance + human-review gate, staged promotion with automatic rollback — gated on P2 producing data), P4 meta-improvement (no issues yet, by design), with the engineering self-heal loop (#219/#231, #745) in parallel and a user offering paired to every stage. The eight gap issues (#753–#760) were filed from the plan; the plan is linked from #232 and #571. Docs only.

### Changed

- **Plans moved into the docs folder (#870):** the top-level `plans/` tree — the RSI plan family (AI #752, InfoSec #764, data, tech, product), the readiness audits, the architecture audit, and the `UX/` baseline subtree, 13 files in all — now lives at `docs/plans/` with its structure preserved; cross-references inside the plans point at the new paths, and root `AGENTS.md` now points arriving agents at the `docs/` folder (policy in `docs/agents/`, plans in `docs/plans/`). Earlier entries in this changelog keep the `plans/` paths as published at the time. Docs only.

### Security

- **Edited trade proposals cannot settle under an old approval (#1393):** `settleTradingOrder` bound settlements by orderId only and the E*TRADE platform re-read the CURRENT draft terms at settle time, so a previewed proposal edited after approval settled on the edited terms. Settle callers can now carry the approval's frozen terms (`ExpectedTradeTerms`: symbol, action, quantity, price, totalValue) through the settle core and the durable approval workflow's decision event; the E*TRADE platform refuses an approved execution whose current draft terms differ, before any status mutation or broker reference, while rejections and term-matching settlements flow unchanged. The binding is opt-in per call site — callers that do not supply terms keep orderId-only behaviour. Pins in `tests/delegated_authority_email_trade_approval.test.ts` (including email invariant-4 regression pins: unmapped-sender and injected APPROVE refusals, forwarded-link refusal, and the unedited signed-link control, all already Green on the merged #1262 surface). #CISO-bhdm
- **Exact-hostname E*TRADE URL checks (#843–#847, PR #891):** CodeQL `js/incomplete-url-substring-sanitization` — all E*TRADE endpoint checks in `src/config/environment.ts` used substring matching (`includes`/`startsWith`), so lookalike hosts (`api.etrade.com.evil.com`), query-string smuggling (`evil.com/?x=apisb.etrade.com`), and userinfo tricks could bypass environment gating. Replaced with exact hostname comparison via new exported `urlHostname`/`isETradeHost` helpers (dot-anchored subdomains allowed); pins in `tests/config_environment_hostname.test.ts`. The #766 bridge auto-closed the filed findings once CodeQL confirmed them fixed. (Entry recorded by payrepo as the merge-pass follow-up — PR #891 landed without one.)
- **Red-team eval set for the email→NLQ injection defense (#767 slice C / #863):** versioned fixtures under `evaluations/injection/v1/` (manifest + 9 cases: instruction override, system-prompt exfiltration, secret exfiltration, tool-call smuggling, cross-tenant baiting, delimiter escape, authority claim, 2 benign controls), executed in CI by `tests/nlq_injection_evalset.test.ts` against the production #862 prompt assembly. Per case: delimiter containment, exactly one real END delimiter, the legitimate request preserved as data, the rule present in the system prompt, and a negative control proving the undefended assembly fails. Bite-proofed: removing the assembly's marker-defusing step fails the delimiter-escape case. Model-behavior grading stays a separate non-CI evaluation (manifest notes).
- **Prompt-injection defense on the email→NLQ path (#767 slice B / #862):** inbound email (any internet sender) reaches the NLQ planner as raw subject+body. The email entry now flags its `executeNaturalLanguageQuery` call `untrustedContent`; the flag threads to the planner (`planWithLLM`, both the structured-output and text-fallback call sites) and the plan validator, which append a data-is-not-instructions system rule and wrap the content in `<<<UNTRUSTED_EMAIL_CONTENT>>>` delimiters — embedded end-markers are defused so content cannot escape the delimited region. Trusted chat/MCP assembly is byte-identical (flag unset). THREAT_MODEL §7 path 1 updated to record the shipped defense; pins in `tests/nlq_untrusted_content.test.ts` (assembly behavior + wiring). The red-team eval set that attack-tests this assembly follows as #863.
- **Release-notes section terminator hardened (#854):** `scripts/ci/release-notes.mjs`'s `TERMINATOR` regex used `<!--.*-->`, which CodeQL `js/bad-tag-filter` flagged — it only matched well-formed single-line comments, so an unterminated `<!--` line was not treated as a section terminator and raw comment text could leak into release notes. The comment alternative is now a tempered match that consumes up to (never past) the first `-->` or end of line; a comment with trailing text still does not terminate (pinned by tests).
- **Prompt-injection surface documented per path (#767 slice A / #861):** `docs/THREAT_MODEL.md` §7 now names every path by which content a principal does not fully control reaches an LLM prompt — inbound email → NLQ planner (top risk: unauthenticated body is the planner's user prompt, no separation at the prompt layer today), orchestrator chat (retrieved memory/vector content interpolated into the system prompt), chat/MCP NLQ (shared planner seam), news sentiment, options-ideas ranking, planner goals, and webhooks (no body reaches a prompt today — named watch item) — each with its trust boundary, current instruction/data separation, and enforcement layer. The §5 residual-risk bullet now points at §7. Docs-only; the email-path defense (#862) and the red-team eval set (#863) follow as their own slices.
- **Premium fulfillment bound to the verified payer (#183, shipped via #698; entry recorded with #720):** `/api/payments/agentic/*` now requires a GitHub OAuth session (401 at the worker without one — the #154 pattern); `/api/premium/*` keeps anonymous x402 paid access but no longer trusts caller-asserted identity headers — the worker strips them and routes to the dedicated `premium-gateway` instance, and persisted payment state is scoped by the VERIFIED payer (`x402:<payer>`) from the claim verifier, never the asserted login. Premium fulfillment runs under that payer scope; wallet status counts only the caller's own rows; the auto-approve limit persists per identity.
- **Hardcoded agent-wallet fallback removed (#720):** `ETradeAgenticPaymentService` no longer falls back to a synthetic wallet-address literal when `X402_AGENT_WALLET_KEY` is unset — the service has no wallet identity in that state, and `signPaymentProof` fails closed (throws) instead of minting a proof under a default address. The literal was the repo's standing gitleaks `generic-api-key` finding on main; the service holds no signing key (proofs are simulated by design), so nothing real was exposed. Pinned by `tests/agentic_payments_identity_binding.test.ts`.

### Fixed

- **Scratch directory untracked (#237 remainder):** `scratch/test_voice_query.ts` — a stale dev script importing the long-moved `src/db/orm` path — is removed from the tree, and `scratch/` is now gitignored, closing the `scratch/ → .gitignore` half of Assessment #237's P1 housekeeping item. The lint/format-config half remains open on #237 (tool choice + baseline pass still owed). No runtime change.
- **GET /ads test contract re-pinned after seed-on-read (#730, PR #735):** the route-extraction test pinned the impressions UPDATE as the handler's first SQL call; the seed-on-read change (`362bcac`) legitimately added an `ensureAdsSeeded` COUNT probe ahead of it, reddening main CI on two consecutive tips. The test now stubs the probe, asserts the UPDATE runs before the listing SELECT (so listed rows reflect post-bump counts), and covers the empty-table seeding path. Test-only; no behavior change. Entry recorded by payrepo as the merge-pass follow-up — PR #735 landed without one.
- **Main Test & Build restored to green (#714):** post-merge verification of the Think cutover (#686) found three suites red on main. The #686 R1 identity pin banned any `"tag": "v7"` in wrangler.jsonc — over-broad once a parallel PR legitimately added a v7 migration; the pin now asserts the SearchAgent facts it exists to protect (SEARCH_AGENT binding and the v1 migration as the sole migration creating SearchAgent). The #359-17 router inventory pin gained six routes that had landed unpinned: /reports/semantic-search (#649), /trading/setup-catalog and /learnings ×2 (#650/#706), /options/strategy-reviews + /decide (#653), /reflection/run (#705). Two trading-boundary (#290) violations fixed by importing through the public `src/trading` index, which already re-exports both modules: `etradeBroker.ts` (setupCatalog) and `etradeOptions.ts` (llmComparison). No behavior change.
- **Deploy job no longer segfaults on secret refresh (#590):** `Build & Deploy [PROD]` failed on every main merge with exit 139 at "Set core secrets on Cloudflare Worker". The retry wrapper added for #560/#561 called `put_secret` from inside `put_secret`, so bash recursed until it crashed; the same body was copied into all three secret steps. Each wrapper now runs `npx wrangler secret put "$name"`, reads the piped value once, and re-feeds it on every retry (a retry used to find stdin drained), still capped at three attempts. The Worker itself had been deploying — the crash happened afterwards, so Tag Release and Post-deploy QA never ran during the failure window. Pinned by `tests/deploy_workflow_secret_retry.test.ts`.
- **Secret pushes are bounded and unmistakable (#590):** every `wrangler secret put` attempt now runs under a 90s timeout and retries back off 10s → 20s (still three attempts). An exhausted push emits a `Secret push failed` check annotation naming the secret, and the deploy job is capped at 30 minutes — so a stuck Cloudflare API call can neither stall a deploy nor be read as a flake. The wrapper is exercised against the real step body with a stubbed broker: two injected failures land on the third attempt with a byte-identical value, and an all-fail run exits non-zero with the annotation.
- **Worker secrets sync is one implementation, one job, no silent skips (#590):** `put_secret` now lives in `scripts/ci/put-secret.sh` instead of three copies inside `deploy.yml`, and the three secret steps moved out of the code-deploy job into a separate `sync-secrets` job (`continue-on-error`, 20-minute cap) that runs after the Worker is live — so a Cloudflare secrets blip can no longer read as "the code deploy failed" or block the release tag and post-deploy QA. Required secrets (GitHub OAuth, session, dashboard token, E*TRADE key/secret) now fail the step when empty instead of being skipped; gateway and notification secrets stay optional but emit a warning and a job-summary line, so an absent value is never silent. The three steps also declare `-euo pipefail` explicitly instead of relying on the runner's shell flags.
- **Research Think-turn fallback is no longer silent (#543):** when the Think child turn in `OrchestratorAgent.runResearchAndPublish` does not produce a fresh report and the deterministic pipeline fallback runs instead, the orchestrator now emits a structured `console.warn` carrying trigger, userLogin, child status/error, and previous/latest run ids — so Workers Logs can distinguish a Think-path success from a bypass (cloudflare.md §8C/F, §9E). Fallback behavior and the publish flow are otherwise unchanged; pinned by `tests/think-fallback-observability.test.ts`.
- **Floating `latest` dependencies pinned (#540):** `@ai-sdk/react`, `@cloudflare/ai-chat`, `ai`, and `workers-ai-provider` (plus devDeps `@cloudflare/workers-types` and `wrangler`) no longer float on the `latest` tag — they are pinned to the exact versions already resolved in `package-lock.json` (no upgrades, no resolved-version changes), so the conformance baseline in `docs/agents/cloudflare.md` §4–5 compares declared against a reproducible installed tree. Guarded by `tests/dependency-pinning.test.ts`, which fails if any spec becomes a floating tag again or package.json drifts from the lockfile root entry.
- **CI red on main — etrade read-error tests made hermetic** (#490): `tests/etrade_read_error_surfacing.test.ts` (#466) failed in CI while passing locally — `resolveEnvironmentConfig()` falls back to `process.env` for E*TRADE credentials, and CI injects the real `ET_API_KEY`/`ET_API_SECRET` secrets into the test job, so the 16 "missing credentials" fixtures silently resolved ambient credentials and never took the not-configured path. The file now stubs every credential alias the resolver reads to empty for each test and restores them afterwards. Same hermeticity class as #401/#404.
- **Stock screener quote reliability (#495):** the E*TRADE-only screener now quotes a universe through the broker's batch quote endpoint (50 symbols per request) instead of one authenticated request per symbol. A NASDAQ100 screen makes two broker calls — plus bounded per-symbol retries for symbols a batch omits — instead of 100+ calls that exhausted the Worker subrequest budget and E*TRADE's rate limit (the run that reported 47 of 100 symbols quoted as `other=53`). Failure diagnostics now distinguish `request-budget` and `batch-omitted`, and a screen that still falls short publishes the qualified partial report (#462) rather than failing outright.
- **Strategy opportunity screening expiry coverage:** the shared scanner now derives bounded near/far expiry bands from the selected strategy catalog and applicable per-symbol sentiments. Both “best strategy per name” and “names that fit my strategy” can generate PMCC, LEAPS, calendar, and other long-dated strategy candidates without expanding ordinary near-expiry eligibility. Bump the scan model version because the additional eligible strategy results change scan semantics.
- **Searchable research reports and Think dispatch (#186/#278/#307/#319):** autonomous options research now runs through a read-only Think agent tool with deterministic pipeline fallback; manual and scheduled options scans save one canonical `mas_reports` row with searchable results and the generated PDF key/URL before delivery. AI Search cache keys include the result limit to avoid cross-limit cache collisions.
- **E*TRADE screener quote retries and provenance (#294):** retry the JSON quote representation when E*TRADE returns an empty HTTP 200 response, preserve broker errors, and prevent live screening from substituting cached or curated prices after a failed E*TRADE quote.
- **Stock/options screener Slack reports (#421/#423/#424):** publish manual and scheduled stock and options screen results with their generated per-run PDFs through the Slack A2A agent, label stock notifications with the selected universe and actual/expected counts, suppress repeated scheduled runs per universe/hour, and notify Slack when runs fail.
- **options_flows test no longer calls live Yahoo Finance** (#404): the flows tests resolved a real crumb session against Yahoo hosts, stretching past the 25s timeout in CI (it reddened PR #403's run and deploy test steps). `fetch` is now stubbed for the suite — Yahoo hosts fail fast so the live-flow path yields [] deterministically, and any other URL throws so a new network dependency fails loudly. Same hermeticity class as #401 (Stripe) and #408 (NLQ LLM).
- **Slice 03/04 characterization tests no longer contradict on main** (#405): the ads/revenue/referrals extraction test anchored its position check to the `// Audit logs endpoint` comment, which slice 04 (#367) legitimately moved into `routes/audit.ts` — the landmark resolved to -1 and the assertion failed every CI/deploy test run. The check now anchors to the `handleAuditRoutes(...)` delegation call. (Rule for remaining #359 slices: anchor positions to delegation calls, never a neighboring domain's inline comments.)
- **payments_did test no longer calls the live Stripe API** (#401): the checkout unit test resolved the mock key into a real `fetch` to `api.stripe.com` (~5.3s standalone, past the 25s timeout under suite load — it failed PR runs and blocked the 63443d6 production deploy's test step), and its assertions silently passed on the 401 error path. `fetch` is now stubbed hermetically for the checkout-sessions endpoint and the test asserts the actual success contract (success, checkout URL, gateway ref).
- **mas_reports DDL single-sourced (SQLITE_ERROR: no such column: generation_id)** (#389): the ORM's `initializeSchema()` carried its own duplicate `mas_reports` DDL that created the unique index on `generation_id` without a column guard, so any Durable Object whose table predated #308 threw on every schema init (the Strategy/Symbol Scanner failure). The block now delegates to `ensureScheduledReportsTable()` in `src/services/scheduledReports.ts` (PRAGMA-checked additive migration); the unguarded duplicate is deleted. Regression test: a pre-#308 table migrates without throwing and keeps its rows.

### Fixed

- **Reports/Schedules tabs render their panels** (#388): the #309 navigation items were missing from Chat's `TRADING_TABS` and `mapTabToTradingSubTab`, so selecting Reports or Schedules hid the trading hub and rendered a blank main view. Both tabs are now trading tabs with explicit subtab mappings and breadcrumb labels; a regression test pins the wiring.
- **Research section default view restored** (#387): the Trading hub research section landed on the new Autonomous runs panel (empty state) instead of the per-symbol research panel it showed before #319. The toggle now defaults to Symbol research; Autonomous runs remains one click away.

### Added

- **Think migration step 4 — CUTOVER: OrchestratorAgent runs on Think (#686):** the production orchestrator is rebased in place from `AIChatAgent` onto `Think` (@cloudflare/think), completing the migration the owner decision (#644) committed to. Identity is unchanged — same class name, same `SearchAgent` export alias, same `SEARCH_AGENT` binding, no new wrangler migration — so existing Durable Object instances and their storage carry over, and browser chat keeps the `cf_agent_chat_*` protocol (Think is useAgentChat-compatible by design). The turn lifecycle the step-3 shadow proved now serves production: Judge routing, `route.decided` audit, auto-research NLQ pre-dispatch, grounding, and the shared prompt builder run in `beforeTurn`; finish side-effects (assistant record, `judge.evaluate` → `response.evaluated`, VectorMemory store) run in `onChatResponse`; terminal errors surface the aspect format via `onChatError`; POST /api/chat keeps its exact contract through a `runTurn` driver (the user message enters the session via the factory input, delta-by-id, so history re-sends do not duplicate). A conservative one-time lift imports any residual pre-SDK `cf_ai_chat_agent_messages` rows into the session store. The shadow file is absorbed and deleted. **One deliberate behavior delta:** the step clamp is now sanitized — a non-numeric `MAS_MAX_STEPS` falls back to the default 6 instead of propagating NaN into the turn's stop condition. Evidence: `tests/orchestrator-think-cutover.test.ts` (identity pins, route parity over the 105-entry judge golden corpus on the real class, side-effect and re-send dedupe pins, legacy lift).
- **Think migration step 3b — shadow turn lifecycle + shared error fallback (#669):** the inert Think shadow (`OrchestratorThinkAgent`) now executes a complete chat turn: Judge routing inside `beforeTurn` (route → `TurnConfig` carrying the assembled system prompt, the sanitized step bound, and tool suppression for auto-research turns via `activeTools`, since `TurnConfig.tools` is additive-only), the NLQ pre-dispatch for source-tagged auto-research requests, finish side-effects in the `runShadowChatTurn` driver (assistant `recordMessage`, `judge.evaluate` → `response.evaluated`, VectorMemory store), and the async-job submit/execute path (`http.request` jobs fail explicitly — the routed surface they dispatch through arrives at cutover, step 4). The chat error fallback is extracted to `src/agents/chatErrorFallback.ts`, shared verbatim by the live class and the shadow. Side-by-side evidence (`tests/orchestrator-think-lifecycle.test.ts`): route parity fixture-for-fixture over the 105-entry judge golden corpus plus the synthetic auto-research route, turn-shape and side-effect parity (`mas_messages` rows, `route.decided`/`response.evaluated` audits), and bounds equivalent-or-tighter — the one enumerated difference is non-numeric `MAS_MAX_STEPS` (live propagates NaN, shadow applies 6). Still inert: not exported, bound, or routed. The test SQL double also learned literal VALUES/SET assignments and multi-line UPDATEs, matching real SQLite.
- **Think migration step 3a — shared prompt builder + shadow core (#668):** the orchestrator's ~75-line system-prompt template and step clamp now live in `src/agents/chatPrompt.ts` (`buildOrchestratorSystemPrompt`, `resolveMasMaxSteps`), extracted verbatim and consumed by the live turn — byte-identity with the pre-extraction template is pinned by fixtures captured from the original source. Beside it, an inert Think shadow core (`src/agents/orchestrator-think.ts`, `OrchestratorThinkAgent`) wires the constructed model arm, the full MCP tool surface from real instance state, a sanitized step bound (non-numeric `MAS_MAX_STEPS` → default 6, shadow only), and session-memory grounding via a Think context block. It is not exported, bound, or routed; production traffic cannot reach it. Judge routing and the turn driver follow in step 3b (#669).
- **Autonomous options runs are readable after the fact (#223):** `autonomousOptionsAnalysis` now appends each run to `options:last_runs` (newest first, capped at 20, storage failure never fails the run) and `GET /api/options/latest` serves that history. The options schedule panel lists the five most recent runs with symbols, setup count, trigger/thesis, and the failure reason when one exists. Scheduling stays on the existing user-owned `/api/schedules` path — no baseline seeder was added back, because `removeUnownedBaselineSchedules` deliberately deletes unowned `autonomousOptionsAnalysis` jobs. The old `feat/options-scheduled-223` branch's `onStart` seeder would have recreated exactly those jobs.
- **Record-retention policy for both task ledgers (#635, phase-2 P2-3.5):** terminal task records now expire under a two-tier policy — `completed`/`cancelled` after 90 days, `failed`/`escalated` after 365 days (human-review items get the longer tier) — via `pruneExpired` on both ledgers, which also removes the record's idempotency entry. Active records are never pruned. Pruning rides the existing maintenance path: the `sweepStaleLedgerTasks` callback (#618) prunes both ledgers per user in isolated legs and logs the counts, so retention runs on the same onStart + 6-hourly cadence with no new schedules. Run artifacts (reports, screen results) live in separate stores and are unaffected.
- **Heartbeat emission during long research and screener runs (#624, phase-2 P2-3.4):** live runs now keep their task record's heartbeat fresh, so the #615 staleness signal means *abandoned*, not *slow*. Research: `runResearchAndPublish` heartbeats the task every 2 minutes while dispatch is in flight (covering both the Think turn and the fallback run) via the new `ResearchAgent.heartbeatResearchTask`, with the timer cleared in a `finally` on every exit. Screener: `runScreen` heartbeats its own task at phase checkpoints and during the technicals phase — via a new optional `onBatch` progress callback on `fetchTechnicalsBatch` — throttled to one ledger write per minute through `ScreenerAgent.heartbeatScreenerTask`. Heartbeat failures are best-effort and never break a run.
- **Stale-task sweep now runs automatically (#618, phase-2 P2-3.3):** the orchestrator's maintenance path sweeps both task ledgers for each authenticated user — `onStart` closes any already-stale research/screener task records and arms a persistent 6-hourly interval schedule (`sweepStaleLedgerTasks` callback), so abandoned records are failed → escalated within ~6.5 hours worst case even with no user traffic. Each ledger is swept in isolation; sweep failures log and never block startup or the other ledger.
- **Stale-task detection and sweep for both task ledgers (#615, phase-2 P2-3.2 / architecture risk R4):** the research (#577) and screener (#607) task ledgers now detect abandoned work — active tasks (queued/claimed/running) whose heartbeat is older than a threshold (default 30 minutes, overridable) — via read-only `findStale`, and close it honestly via `sweepStale`: failed → escalated with the heartbeat age and threshold recorded in the task's error and history. No auto-rerun and no deletion; the work may have partially happened, so a human reviews the escalation. ResearchAgent and ScreenerAgent expose `findStale*` / `sweepStale*` operations; nothing invokes the sweep automatically yet (the trigger/cadence is a separate decision). Also corrects the #607 storage terminology (#611): ScreenerAgent persists via Durable Object storage (`ctx.storage`), not Cloudflare KV.
- **Durable task records for screener runs (#607, phase-2 P2-3.1):** every `ScreenerAgent.runScreen` execution — manual, scheduled, and every `runSharded` shard — now writes a task record in the agent's own Durable Object storage (`screener:task:` prefix), via the new SDK-free `src/services/screenerTaskLedger.ts` (async injected-store idiom mirroring the research ledger, #577). Scheduled runs dedup their record on the same minute-slot identity as `claimScheduledExecution`; suppressed duplicates close as `cancelled`; failures fail + escalate; completions carry the run's timestamp identity, counts, and a deterministic honesty evaluation (zero-scan success fails the check per #462; partial runs must carry their qualification). Results gain an additive `taskId`; ledger failures warn and never break a screen.
- **Removed unreferenced standalone agent classes (#597, phase-2 P2-0.3 / finding F5):** `src/agents/search.ts`, `tasks.ts`, `memory.ts`, and `payments.ts` were dead `AIChatAgent` classes (250 lines, zero references in src/tests/config) whose names collided with live classes — `SearchAgent` (the orchestrator's export alias) and `PaymentsAgent` (the payments Durable Object). Live behavior for those domains is the `mas.ts` tool factory. A new guard suite (`tests/dead-agent-classes.test.ts`, written red-first per gitops.md §7) pins their absence and the unchanged `src/server.ts` export surface.
- **Durable research task ledger — phase-2 vertical slice (#577):** every delegated research run now leaves a durable, queryable task record in the ResearchAgent's DO (`research_task_store`), via the new SDK-free `src/services/researchTaskLedger.ts` (injected-store idiom). `runResearchAndPublish` creates + begins a task before dispatch (record deduped by idempotency key while active), completes it with the execution path actually taken (`think`/`fallback`, building on #543) and a deterministic outcome evaluation (fresh runId, trigger/login match, summary present, sane counts — never model self-grading), and escalates the task on total failure instead of the failure vanishing. Results gain additive `taskId`/`executionPath` fields; ledger failures warn and never break the research flow. Design: `docs/agents/agentic-architecture.md` §5/§7.
- **Agentic target architecture (#576, phase-2/P1):** `docs/agents/agentic-architecture.md` delivers the transformation mandate's architecture stage — re-baseline at `e6d80a0`, a §4 capability-allocation table (zero new agent classes: the change is contractual/coordinative, not a larger agent count), target topology and contracts, a §6 durable-coordination design (task state model, DO-serialized claiming, idempotency dedup, heartbeat/stale policy), the §7 memory mapping onto existing stores, and the implementable Phase 2 slice specification (research task ledger, #577) with its before/after gate evidence.
- **Think roles decision record (#545):** `docs/agents/think-roles-decision.md` inventories every agent class against the cloudflare.md §2 designation question — ResearchAgent recommended as the designated Think role; OrchestratorAgent as the only serious (optional) migration candidate with a 5-step sequenced path; non-chat DOs as not planned / not applicable. It also records that the standalone `search/tasks/memory/payments.ts` AIChatAgent classes are unreferenced anywhere in `src/` or `tests/` and recommends removal or prototype marking instead of migration. Owner decision table is included; recommendations are not requirements until the owner marks them.
- **Think conformance regression tests (#542):** `tests/think-conformance.test.ts` pins the adoption evidence from `docs/agents/think-conformance.md` — exact `@cloudflare/think`/`agents` pins, `ResearchAgent extends Think` with `getModel`/`getSystemPrompt`/`getTools`, the `src/server.ts` Durable Object export, the `RESEARCH_AGENT` binding + SQLite migration in `wrangler.jsonc`, and the orchestrator's `runAgentTool(ResearchAgent)` dispatch — because vitest aliases Think to a stub, a refactor that unwired any of these previously failed no test. Verified by mutation: removing the Think base class fails the suite.
- **Think conformance assessment (#541):** `docs/agents/think-conformance.md` publishes the `docs/agents/cloudflare.md` §14 assessment for this repo — separate verdicts (Think adoption PARTIAL: only ResearchAgent is Think-based), the §4 baseline at main `f063104` (declared == resolved versions after #540), architecture/identity map, conformance matrix, and findings F1–F6 in §13 format with the remediation sequence (#540 done, #542, #543, #545) and acceptance criteria. It also records that `ResearchAgent.getModel()` returning a string was verified as a valid `ThinkModel` against the installed `@cloudflare/think` 0.19.0 types.
- **cfpay email-with-attachments A2A helper** (#384): `cfpaySendEmailWithAttachments()` in cfpayA2A.ts wraps cfpay's `email.sendWithAttachments` A2A op, enabling options-report PDF delivery by email (wiring into the scheduled options analysis follows).

### Changed

- **Regression assurance completed in the delivery policy (#745):** `docs/agents/gitops.md` gains §19 beside §18's merge-gate discipline — the detection layer (post-deploy smoke with automatic failure filing, `ci-failure-self-heal`, watcher surfacing within minutes, cache-bypassed production verification), the response loop (fixing-lane flow; **fix + coverage** mandatory; the loop closes only when the filing check passes again), gate screening for the shapes a green suite cannot see (stale-base mass deletions, conflict markers, non-hermetic tests, bite-proofed pins, landed-state verification of every branch commit), and §19.4 enforcement: required status checks (branch protection) on `main` in every repository under the policy, with unprotected repositories recorded as open enforcement gaps. The §16 checklist gains the regression-coverage confirmation. Docs only.
- **Delivery policy gains a regression-prevention discipline (#746):** `docs/agents/gitops.md` §18 codifies the operating discipline behind the repo's regression defenses — a PR gate result is valid only for the merge it tested and expires when main advances over the PR's surfaces; merging over a red required check is prohibited outside an owner-authorized emergency that files a restore-green issue in the same action; post-merge red is the merger's first job, with every failure classified on the record with evidence (never by totals alone); a failure may be called flaky only with standalone-pass and first-parent comparison evidence, and known-flaky suites form a tracked remediation backlog, not an exemption; suites that stub the real runtime verify contracts, and PRs must state what covers runtime behavior instead of claiming it from stubs; and every PR is merged promptly with its merged state verified, not assumed. Written from the 2026-10-20 merge train, where each gap was observed at least once. Docs only.
- **Delivery policy gains the pin rule (#742):** `docs/agents/gitops.md` §7 now obliges every PR to keep the repo's pins current — a change to a pinned surface (route inventory, design-token mirror and contrast pairs, dependency specs, DO bindings/migrations, module boundaries, conformance adopter sets) updates its pin in the same PR; no PR merges over a red pin; pins are scoped narrowly to the facts they protect; new shared surfaces get pins or an explicit waiver note. Written from the 2026-10-20 evidence: routes, migrations, and boundary imports that landed unpinned and went red on main after merge, the #677 UX token drift that accumulated in the unpinned gap, and an over-broad identity pin that false-fired on a legitimate parallel migration. Docs only.
- **Think migration step 5 — post-cutover verification and program close-out (#721):** the five Think behaviors the step-4 cutover rests on were audited against the shipped `@cloudflare/think@0.19.0` dist and the `agents` sessions store — factory-form `runTurn` input (its delta effect comes from the store's idempotent-on-id append), `addMessages` append semantics (cutover call sites need nothing more), `activeTurnMetadata` (server-turn metadata; the client stamps ride in the message's own persisted metadata, as `deriveTurn` reads them), `onChatResponse` firing for both entry points after persistence, and the native durable `submitMessages` queue. No assumption failed verification. `docs/agents/think-conformance.md` gains a post-cutover addendum re-scoring the §8 verdicts (both Required roles now PASS on adoption/loop ownership), and `docs/agents/think-roles-decision.md` records the program outcome — all five steps complete, with the two deliberate deltas (sanitized `MAS_MAX_STEPS` clamp; native `submitMessages`) as accepted outcomes. Docs only; no behavior change.
- **GitHub Releases now carry the curated changelog (#321 follow-up):** every
  successful `main` deploy tagged `v0.1.<patch>` and then stopped, so `/releases`
  never showed what changed and the only description of a deploy lived in this
  file. The `tag-release` job's new *Publish GitHub Release* step composes one
  body per tag: the section for that version (or `[Unreleased]` while the release
  PR has not moved entries yet) above the generated commit list, which is fetched
  from `releases/generate-notes` scoped by `previous_tag_name`, and a link to this
  file at the tag. Composition lives in `scripts/ci/release-notes.mjs` — heading
  stripping, link-definition removal, blank-line tidying, the 60k section cap and
  GitHub's 125k body cap are unit-tested in
  `tests/release_notes_script.test.ts`; the workflow wiring, the scoped note range,
  the idempotent re-run and the loud failure on a missing tag body are pinned by
  `tests/release_publication.test.ts`. The release is created in a single call with
  `--notes-file`, so a cancelled run cannot publish a release without its notes; a
  failing `generate-notes` call degrades to the curated section with a warning
  instead of blocking a deploy that already shipped.
  `*.mjs` is pinned to LF in `.gitattributes` (alongside `*.sh`), because a CRLF
  checkout on Windows left the script's shebang line unrecognized and the suite
  failed with `SyntaxError: Invalid or unexpected token` on every local run.

- **Thin-router wiring — orchestrator breakup COMPLETE** (#359/#380): the
  last two inline route blocks in `OrchestratorAgent.routeRequest` moved
  into `src/agents/routes/` — the schema introspection block (GET
  `/schema/tables`, POST `/schema/query`) into `routes/schema.ts` as
  `handleSchemaRoutes` (between the MCP/chat/NLQ and ads/revenue/referrals
  delegations), and the Cloudflare Agentic Payments block (x402 & MPP:
  GET `/payments/agentic/wallet`, GET|POST
  `/payments/agentic/auto-approve-limit`), deliberately left inline by
  slice #359-07, into `routes/agenticPayments.ts` as
  `handleAgenticPaymentsRoutes` (between the payments and premium
  delegations); the `ETradeAgenticPaymentService` import moved with it.
  `routeRequest` is now a thin ordered dispatcher: the request prelude
  (url/path, `ensureTables`, `sessionKey`, the `requestedEnv` binding
  passed via context), 22 guarded delegation calls, and the Not-found
  fallthrough — no inline path-matched handlers remain. Landmark swaps
  (#405) in the slice-03/07/08 tests: their anchors into the then-inline
  schema-query condition and agentic-payments banner now anchor to the
  new delegation calls. A scripted full-router scan confirms all 150
  path-matching conditions in unchanged order; both moves are
  byte-identical under reverse transform. Characterization:
  `tests/schema_routes_extraction.test.ts` (8 tests),
  `tests/agentic_payments_routes_extraction.test.ts` (12 tests),
  `tests/thin_router_inventory.test.ts` (4 tests, pins the delegation-only
  shape and the full 150-condition inventory). orchestrator.ts: 6,803 →
  2,802 lines across the 17 slices. Pure move, no behavior change.

- **FOSS research routes extracted from orchestrator.ts** (#359/#377): the
  non-alpaca FOSS route blocks moved to `src/agents/routes/fossResearch.ts`
  as TWO handlers, each invoked from `routeRequest` at its exact original
  position — `handleFossQuoteResearchRoutes` (GET `/foss/quote`,
  `/foss/fundamentals`, `/foss/bars`, `/foss/research`, before the
  handleAlpacaFossRoutes delegation) and `handleFossCompareScreenRoutes`
  (POST|GET `/foss/compare`, GET `/foss/providers`, POST|GET
  `/foss/screen`|`/yfinance/screen`, after it). The `FossResearchService` /
  `fossBarsSourceLabel` and `YFinanceMarketScreener` imports moved with the
  blocks; audit events stay funneled through the single-owner `recordAudit()`
  via the context. Slice #359-13's test landmark (the
  FossResearchService-import-stays-inline anchor) was swapped to the new
  ownership per the #405 rule. Pure move, no behavior change.

- **Schedules routes extracted from orchestrator.ts** (#359/#379):
  the contiguous schedules block (GET `/schedules`, POST
  `/schedules/cancel`, DELETE `/schedules/:id`, GET `/schedules/:id`,
  POST `/schedules/create` + its `/schedules` create alias, POST
  `/schedules/trigger-screen|/trigger-renew|/trigger-options-analysis|/trigger-retention|/trigger-iv-collection`)
  moved to `src/agents/routes/schedules.ts` as a single handler,
  `handleSchedulesRoutes`, invoked from `routeRequest` at the exact
  original position (after the screener + research delegation, before the
  Not-found fallthrough - this block was the last one before it). The
  `resolveEnvironmentConfig`, `getStoredTokens`, `isTokenExpiredEt`,
  `runStorageRetention` and `UNIVERSES` imports moved with the block; the
  Agents SDK scheduling port (`listSchedules`, `cancelSchedule`,
  `getScheduleById`, `schedule`, `scheduleEvery` - the `as keyof this`
  assertion pattern from the #109 NLQ scheduling port), `audit`,
  `getOrm`, `agentCtx` (for the SqlStorage-backed stores),
  `autonomousMarketScreen`/`autoRenewETradeTokens` and
  `getScreenerExecutionContext` arrive via the context object with
  identical arguments (#111 allow-list/honest-503 semantics and #447
  account-stamping unchanged). The #111 `CREATABLE_SCHEDULE_CALLBACKS`
  / `ACCOUNT_SCOPED_SCHEDULE_CALLBACKS` constants stay module-owned by
  `orchestrator.ts` (the former is a public export) and arrive via the
  context; the #447 `onStart` schedule-reconciliation code is untouched
  outside the route block. A scripted scan confirms the 15-condition
  inventory and order are unchanged. Characterization:
  `tests/schedules_routes_extraction.test.ts` (18 tests).

- **Alpaca routes extracted from orchestrator.ts** (#359/#376): the
  alpaca-named route blocks moved to `src/agents/routes/alpaca.ts` as TWO
  handlers, each invoked from `routeRequest` at its exact original position —
  `handleAlpacaTradingRoutes` (POST `/trading/alpaca/order`, GET
  `/trading/alpaca/account|/positions|/orders`, after the watchlists
  delegation) and `handleAlpacaFossRoutes` (GET `/foss/snapshot`, GET
  `/foss/alpaca/account|/positions|/orders`, POST `/foss/alpaca/order`,
  between the `/foss/research` and `/foss/compare` blocks). The non-alpaca
  foss routes were slice #359-14's (foss research) domain and are now
  extracted to `src/agents/routes/fossResearch.ts` (two handlers flanking
  this delegation). `FossResearchService` was constructed with the same
  env (no credential/auth semantics change); the import has moved to the
  fossResearch module with the blocks (slice #377 swapped the test
  landmark). Audit events stay funneled through the single-owner
  `recordAudit()` via the context. Slice #359-12's test needs no landmark
  swap (it already anchored to the watchlists delegation call). Pure move,
  no behavior change.

- **Watchlists routes extracted from orchestrator.ts** (#359/#375): the
  E*TRADE watchlists block (GET `/etrade/watchlists`,
  GET `/etrade/watchlist/details`, POST `/etrade/watchlist/create`,
  POST `/etrade/watchlist/save-screen`, DELETE|POST
  `/etrade/watchlist/delete`) moved to `src/agents/routes/watchlists.ts` as a
  single handler, `handleWatchlistsRoutes`, invoked from `routeRequest` at the
  exact original position (between the E*TRADE options delegation and the
  Alpaca block). The `ETradeService` import moved with the block;
  `requestedEnv` stays inline and is passed through the context; dependencies
  arrive via an explicit context object. Slice #359-11's test landmark (the
  watchlists banner anchor) was swapped to the new delegation call per the
  #405 rule. Pure move, no behavior change.

- **Trading integrations routes extracted from orchestrator.ts** (#359/#373):
  the omnichannel trading channel block (POST `/trading/email/inbound`,
  POST `/trading/slack/event|/interaction|/command`, POST
  `/trading/browser/transaction-snap` (also `/browser/transaction-snap`),
  POST `/trading/voice/turn`, GET `/trading/voice/greeting`) moved to
  `src/agents/routes/tradingIntegrations.ts` as a single handler,
  `handleTradingIntegrationsRoutes`, invoked from `routeRequest` at the
  exact original position (between the E*TRADE broker block and the broker
  activity delegation). ETrade*TradingService imports stay behind the
  `src/trading/index.ts` boundary (#290); dependencies arrive via an
  explicit context object. A characterization test pins route order and
  behavior.
- **E*TRADE broker routes extracted from orchestrator.ts** (#359/#372): the
  "Environment & E*TRADE Trading APIs" block (the #314 environment switcher
  with both `/environment/switch` and `/broker/etrade/environment` spellings
  delegating to the single-owner `handleEnvironmentSwitch`, broker status,
  diagnostics, accounts, the equity screener, quote, order preview/execute
  with the autopilot policy envelope, expiration scheduling and pre-trade
  Slack approval ticket, positions, portfolio-risk aggregate/evaluate/
  correlation/size, think evaluation, hedge analysis, and orders
  listing/remote-fetch/cancel) and the account-activity block
  (transactions, transaction details, alerts inbox/details/delete, product
  lookup) moved to `src/agents/routes/etradeBroker.ts` as TWO handlers —
  `handleEtradeBrokerRoutes` and `handleEtradeBrokerActivityRoutes` — each
  invoked from `routeRequest` at the exact original position (the blocks
  were non-contiguous). Handlers take dependencies via an explicit context
  object; the options blocks stay inline for sibling slice #359-11. A
  characterization test pins route order and behavior.
- **Payments routes extracted from orchestrator.ts** (#359/#370): the
  Multi-Gateway Payments & DID Management API (GET `/payments/gateways|/status`,
  GET `/payments/dids`, the transactions ledger, POST `/payments/create`,
  POST `/payments/confirm` (HITL), POST `/payments/capture`, POST
  `/payments/webhook`) moved to `src/agents/routes/payments.ts`, invoked from
  `routeRequest` at the exact original position (between the referrals+ads
  handler and the Cloudflare Agentic Payments block). All money-adjacent
  guards preserved exactly (#156 gateway 400-before-checkout, #148 webhook
  provider default-deny, signature verification, the payment.created/
  confirmed/rejected/captured/settled_webhook audit events); a
  characterization test pins route order and behavior.
- **Memory + reset routes extracted from orchestrator.ts** (#359/#369): the
  Persistent Memory facts routes (GET/DELETE `/memory`) and the session reset
  routes (POST|DELETE|GET `/clear|/reset`) moved to
  `src/agents/routes/memoryReset.ts`, invoked from `routeRequest` at the exact
  original position (between the autopilot handler and the referrals+ads
  handler). Reset guards preserved byte-for-byte in behavior (the
  `?purge=false` opt-out, the abort reason string, the
  memory.deleted/memory.cleared/history.purged/history.cleared audit events);
  a characterization test pins route order and behavior.
- **Reports + HITL routes extracted from orchestrator.ts** (#359/#363): the
  report generation/dispatch routes (`/trading/reports/email`,
  `/trading/reports/webhook`), the #277 HITL confirmation routes
  (`/trading/reports/pending`, `/trading/reports/confirm`) and report-settings
  routes (`/trading/settings/report-dispatch-hitl`), plus the #309
  `GET /reports` list route, now live in `src/agents/routes/reports.ts` as
  `handleReportsRoutes()`. Pure move — same paths, same matching order in
  `routeRequest` (verified: no other handler in the region matches these
  paths), same response shapes/statuses/auth. Handlers reach OrchestratorAgent
  state only through an explicit `ReportsRouteContext`. Characterization:
  `tests/reports_routes_extraction.test.ts` pins the 7-route inventory and
  relative order. orchestrator.ts: 6803 → 6490 lines.

- **MCP + chat + NLQ routes extracted from orchestrator.ts** (#359/#364): the
  MCP server endpoint (`/mcp`), `POST /api/chat`, and `POST /nlq` now live in
  `src/agents/routes/mcpChatNlq.ts` as `handleMcpChatNlqRoutes()`. Pure move —
  same paths, same matching order in `routeRequest` (the three blocks were
  contiguous, so a single delegation at the region's original position preserves
  order), same response shapes/statuses/auth. The NLQ webhook spellings were
  already extracted to `src/server.ts` by #313 and are untouched. Characterization:
  `tests/mcp_chat_nlq_routes_extraction.test.ts` pins the 3-route inventory,
  relative order, and the NLQ pipeline argument contract.

- **Ads / revenue / referrals routes extracted from orchestrator.ts** (#359/#366):
  the referral-categories ORM CRUD (`/categories`), the revenue summary
  (`GET /revenue`), and the external ad network placements with impression/click
  tracking (`/external-ads`, `/external-ads/impression`, `/external-ads/click`),
  plus the community referrals (`/referrals`, `/referrals/click`) and sponsored
  ads (`/ads`, `/ads/click`), now live in
  `src/agents/routes/adsRevenueReferrals.ts`. Pure move — same paths, same
  matching order in `routeRequest`, same response shapes/statuses. The domain's
  blocks are not contiguous in the original file (inventory group sat between
  /schema/query and /audit; community group between /memory and the payments
  block), so the module exports two handlers — `handleAdsRevenueReferralsRoutes()`
  and `handleReferralsAdsRoutes()` — each invoked at its original position in
  the sequential matching sequence. Handlers reach OrchestratorAgent state only
  through an explicit `AdsRevenueReferralsRouteContext`.
  Characterization: `tests/ads_revenue_referrals_routes_extraction.test.ts`
  pins both handlers' route inventories and relative order, the two call-site
  positions, and behavior (null for non-owned paths, validation, audit events,
  SQL writes). A scripted scan of the full 120-condition route inventory
  confirms the matching order is unchanged. orchestrator.ts: 6364 → 5998 lines.

- **Audit routes extracted from orchestrator.ts** (#359/#367): the audit-log
  read route (`GET /api/audit`), the generic audit write (`POST /api/audit`)
  and the strictly-validated event append (`POST /api/audit/event`, issue
  #270/PR #302) now live in `src/agents/routes/audit.ts` as
  `handleAuditRoutes()`. Pure move — same paths, same matching order in
  `routeRequest` (the three blocks were contiguous between the
  ads/revenue/referrals handler and the autopilot block, so a single
  delegation at that position preserves order), same response
  shapes/statuses. Audit writes stay funneled through the single-owner
  `recordAudit()` via an explicit `AuditRouteContext`; nothing is inlined.
  Characterization: `tests/audit_routes_extraction.test.ts` pins the 3-route
  inventory and order, the single call-site position, and behavior (null for
  non-owned paths, GET parsing/limit clamp, POST defaults, event-append
  validation + 201 delegation). The source pin in
  `tests/audit-event-endpoint.test.ts` now points at the new ownership.

- **Autopilot routes extracted from orchestrator.ts** (#359/#368): the
  Autopilot control center routes (autopilot Phase 1) — `GET /autopilot`,
  `POST /autopilot/state`, `POST /autopilot/kill-switch`,
  `POST|PUT /autopilot/limits`, `POST /autopilot/evaluate` — now live in
  `src/agents/routes/autopilot.ts` as `handleAutopilotRoutes()`. Pure move —
  same paths, same matching order in `routeRequest` (the five blocks were
  contiguous between the audit handler and the Persistent Memory endpoint, so
  a single delegation at that position preserves order), same response
  shapes/statuses. The policy-verdict pipeline stays behind the orchestrator's
  `evaluateAndRecordAutopilotVerdict()` via an explicit
  `AutopilotRouteContext`; nothing is inlined. Characterization:
  `tests/autopilot_routes_extraction.test.ts` pins the 5-route inventory and
  order, the single call-site position, and behavior (null for non-owned
  paths, state/kill-switch/limits updates with audit events, evaluate
  validation + pipeline delegation). A scripted scan of the full 92-condition
  route inventory confirms the matching order is unchanged. orchestrator.ts:
  5928 → 5842 lines.
- **Premium routes extracted from orchestrator.ts** (#359/#371): the three
  Paid Trading Service blocks — `/premium/options-scan` (Institutional Options
  & Greeks Screener, $0.05 USDC), `/premium/market-research` (Autonomous Equity
  Research Report, $0.10 USDC), `/premium/stock-signals` (Real-Time Quantitative
  Anomaly Signals, $0.02 USDC), each GET|POST and payment-gated — moved to
  `src/agents/routes/premium.ts` as `handlePremiumRoutes()`. Pure move: same
  paths, same matching order in `routeRequest` (the three blocks were
  contiguous between the Cloudflare Agentic Payments block and the Environment
  & E*TRADE Trading APIs block, so a single delegation at that position
  preserves order — scripted scan of the full 90-condition inventory confirms
  it), same response shapes/statuses, canonical-copy reporting (#307/#308)
  preserved. Handlers reach OrchestratorAgent state only through an explicit
  `PremiumRouteContext` (env + getOrm). Characterization:
  `tests/premium_routes_extraction.test.ts` pins the 3-route inventory and
  order, the single call-site position, and behavior (null for non-owned
  paths; unpaid requests get the 402 payment-required challenge without
  running the fulfill callback, so no canonical-report row is written).
  orchestrator.ts: 5435 → 5280 lines.
- **E*TRADE options routes extracted from orchestrator.ts** (#359/#374): the
  contiguous options block (GET `/etrade/options/chains|/expire-dates|/scans|`
  `/scans/diff|/iv-history|/profiles`, POST `/etrade/options/profiles|`
  `/strategy` (the #314 advertised spelling), POST
  `/trading/options/llm-ideas|/compare|/recommend|/strategies|/best-trade`,
  GET `/trading/options/catalog`, POST|GET `/trading/options/screen|`
  `/unified|/config`) moved to `src/agents/routes/etradeOptions.ts` as a
  single handler, `handleEtradeOptionsRoutes`, invoked from `routeRequest` at
  the exact original position (between the E*TRADE broker account-activity
  delegation and the watchlists block). The #314 single-owner
  `handleOptionsStrategyRecommend` moved with its block (both strategy
  spellings delegate to it; byte-identical contract); the `requestedEnv`
  binding stays inline and is passed through the context. All trading access
  stays behind the `src/trading/index.ts` boundary (#290); a scripted scan
  confirms the 18-condition inventory and order are unchanged.
  Characterization: `tests/etrade_options_routes_extraction.test.ts` pins the
  route inventory and order, the single call-site position, and behavior
  (null for non-owned paths; 400s on invalid llm-ideas symbol and strategy
  requests before any backend call). orchestrator.ts: 4432 → 3454 lines.

- **Screener + research routes extracted from orchestrator.ts** (#359/#378):
  the contiguous screener/research block (GET `/screener/latest`,
  `/screener/report.pdf`, `/options/report.pdf`, POST `/research/run`,
  `/research/scheduled-tick`, GET `/research/latest|/history|/settings`,
  POST `/research/settings|/evaluate`) moved to
  `src/agents/routes/screenerResearch.ts` as a single handler,
  `handleScreenerResearchRoutes`, invoked from `routeRequest` at the exact
  original position (after the FOSS compare/screen delegation, before the
  task schedules block). The `triggerManualResearch` /
  `triggerScheduledResearch` and `shouldFireResearchTick` /
  `RESEARCH_SCHEDULED_LAST_RUN_KEY` imports moved with the blocks; the
  orchestrator-owned `getScreenerAgent`, `getResearchAgent`,
  `runResearchAndPublish` (the #308 canonical store lives inside it),
  `readSettingRaw` and `writeSetting` helpers arrive via the context object
  with identical arguments (store-first, fail-closed semantics unchanged).
  A scripted scan confirms the 10-condition inventory and order are
  unchanged. Characterization:
  `tests/screener_research_routes_extraction.test.ts` pins the route
  inventory and order, the delegation position (anchored to the
  `handleFossCompareScreenRoutes(...)` delegation call per the #405 rule),
  and behavior (null for non-owned paths; 404/400 contracts on the PDF and
  evaluate paths). orchestrator.ts: 3317 → 3146 lines.

### Added

- **Options PDF stored to KV for download** (#361, PR #362): generated options-scanner PDFs are stored in KV (`options:pdf:{filename}` plus an `options:pdf:latest` pointer), mirroring the stock screener pattern, so the download endpoint can serve them.

- **Manual options scans → Slack via A2A** (#358): the `/trading/options/unified`
  endpoint now honors a `pushToSlack` request-body param. After the scan
  completes (action `opportunities`), the summary text goes via
  `cfpayPostToSlack()` and the options PDF report (`generateOptionsPdf()`) via
  `cfpayPostFileToSlack()` — same pattern as the scheduled path in
  `scheduledTasks.ts:autonomousOptionsAnalysis()`. Optional `slackChannel`
  param overrides `SCREENER_SLACK_CHANNEL`.

- **Scheduled research run restored via the */30 tick** (#354): the account's
  Workers Free 5-cron-trigger ceiling (error 10072) makes the dedicated
  `0 21 * * 1-5` trigger impossible, so its `scheduled()` branch was dead
  code. The daily options-research run now rides the `*/30` tick instead:
  after the ScheduledAgent tick, the handler POSTs
  `/research/scheduled-tick`, and a pure guard
  (`src/services/researchScheduleGuard.ts`) fires the run exactly once per
  weekday at/after 21:00 UTC. Idempotency is durable — the last-fired date
  is stored in the orchestrator's `mas_settings` (survives ticks and
  isolates); the marker is written only after a successful run, so a failed
  21:00 run retries at 21:30. Skips return an explicit
  `skipped: true` with the reason.

- **PMCC reachable in the research pipeline** (#352/#353): `getChain` now
  selects expirations across two bounded windows — the 30–45 DTE near band
  the short-dated structures use and a >=180 DTE LEAPS band — instead of the
  first four expirations only, which made the `pmccEnabled` flag inert. The
  PMCC long-leg requirement drops from >=300 to the catalog's >=180 DTE
  (`farMinDte`), and the thesis/range gates admit PMCC for `range_bound`
  outlooks as the catalog tags it (`[bullish, range_bound]`). The calibrated
  fallback builder's DTE grid extends to LEAPS (180/270/365) so synthetic
  chains mirror the same two windows.
- **Canonical report store** (#308, #307): every generated report is stored
  once at generation into `mas_reports` (idempotent on generation id);
  UX, email, Slack, webhook, and HITL approval all deliver that single
  stored copy. Research-report dispatch stores first and fails closed if
  the store fails.
- **`POST /api/nlq/webhook`** (#313): the advertised `/api` spelling of the NLQ
  inbound webhook is now implemented. All three spellings — `/nlq/webhook`,
  `/api/trading/nlq/webhook`, `/api/nlq/webhook` — delegate to one single-owner
  handler (`handleNlqWebhookRequest` in `src/server.ts`), so the throttle,
  HMAC signature verification, replay protection, and NLQ forwarding behave
  identically for every spelling. Previously the advertised `/api` form 404'd.
- **Reports tab + schedule management UI** (#309): browse/search persisted
  reports and manage schedules from the UX, reading the same store.
- **AI Search result cache + scheduled-report persistence** (#278):
  TTL cache over AI Search results (scope-bound keys, hits audited); all
  scheduled-run reports (market screens, IV collection, retention runs)
  persist for later retrieval.
- **Report-dispatch HITL setting** (#277): Settings toggle
  `reportDispatchHitl` (default off — dispatch stays autonomous); when on,
  report email/webhook dispatch holds for approve/reject with a 24h
  pending window.
- **Advertised `POST /api/chat` route** (#312): the route the UX/docs
  advertised is implemented, delegating to the platform's canonical chat
  handler.
- **Documented `POST /api/chat` response contract** (#325): the endpoint
  catalog entry no longer advertises a streaming route — it documents the
  real synchronous response (`reply`, `route`, `model`, `streaming: false`)
  with a rendered sample in the API explorer, and
  `docs/async-capabilities.md` now lists the immediate-sync `/api/*`
  exceptions (chat included) instead of claiming every request returns
  `202`.
- **Judge + NLQ golden evaluation sets** (#258): 105 labeled judge-routing
  queries and 29 NLQ questions with accuracy/regression thresholds in CI.
- **Per-run PDF naming** (#297): screener PDFs are stored per run as
  `{screener}_{universe}_{schedule}_{timestamp}_{jobId}`.
- **Auto-tag every deploy** (#321): the deploy workflow tags each
  successful production deploy `v0.1.<patch>` (auto-incrementing),
  pointing at the deployed commit for rollback and release tracking;
  milestones bump minor/major manually.

- **Autonomous options research + trade-idea validation agent** (#319): a new
  `ResearchAgent` Durable Object runs a daily after-close pipeline (OODA loop
  with budget) — market regime, screened universe, live E*TRADE quotes and
  option chains, Yahoo technicals — and publishes a canonical report via the
  `options_research` seam into `mas_reports` (one stored copy; Reports tab and
  AI Search read it). Stage gates (§5) enforced as code with the spec's
  failure actions (data integrity → Unverified; contract/thesis/strategy/risk
  → Rejected with reason; soft quote-quality → Watchlist-only); every
  shortlisted idea carries the seven-question falsification (§4), a pre-mortem
  (§7), five scenario rows with fees/slippage/assignment limitations (§8), and
  an independently recomputed economics table (SDK-free Black-Scholes
  module — PMCC modeled on the long call's residual value; the
  width-minus-debit trap is pinned by test). Max 5 Qualified ideas;
  "No qualifying opportunities" is a valid published outcome. Filters and
  thresholds live in a typed config service (spec defaults as fallback) with a
  filter editor + run controls + trade-card view (`ResearchRunsPanel`);
  every run embeds its effective config snapshot; §9 evaluation replays later
  prices against the pinned stored record (versioned rules, no retrospective
  edits). Read-only: no order path exists from any research module (boundary
  test pins it). Routes: `POST /research/run`, `POST /research/scheduled-tick`
  (21:00 UTC weekdays via new wrangler cron), `GET /research/latest`,
  `GET /research/history`, `GET/POST /research/settings`, `POST
  /research/evaluate`.
- The options subtab gains an "Autonomous runs" toggle next to the existing
  per-symbol "Symbol research" view; manual and scheduled runs are thin
  triggers over the single pipeline entry and surface in the same views
  labeled by trigger source (manual | scheduled).

### Changed

- **Trading boundary** (#290): all trading code is imported solely through
  `src/trading/index.ts` (enforced by a boundary test); secret namespacing
  audited — trading secrets are read only inside `src/trading/`, with the
  `ET_*` convention documented in `docs/COMPLIANCE.md`.
- **Options scanner defaults** (#296): scans default to the NASDAQ-100
  universe instead of 4 symbols; scanner delivery tries the cfpay A2A
  Slack/Email path first with local fallback (#303).
- **Reports/Schedules panels wired into navigation** (#324): the #309
  panels are reachable from the app navigation (NavigationMenu +
  ETradeTradingHub) instead of existing as orphan surfaces.

### Security

- **Advertised `POST /api/audit/event` implemented** (#270): strict
  validation, tenant-scoped writes into `mas_events` via the single
  `recordAudit()` owner; the advertised surface is real, per the
  no-fabrication rule.
- **SECURITY.md + threat model** (#276): security policy, threat model,
  and disclaimer documents added.
- **NLQ execution observability** (#257): every NLQ execution writes a
  timed structured event (no raw query text); wrangler log observability
  made explicit.

### Fixed

- **Storage lifecycle** (#255): nightly retention pass enforces the
  advertised 90-day window on `mas_messages` (configurable, batched,
  audited per run).
- **Screener data quality** (#294, #295): E*TRADE quote failures fail fast
  on auth instead of returning zero-price stubs; Yahoo history fetch
  carries diagnostics so empty technicals are explainable.
- **Advertised E*TRADE routes** (#314): `POST /api/broker/etrade/environment`
  (the `ETradeDynamicMenu.tsx` fallback) delegates to the same single-owner
  environment-switch handler as `/api/environment/switch`, and the
  doc-advertised `POST /api/etrade/options/strategy` (Workflow A2) delegates
  to the same strategy-discovery handler as `/trading/options/recommend` —
  E*TRADE chain snapshot, screened contracts, and the real
  `recommendOptionStrategies` engine (Black-Scholes Greeks, model-implied
  POP, EV, payoff curves) with byte-identical responses across spellings.
  Also resolves leftover merge markers in this changelog from the #325
  rebase.

## [0.1.0] - 2026-10-18

First tagged release. Assessment P0 hardening wave (#143).

### Security

- **NLQ table allowlist** (#245): a 25-table allowlist derived from the NLQ
  planner's real targets; every other table is refused at the execution seam.
  Classic SQL injection was already closed by parameter binding — verified
  before the fix.
- **Webhook replay cache + `emailTo` domain allowlist** (#249): provider-derived
  nonces with 24h TTL; duplicate TradingView / E\*TRADE / NLQ deliveries are
  rejected 409 before any order mutation. `EMAIL_TO_ALLOWED_DOMAINS` restricts
  email delivery targets (inert until configured).
- **SSRF guard + rate limiting** (#242): URL validator on outbound webhook
  dispatch; token-bucket throttling (429 + Retry-After) on the NLQ webhooks and
  the memory search route.
- **Secret scanning** (#239, #251): gitleaks workflow installed and active;
  its pull-request scan path was broken by a missing `GITHUB_TOKEN` env and is
  now fixed — every PR is scanned.

### Added

- **Storage retention** (#262): nightly pass in the scheduler deleting
  `mas_messages` rows older than `MAS_MESSAGES_RETENTION_DAYS` (default 90,
  `<=0` disables), with a per-run cap and a `mas_events` summary record.
  This enforces the 90-day retention the UI advertises.

### Docs

- **Collaboration protocol** (#252): branch-as-lock shared rule for
  multi-agent coordination, documented in `docs/collaboration.md`.
