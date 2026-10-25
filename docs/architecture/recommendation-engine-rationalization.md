# Engine rationalization — inventory + pattern-oriented target architecture

**Status date:** 2026-10-23
**Tracking:** epic [#1151](https://github.com/OpenAIMP/cfagent/issues/1151) · implementation [#1256](https://github.com/OpenAIMP/cfagent/issues/1256) (discovery-engine rationalization — C4 core) · [#1257](https://github.com/OpenAIMP/cfagent/issues/1257) (recommendation-family rationalization — C4/C5 window) · landed by [#1261](https://github.com/OpenAIMP/cfagent/issues/1261)
**Filed by:** #COO-spr9
**Companion document:** [System overview](business/system-overview.md) (`docs/architecture/business/system-overview.md`) — what the screening program is building, how it integrates, and what it enables; this document is the engine-level design record beneath it.
**Provenance:** first posted as [epic #1151 comment 6375867524](https://github.com/OpenAIMP/cfagent/issues/1151#issuecomment-6375867524); the owner correction of record for `llmIdeas` is [comment 6376050382](https://github.com/OpenAIMP/cfagent/issues/1151#issuecomment-6376050382) and the 3-way comparison design amendment (§4) is [comment 6376168666](https://github.com/OpenAIMP/cfagent/issues/1151#issuecomment-6376168666) — both incorporated in the text below.

---

Owner directive (2026-10-23): rationalize the duplicated engines in the recommendation space — starting with the two discovery engines — with a true pattern-oriented implementation (GoF, GRASP, SOLID). This document is the evidence inventory on current `main` (post-C1, HEAD `02411b4`) and the target architecture. Implementation is filed as sub-issues (linked below), sequenced in the C4/C5 window. **No implementation in this step.**

Method: every engine below was grep-verified for production callers (static + dynamic imports) vs test-only reachability.

> **CORRECTION OF RECORD (2026-10-23, owner direction — see epic #1151 comment 6376050382):** the `llmIdeas` verdict in §1(a) below ("retirement candidate") is **withdrawn**. `llmIdeas` is a permanent, first-class LLM candidate-generation path — the paradigm split is quant vs LLM, and LLM generation on its own is first-class. The `@deprecated` code marker does not reflect owner direction and is flagged for removal in #1256/#1257. §2 is amended: `llmIdeas` becomes the **`LlmIdeaBuilder`** CandidateBuilder Strategy in the kernel, under the same gates/pricing/falsification/ranking as the quant builders, with provenance labeled `llm`/`quant`/`composed`; `llmComparison`/`strategyReviews` remain the annotation Decorator (generation ≠ annotation; neither absorbs the other). The corrected row and architecture text below incorporate this amendment.

## 1. Inventory

### (a) Discovery — 6 server engines + 1 client modeling layer

| # | Engine | Location | Origin | Production callers / consumers | Verdict |
|---|---|---|---|---|---|
| D1 | `OptionsAgentPipeline` | `src/trading/options/index.ts` (composes OptionsDataAgent → StrategyRiskAgent → RecommendationAgent) | #29 | `POST /api/trading/options/strategies` + `/best-trade` (routes/etradeOptions.ts); scheduled `strategy_discovery` jobs (scheduledTasks.ts — "the same OptionsAgentPipeline the interactive [panel uses]"); UnifiedOptionsService | Alive. The panel's engine. |
| D2 | `strategyEngine` | `src/trading/options/strategyEngine.ts` (1,373 LOC) + `strategies/{registry,catalog,legs,template}` | #29 era | Via StrategyRiskAgent: `recommendOptionStrategies` (view) + `recommendNoViewStrategies` (no-view) — two scoring variants in one module | Alive. Candidate-construction core under D1. |
| D3 | `discoveryService` + discovery subsystem | `src/services/discoveryService.ts` (421 LOC); `src/trading/options/discovery{Derivation,Inference,Signals,Expression,Delta}.ts`, `discovery{Run,Setup,Alert}Store.ts`, `src/services/discoveryAlerts.ts` | #14, #16, #18 | NLQ: injected as `discoveryRunner` in asyncJobs.ts + mcpChatNlq.ts. Universe scan: characterize → signals → thesis inference → D1 pipeline → fit gate → deltas/alerts | Alive. **Second NLQ discovery path.** |
| D4 | `researchDiscovery` (researchPipeline mode) | `src/services/researchDiscovery.ts` (797 LOC) | #1114 (P2) | NLQ `options_fit_discovery` via fitDiscoveryRunner (#1162); screeningDelivery. Bidirectional Name↔Strategy on researchPipeline/researchGates/researchEconomics/strategyComposition | Alive. **Third discovery path / second NLQ path.** The governed one. |
| D5 | `UnifiedOptionsService` | `src/trading/options/unifiedOptionsService.ts` (1,407 LOC) | consolidation-era | Orchestrator, NLQ execution, scheduled callbacks, ScannerPanel | Alive. A Facade that consolidated *call sites* but not the engines beneath it (wraps D1 + OpportunityScanner + LLM compare). |
| D6 | `goalScenarioEngine` discovery | `src/services/goalScenarioEngine.ts` — `discoverGoalsFrom{Portfolio,Regime,Events}`, `runGoalScenarioDiscovery` | #1107 (P1) | research-agent `runDiscovery` (scheduled/tick); persists proposed-only goals | **Adjacent — discovers GOALS, not strategies.** Keep distinct. |
| D7 | client `strategyDiscoveryEngine` | `src/client/options/strategyDiscoveryEngine.ts` (942 LOC) | pre-#29 | StrategyDiscoveryPanel Builder view + calibrated/demo path | By design (post-#29 thin-client correction): the Builder's interactive modeling layer, **not** an engine of record. Keep, bounded. |
| — | `llmIdeas` | `src/trading/options/llmIdeas.ts` (818 LOC) | pre-#29 | Independent LLM strategy generation over raw chains (`generateRawOptionsIdeas`, `generateRawOptionsIdeasRanking`); header says `@deprecated` (#29) and its generation entry points currently have no production caller (#29/#47 rerouted the endpoint + unified-service action to the compare pattern), but the module is intact, fully tested, config-live (token budget), and its client panel still ships. **Owner correction 2026-10-23: permanent, first-class — never deprecated** (see correction note above). | **First-class LLM generation path** — rationalized as the kernel's `LlmIdeaBuilder` CandidateBuilder (see §2). NOT a retirement candidate. |

### (b) Strategy recommendation / ranking — 5 rankers, 2 weight systems, 2 promotion pipelines

| # | Engine | Location | Origin | Callers | Verdict |
|---|---|---|---|---|---|
| R1 | `RecommendationAgent` ("Best Trade" picker v1) | `src/trading/options/recommendationAgent.ts` | "Capability 3" era | Inside D1; panel route, `/best-trade`, scheduled discovery, D5 | Alive. Risk-profile composite re-rank + best pick. **Layered predecessor of the bundle's ranking.** |
| R2 | `OpportunityScanner` | `src/trading/options/opportunityScanner.ts` (1,102 LOC) | ETAPI era | `UnifiedOptionsService.scanOpportunities`; autonomous scheduled options analysis | Alive. Cross-symbol scan with its **own fit gate** (`evaluateFitGate`) and per-name-best ranking (SCAN_MODEL_VERSION 1.2.0). Parallel ranking to R1. |
| R3 | `llmComparison` + `strategyReviews` | `src/trading/options/llmComparison.ts`; `src/services/strategyReviews.ts` | #47 compare pattern; #653 | Unified service `llm_evaluate`; routes/etradeOptionsEvaluate.ts (records reviews) | Alive. LLM judges quant-verified candidates, never overwrites quant ranking. A ranking **overlay**, distinct responsibility. |
| R4 | CVaR optimizer + alternatives ranking | inside `recommendationBundle.ts` | #1135 (P4) | Bundle route | Alive. Third ranking implementation (see B1). |
| R5 | `strategyWeights` (v1) | `src/services/strategyWeights.ts` (280 LOC) | #754 | `/adaptation/weights/run` route; read by strategyBankReselection | Alive. Store `mas_strategy_weights`. |
| R6 | `strategyWeightsV2` | `src/services/strategyWeightsV2.ts` (694 LOC) | #1140 (P5) | Tick job `runWeightsV2Adjustment` (screenerResearch.ts); ranking consumer fitDiscoveryRunner behind `screening.weightsV2Ranking` (default off) | Alive. Regime-conditioned, after-cost. **Parallel weight system to R5** — different store, different consumers, no shared contract. |
| R7a | Promotion pipeline v1: `improvementCandidates` → `candidateEvaluation` → `promotionGate` → `stagedPromotion` (+ `strategyPolicyState`, `adaptationAudit`) | `src/services/` | #757→#758→#759→#760 | Live `/adaptation/candidates/*` + `/adaptation/promotions/*` routes (screenerResearch.ts, dynamic imports) | Alive. The RSI self-modification pipeline. |
| R7b | `championChallenger` | `src/services/championChallenger.ts` (851 LOC) | #1140 (P5) | **No production callers** for create/evaluate/promote — only `ensureChallengerTables` via screeningActivity; rest is test-only | **Dormant true duplicate** of R7a's responsibility, with stronger governance (no self-promotion, approval record, reversible). |
| — | `strategyBankReselection` | `src/services/strategyBankReselection.ts` | #1122 (P3) | Scheduled tick (screenerResearch.ts); proposals only | Alive; consumer of R5 weights — must be re-pointed in any weights unification. |

### (c) Portfolio repair — 2 engines at 2 levels

| # | Engine | Location | Origin | Callers | Verdict |
|---|---|---|---|---|---|
| P1 | `repairProposals` — 1×2 call-ratio repair for underwater long stock | `src/services/repairProposals.ts` (405 LOC) | #355 | Bundle route (etradeBroker.ts, embedded), client portfolioRiskApi | Alive. Position-level repair **proposals**. |
| P2 | Composition repair/roll operators (`repairVerticalToButterfly`, …) | `src/services/strategyComposition.ts` | #1114 (P2) | researchDiscovery; bundle via `CompositionRepairInput` | Alive. Structure-level repair **algebra**. Same concept, different level — poorly factored boundary, not a true duplicate. |

### (d) Portfolio hedging — 1 engine

| # | Engine | Location | Origin | Callers | Verdict |
|---|---|---|---|---|---|
| H1 | `hedgeProposals` — beta-weighted-Δ SPY hedge sizing; `buildHedgeProposals`, `generateHedgeProposals`, `selectSpyPut`, `resolveSpyPutContract` | `src/services/hedgeProposals.ts` (356 LOC) | #54 (epic #32) | Bundle, hedge route (etradeBroker.ts), orchestrator, portfolioRiskApi | Alive. **Sole hedge-policy engine** — no duplicate. (Composition's overlay operator can *construct* hedge structures but holds no hedge policy.) |

### (e) Bundling / optimization — 1 bundle engine + 4 composed components

| # | Engine | Location | Origin | Verdict |
|---|---|---|---|---|
| B1 | `recommendationBundle` — trade + falsification + post-trade Greeks + **internal CVaR-25 optimizer** + sizing + hedge/repair options + ranked alternatives incl. no-trade | `src/services/recommendationBundle.ts` (760 LOC) | #1135 (P4) | Alive, **sole bundle implementation**. But it is a god-module: assembly + optimization + ranking in one file. |
| B2 | `portfolioRisk` — book Greeks aggregation + post-trade totals | `src/services/portfolioRisk.ts` | #34 (G1) | Component/foundation. Keep. |
| B3 | `positionSizing` — 4-constraint sizing, `SIZING_POLICY` | `src/services/positionSizing.ts` | #36 (G3) | Component. Keep. |
| B4 | `portfolioConcentration` — concentration evidence | `src/services/portfolioConcentration.ts` | #35 | Component. Keep. |
| B5 | client `riskManagementEngine` | `src/client/options/riskManagementEngine.ts` | client era | Display-layer risk anatomy/playbooks (hubs + panels). Distinct (presentation); **not** an engine of record. Note: B3's header records it replaced this anatomy's NAV-band heuristic server-side — the client copy remains for display only. |

### (f) Foundations — preserve, do NOT merge
`researchEconomics`, `researchGates`, `researchFalsification`, `researchPipeline` core, `researchProviders`, `researchTrackRecord`, `goalScenarioStore`, `screeningDelivery`, `betaService`, `correlationService`. (`riskPolicyEngine` is the autopilot order-path envelope — out of scope.)

**Counts:** Discovery 6 server + 1 client · Ranking 3 quant rankers + 1 LLM overlay + 1 bundle-internal optimizer · Weights 2 · Promotion 2 (1 dormant) · Repair 2 · Hedge 1 · Bundle 1 (+4 components). **≈17 engine modules** where the target needs **one kernel with pluggable policies**.

**Ownership flags:** none of these engines belong to the #1173 lane (its scope is session/delivery trust) — but `etradeBroker.ts`/`screenerResearch.ts` are shared route files; migration PRs must sequence around active lanes there. The v1 adaptation stack (R5/R7a) is the older RSI program's (#754–#760); it is *live via routes*, so retirement is a migration, not a deletion.

## 2. Target architecture — one Recommendation Kernel, pattern-oriented

Host: `src/services/` (server). The trading/options tree keeps market-structure construction as kernel strategies.

- **Facade (GoF) + Controller (GRASP)** — `RecommendationService`: the single entry for the panel route, NLQ, scheduled jobs, and the bundle route. D5 showed a facade over un-rationalized engines doesn't consolidate anything; this facade hides ONE pipeline.
- **Template Method (GoF)** — `EvaluateGateRankPipeline` skeleton: `loadSnapshot → buildCandidates → gate → price → rank → falsify → assemble`. D1, D3, D4 become three *configurations* of this skeleton, not three pipelines.
- **Chain of Responsibility (GoF)** — the gate stage: `researchGates` handlers + scanner fit gate + discovery fit gate as handlers over one candidate contract (today: three fit/gate implementations — D3's, R2's, researchGates).
- **Strategy (GoF) + OCP (SOLID)** — pluggable policies, registered, never edited into the kernel:
  - `CandidateBuilder`: ViewStructureBuilder (D2 view), NoViewStructureBuilder (D2 no-view), ComposedStructureBuilder (strategyComposition), CatalogFitBuilder (D4 name→strategies), **`LlmIdeaBuilder` (llmIdeas — first-class LLM generation; owner correction 2026-10-23)**. Every builder emits the same candidate contract (Composite leg-graph + rationale + provenance labeled `llm` vs `quant` vs `composed`). LlmIdeaBuilder's LLM disciplines live inside the strategy: per-run budget caps (LLM spend guard, generalizing its existing token budget), structured-output validation, prompt-injection resistance for retrieved content, model + temperature recorded in provenance — so the outcome ledger can score quant vs LLM honestly over time. LLM candidates get **no downstream bypass**: same gate chain, same researchEconomics pricing, same falsification requirement, same ranking and bundle assembly; unpriceable/unfalsifiable LLM ideas land Unqualified/Unverified.
  - `RankingPolicy`: RiskProfileComposite (R1), PerNameBestFit (R2), ScenarioGridRank (D4/P1 grid). `WeightsAdjustedRank` is a **Decorator** applying v2 weights within-tier only. R3 LLM compare is a second **Decorator**: annotates, never reorders (formalizes the #47 rule). Generation (llmIdeas, CandidateBuilder) and annotation (llmComparison/strategyReviews, Decorator) are distinct roles — neither absorbs the other.
  - `HedgePolicy`: SpyDeltaHedge (H1) — sole survivor. `RepairPolicy`: RatioRepair (P1) + CompositionRepair (P2) over one proposal contract.
- **Composite (GoF)** — strategyComposition's leg-graph is THE structure representation. D2's `StrategyCandidate` is adapted into it via an **Adapter** during migration, then retired.
- **Builder (GoF) + SRP (SOLID)** — `BundleBuilder` (from B1): steps trade / falsification / post-trade risk (B2) / sizing (B3) / concentration (B4) / hedge / repair / alternatives. The CVaR optimizer is extracted to `CvarOptimizer` — B1's ranking/optimization leaves the assembler.
- **Abstract Factory (GoF) + Protected Variations (GRASP)** — per-asset-class construction (options factory today; stock-leg factory stays Unverified until an options-grade pricing core exists) behind the existing provider seams (`ResearchDataProvider`, ScreeningProvider) — engines depend on abstractions, never concrete broker clients (**DIP**).
- **Weights & promotion — ONE system (GRASP: Pure Fabrication + Indirection)**: survivor = **R6 v2 weights + R7b championChallenger governance** (regime/after-cost, #755 seam, kill switch, no self-promotion, human approval record, reversible). The live `/adaptation/*` route surface is re-pointed onto this core (routes are the indirection layer — clients don't change); R5 + R7a retire after migration; strategyBankReselection re-points to v2 weights.
- **Discovery survivor**: the **researchPipeline-hosted discovery (D4) generalized as the kernel's discovery configuration** — it alone sits on the governed foundations (gates/economics/falsification/track record). D1/D2's battle-tested construction survives *inside* it as CandidateBuilder strategies. D3's characterization/signals/inference becomes a `CandidateSource` feeding the same pipeline (its universe-scan is an input mode, not a pipeline). **Migration shape: route compatibility preserved** — `POST /api/trading/options/strategies` keeps its contract, re-implemented on the kernel; NLQ keeps one discovery action (fit discovery); scheduled `strategy_discovery` calls the kernel facade. Client D7 stays as Builder modeling (Pure Fabrication for interactivity), explicitly not an engine of record; `serverDiscovery.ts` becomes the kernel's single client adapter.
- **GRASP justifications, per consolidation**: Information Expert — pricing/gating stay with researchEconomics/researchGates (they hold the data); Low Coupling/High Cohesion — one candidate contract (leg-graph) ends the D2↔D4↔bundle type mirroring; Polymorphism — ranking/hedge/repair variation moves from conditionals + parallel modules into policy classes; Creator — the Abstract Factory owns engine construction so routes stop hand-wiring pipelines (cf. scheduledTasks constructing D1 in 4 places).
- **Invariants the architecture must preserve** (non-negotiable, pinned by tests): Unverified never fabricated (missing component = ABSENT, excluded — D4's rule, generalized); a bundle without falsification is Unqualified/LOW; channels draft-only, execution only via the HITL order-preview flow; no self-promotion — promotion requires an authorized human approval record; qualified-partial honesty on bounded scans (#1204 contract).

## 3. Filed implementation work (sequenced, not started)

- **Discovery-engine rationalization** — **#1256**; this is **C4's core**.
- **Recommendation-family rationalization** (rank/weights/promotion/repair/hedge/bundle) — **#1257**. It exceeds a C4 footnote: two live weight systems, a dormant duplicate promotion engine, and a god-module bundle span C4+C5. Filed separately with that reasoning stated, sequenced in the same C4/C5 window after the discovery sub-issue.

Both are claimed as sequenced work (after C2/C3). Nothing here starts until its slice window opens.

## 4. Design amendment — 3-way comparison option (owner direction, 2026-10-23)

Posted on epic #1151 as comment 6376168666; scope note on #1257 (comment 6376172188); taxonomy note on #1256 (comment 6376173476). Design + tracking only.

A **comparison run** — a run mode of the Recommendation Kernel, like a screen run — executes three end-to-end recommendation **arms** over the **same** snapshot, universe, and context. The arms differ **only** in who generates and who scores/ranks:

| Arm | Generates | Scores / ranks |
|---|---|---|
| `llm` | LLM — `LlmIdeaBuilder` (`llmIdeas`; no quant inputs, by design) | LLM — llmIdeas' own map-reduce ranking, as that arm's RankingPolicy |
| `quant` | Quant CandidateBuilders | Quant RankingPolicy |
| `hybrid` | Quant CandidateBuilders | LLM scoring (`llmComparison` machinery) supplies the ranking signal for this arm's list — the owner's "quant generated recommendation scoring by llm" |

**Naming ruling (prevents taxonomy collision):** arms are labeled by **generator × scorer** — `llm`, `quant`, `hybrid`. **`composed` is NOT an arm.** It remains a quant builder technique (strategyComposition's leg-graph algebra, `ComposedStructureBuilder`) and a candidate **provenance** value (`llm` / `quant` / `composed`). An arm is a pipeline configuration; provenance is a property of a candidate. The two taxonomies must not be conflated.

**Invariants (non-negotiable):**
- All three arms pass the **same** gate chain (Chain of Responsibility / researchGates), the **same** researchEconomics pricing, the **same** falsification requirement, and the **same** BundleBuilder assembly. An arm changes generation and scoring — never the honesty machinery.
- **Per-arm attrition is reported, never hidden:** candidates generated → gate-passed → priced → falsified → ranked, per arm, in the comparison artifact.
- Nothing from any arm reaches a user as a recommendation except through the kernel's normal qualification — Unqualified/Unverified where earned, per arm, exactly as in production runs.
- **The hybrid carve-out is bounded:** the hybrid arm's LLM scoring orders **that arm's comparison list only**. It does not alter the production quant ranking — the annotate-never-reorder rule for production surfaces stands. The comparison surface is where LLM scoring is allowed to order, precisely so its effect is measurable rather than assumed.
- **Cost discipline:** one comparison run = three arms, each under its own budget guard — including the LLM token budget, which binds on two arms (`llm`, `hybrid`).
- Draft-only, like every kernel surface: comparison output is analysis, never execution.

**Outputs:** one comparison artifact per run — three provenance-labeled ranked lists (one per arm; each candidate carrying candidate-level provenance), overlap/divergence analysis (structures chosen by multiple arms vs arm-unique picks), and per-arm gate/economics statistics.

**Outcomes — evidence, not assertion:** every arm's recommendations are written to the outcome ledger with **arm provenance** (`llm` / `quant` / `hybrid`), alongside candidate provenance. Arms accumulate comparable track records and can later be evaluated champion/challenger-style — on frozen evaluation sets and on live outcomes — under the same governance as any promotion. No winner is declared by assertion.

**Placement:** a kernel run mode, surfaced via the same surfaces as other runs (the C2 hub + NLQ), the comparison artifact rendered like a run report. Sequencing: the comparison belongs to the recommendation-family rationalization (#1257), delivery riding with the kernel in the C4/C5 window; #1256's taxonomy gains the LLM-scoring RankingPolicy the hybrid arm uses (`LlmIdeaBuilder` already in #1256's scope).
