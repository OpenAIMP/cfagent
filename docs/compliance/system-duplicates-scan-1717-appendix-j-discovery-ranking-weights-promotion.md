# Scan appendix (j) — Discovery / ranking / weights / promotion remainders — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path. Coordinate with open #1257; do not compete
with it. #1640's gap is closed for production ranking; the D4 exception remains
a live second ordering semantic that any unification must preserve behind its
comparison-only scope.

## D1 — discoveryService: the remaining non-kernel discovery path — DIVERGENT

- (a) `src/services/discoveryService.ts` `runDiscovery()` /
  `createDiscoveryService()`: characterise → signals → thesis inference → fit
  gate (`resolveDiscoveryFitGate()` = scanner fit gate with discovery composite
  floor overlaid) → expression via injected panel pipeline → delta classification
  against the previous run for a `scopeKey` (deltas, `configHash` djb2 over
  discovery + fit-gate config, `profileBias` points added FOR PICK SELECTION ONLY).
  Live callers verified: `src/agents/orchestrator/asyncJobs.ts:973`
  (as `discoveryRunner` alongside `fitDiscoveryRunner`), `src/agents/routes/
  mcpChatNlq.ts:281`, `src/agents/routes/tradingIntegrations.ts:90`, and
  `UnifiedOptionsService` (`unifiedOptionsService.ts:591`). Alert dispatch is
  opt-in per caller (`discoveryAlerts.ts`).
- (b) Kernel fit path: `fitDiscoveryRunner.ts` → `RecommendationService.
  discoverForName/discoverNamesForStrategy` (kernel, with `CatalogFitBuilder`
  wrapping `researchDiscovery` candidates) → `kernelDiscoveryMapping.ts` back to
  `DiscoveryModeResult` (kernel tier wins; economics null stays null; source-less
  kernel candidates THROW rather than drop/fabricate; rejections merged,
  structure+reason duplicates de-duplicated).
- Deltas: (a) is scope/delta-oriented (runs, abstention stages prescreen/
  inference/expression, near-miss signals, alert dispatch); (b) is fit-oriented
  (bidirectional name↔strategy, falsification evidence, gate re-gate from the
  same provider session — a second fetch by design). Different request shapes
  (`DiscoveryRunRequest{symbols, scopeKey, source, caps, profileBias}` vs
  `DiscoveryModeRequest{direction, ...}`), different stores (discovery setup
  runs vs screening activity log), different ranking hooks (profile-bias points
  vs v2-weight multipliers, D3).
- Verdict: DIVERGENT — this is the principal remaining §1 overlap after #1639.
  The kernel did NOT absorb `discoveryService`; the two runners are even wired
  side-by-side in `asyncJobs.ts`.

## D2 — researchDiscovery as kernel source: layered, not parallel — IDENTICAL

- `researchDiscovery.ts` `discoverStrategiesForName()` /
  `discoverNamesForStrategy()` are called by the kernel's builders AND by
  `fitDiscoveryRunner.ts` as the pre-kernel discovery step (run once, then
  re-gated/ranked through the kernel). `runDiscoveryMode()` has NO direct
  production caller outside this chain on current main (grep: only
  `fitDiscoveryRunner` references + kernel internals). This is a layer
  (discovery → kernel gate/rank → mapping), not a second discovery engine —
  do NOT re-report `researchDiscovery` as a new duplicate. Its direct
  `runDiscoveryMode` entry is effectively orphaned behind the kernel path,
  which is a cleanup note, not a live race.

## D3 — Three weight-application semantics for ranking — DIVERGENT

- (a) Kernel `PassthroughWeightsRankDecorator` (`recommendationKernel.ts:945`):
  NO-OP without a weights function; with one, reorders WITHIN each status tier
  only (never across tiers) by `weightsFn` descending, reassigns ranks in tier
  order. No scaling, no sign guard.
- (b) `fitDiscoveryRunner.ts` `applyWeightsV2Ranking()` (flag-gated, default OFF
  per #17; flag `screening.weightsV2Ranking`): BOUNDED MULTIPLIERS on existing
  deterministic scores — strategy→names: `fitScore × w` (w = v2 weight for
  `strategy|regime`, default 1, keyed by `weightsV2Key()`); name→strategies:
  weight scales only NON-NEGATIVE scenario worst/mean cells (a negative cell is
  never improved by a weight), ordering is tier-first then worst then mean then
  structure. Notes are emitted per applied weight (`×w.toFixed(2)`).
- (c) `discoveryService` profile bias (`discoveryExpression.ts`): adds configured
  `points` to preferred types' composites FOR PICK SELECTION ONLY — recorded
  scores, roll-up, signals, and inference are unaffected (contrast (b), which
  rewrites the returned ranking order, and (a), which reorders within tier).
- Also live: `screenerResearch.ts` reselection reads v2 per-regime weights
  (W2), and `portfolioContextRanking.ts` `applyPortfolioContextRanking()` is a
  FOURTH reorder — a stable partition demoting flagged (already-held) symbols
  after unflagged ones, with an `applied` marker — but it is a portfolio-context
  modifier, not a weight system, so it is named here for completeness, not
  counted as a weight duplicate.

## D4 — LLM overlay: one enforced contract, one documented exception, plus prose — DIVERGENT (by exception)

- (a) `src/services/rankingCore.ts` (#1640, `annotateQuantRanking()`): the single
  enforced contract — takes an already quant-ranked list + LLM judgments and
  returns the SAME list (same order, length, entry references) with annotations
  attached; unknown-id judgments dropped, no-judgment candidates annotate null,
  first judgment for a duplicated id wins. Consumer verified: the E*TRADE
  options evaluate route (`etradeOptionsEvaluate.ts` → `rankings` field is the
  quant order annotated this way; the route's `answer` prose is the LLM's own
  top-3 list, explicitly labelled as LLM evaluation, NOT the ranking).
- (b) Kernel `LlmRankPolicy` / `LlmScorePolicy` (`recommendationKernel.ts:891,913`):
  REORDER by injected LLM order/scores (score = `length - position`, 0 for
  unranked; ties by tier then id). Documented in `rankingCore.ts` itself as the
  single exception: "llm/hybrid arm ONLY … orders an arm's own list inside a
  comparison run and never alters a production ranking".
- (c) `src/trading/options/llmComparison.ts` `rankCandidatesWithLlm()` +
  `src/services/strategyReviews.ts` (human review decisions recorded via
  `recordStrategyCandidates()`, used as ranking context in the evaluate route,
  #707): LLM judgment production + human-decision context, not a ranking
  policy — feeding (a), not competing with it.
- Verdict: DIVERGENT between (a) and (b) by design (the exception is the
  divergence); (c) is an input, not a ranker.

## DF — Fit gates: one gate function, kernel adapter — IDENTICAL

- `src/trading/options/opportunityScanner.ts` `evaluateFitGate()` (buckets
  `fit/borderline/no_fit`; thresholds inclusive; composite, POP, freshness,
  confidence, research-only blockers with the stale-quote-blocker nuance) is the
  single gate logic. `src/services/scannerFitGateHandler.ts`
  `OpportunityScannerFitHandler` is a chain ADAPTER over it (fit → no cap,
  borderline → cap `watchlist`, no_fit → cap `rejected`; caps only demote, kernel
  takes the most restrictive tier). `discoveryExpression.ts`
  `resolveDiscoveryFitGate()` only overlays the discovery composite floor onto
  the scanner gate params — it does not re-implement the gate.
  `src/services/researchGates.ts` (`gateDataIntegrity`, `gateContractIntegrity`,
  `gateQuoteQuality`, `gateStrategyIntegrity`, `gateRiskReview`,
  `gatePublication`, `runStageGates`) are DIFFERENT stage gates for the research
  pipeline (data/contract/quote/strategy/risk/publication), not a second fit
  gate — checked, not a duplicate.

## W1 — Strategy weights v1 vs v2: v2 is live, v1 adjustment is dormant — DIVERGENT (dormant)

- v1 `src/services/strategyWeights.ts` (#754): global (regime-blind) weights in
  `mas_strategy_weights`, bounds `[0.25, 2.0]`, step ≤ 0.10/run, min sample 20,
  deadband 0.02, round4, ISO-week guard (`WEIGHTS_LAST_RUN_WEEK_KEY`,
  `isoWeekKey()`), kill switch (#756) + budget/audit via `applyAdaptation` (#755),
  input = raw win-rate excess vs overall win rate.
- v2 `src/services/strategyWeightsV2.ts` (#1140, epic #1096 Ph5): regime-
  conditioned (`strategy|regime` keys, regimes bull/bear/chop/high_vol/unknown),
  AFTER-COST risk-adjusted (fee + slippage per contract /100 per share-unit,
  positive win-rate excess with non-positive after-cost R can never propose an
  increase), decay `0.5^(age/90d)` toward default 1.0, versioned append-only
  records in `mas_strategy_weights_v2` (before null = no row, #760 exact-restore
  semantics), same v1 bounds reused verbatim (`WEIGHTS_V2_DEFAULTS` reads
  `STRATEGY_WEIGHT_BOUNDS` — no second bounds regime), same #755 seam + kill
  switch. Actor `strategy-weight-v2-job` vs v1 `strategy-weight-job`.
- Live state verified (#1257 flip, `screenerResearch.ts:697,724`): GET
  `/adaptation/weights` returns v2 (collapsed + by-regime, `weightsSource:"v2"`,
  evaluation built by the v1 `buildWeightPolicyEvaluation()` fed the collapsed
  v2 map); POST `/adaptation/weights/run` runs v2 only, reusing v1's
  `isoWeekKey` + settings key (so one adjustment/week regardless of engine).
  NO live route or scheduled caller of v1 `runStrategyWeightAdjustment()` was
  found (only v1 constants/bounds/evaluation-builder imports remain, in
  `screenerResearch.ts`, `improvementCandidates.ts`, `stagedPromotion.ts`,
  and `strategyWeightsV2.ts` itself). The v1 store/table helpers still exist.
- Slice guidance: the remaining work is retirement, not a live race. Deleting v1
  outright would break v2's bounds import and the GET evaluation builder; those
  two imports are the coupling to unwind first. Retirement is gated under #1257's
  retirement PR (staged-promotion drain interplay), not decided here.

## W2 — v2 reads: per-regime vs collapsed-mean vs fit-keyed — DIVERGENT (read semantics)

- Same store `mas_strategy_weights_v2`, three reads:
  (a) `getStrategyWeightsV2()` — full `strategy|regime → weight` map;
  (b) `getStrategyWeightsV2ForRegime()` — one regime, plain strategy keys
  ("no other regime's value may leak");
  (c) `getStrategyWeightsV2Collapsed()` — MEAN across a strategy's regimes,
  documented as the regime-blind aggregate for legacy-shaped consumers (GET
  weights evaluation, candidate replay).
- Consequence: a strategy with regime weights {bull: 2.0, bear: 0.25} reads as
  1.125 collapsed, 2.0 under bull, 0.25 under bear — the same strategy ranks
  differently depending on which read the caller chose, and the collapsed mean
  can move a ranking that no single regime's evidence supports. This is
  documented behaviour (C5, #1361/#1257), not an accident, but it IS a contract
  divergence between readers of one store.

## P1 — Promotion: champion/challenger live, staged drain-only — DIVERGENT (drain era)

- Live (`src/agents/routes/screenerResearch.ts`, #1257): POST
  `/adaptation/promotions/start` REFUSES new staged promotions ("file a
  challenger … promote it through the champion/challenger gate");
  `/adaptation/promotions/promote|rollback` run `championChallenger.ts`
  `promoteChallenger()` / `rollbackChallengerPromotion()` (promoter must be the
  approver of record; refusal names the lock); GET `/adaptation/promotions`
  lists challenger records (`listPromotionRecords`, tenant-scoped);
  GET `/adaptation/promotions/active` still lists in-flight STAGED promotions.
- Drain (`src/services/stagedPromotion.ts`, #760 chain): `startPromotion()` has
  no live route caller left; `advancePromotion()` remains live ONLY for
  in-flight promotions (advance to completed or roll back on regression via
  the #755 seam). The module header's own retirement condition: delete when
  GET `promotions/active` is empty. Two record stores therefore coexist
  (`mas_promotions`-family vs challenger tables) with two GET shapes.
- `proposalChallengerBridge.ts` (`generateChallengersFromProposals()`,
  `buildEvaluationSpecs()`, `verdictReasons()`) is the bridge from old
  improvement-candidate proposals into challengers — a migration seam, not a
  third promotion engine.

## P2 — Candidate evaluation: four "evaluate" functions, four methods — DIVERGENT

- (a) `championChallenger.ts` `evaluateChallenger()`: walk-forward over a FROZEN
  evaluation dataset, split selection/holdout at ceil(half) (holdout = last
  half), scoring specs for champion vs challenger, edge = holdout challenger −
  champion score, verdict `pass` iff edge + `minEvaluated` met; quotes come
  from the frozen set (`source:"frozen-eval-set"`, `quoteStatus:"live"` — a
  labelled synthetic quote, not a live fetch).
- (b) `candidateEvaluation.ts` `evaluateCandidate()` / `replayCandidate()` /
  `isWinningIdea()`: track-record-window evaluation (evaluated/win-rate over an
  evaluation window), backing the old #760 chain; no live route caller found
  in this scan outside the staged/drain chain (cf. P1).
- (c) `promotionGate.ts` `runPromotionGate()`: held-out counterfactual-replay
  evaluation + two-proportion z-test (`GATE_POLICY.alpha`, min held-out sample)
  + INFORMED human approval (approved AFTER the held-out evaluation) before a
  candidate transitions to `gated`. No live route caller found in this scan
  (only a read reference in `src/agentic/chainGovernance.ts`); `runPromotionGate`
  is effectively dormant alongside (b).
- (d) `recommendationBundle.ts` internal `evaluateCandidate()` (same name,
  different module, NOT the same function): scenario-grid evaluation for bundle
  construction (expected P&L, CVaR-25 = mean of worst quartile of grid cells,
  worst P&L, P(profit)) — an optimizer input, not a promotion gate.
- Verdict: DIVERGENT — (a) is the live challenger method; (b)/(c) are dormant
  promotion-era methods; (d) is a namesake in a different domain. The (a)/(b)/
  (c) trio is the promotion-evaluation cleanup; (d) must NOT be merged into it.

## S3 — Panel agents vs kernel: delegation, not duplication — IDENTICAL (panel path)

- `src/trading/options/panelPipeline.ts` `runPanelPipeline()` /
  `runPanelWithAgents()`: verbatim-moved body of the retired `OptionsAgentPipeline`
  class, delegating to `RecommendationService.discoverPanel()` (kernel), then
  computing `ranked/riskReports/bestTrade` via the same three agents
  (`OptionsDataAgent`, `StrategyRiskAgent`, `RecommendationAgent`) over the
  kernel-passed candidates. Defaults shared: `balanced` profile, 3 alternatives.
- Caveat (not a new finding, a boundary): the agents remain directly
  constructible — the no-view scheduled path constructs the agents struct once
  and passes it to both `runPanelWithAgents` and agent methods — so the agent
  classes are a live seam, not dead code. The panel path itself is single.
