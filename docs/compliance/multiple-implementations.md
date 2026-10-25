Codebase Architectural Review: Domains and Capabilities with Multiple Implementations
Based on a thorough review of the codebase, source modules, and architectural design records (specifically docs/architecture/recommendation-engine-rationalization.md, docs/architecture/application/screener.md, and docs/architecture/application/api-mcp.md), here is a detailed breakdown of all functional domains and capabilities that currently have more than one implementation or parallel pipelines in the system.

1. Strategy Discovery & Options Recommendation Engines
Count: 6 Server Engines + 1 Client Modeling Layer + 1 LLM Generation Path

#	Implementation / Module	Location	Callers / Production Context	Status & Target Architecture
D1	runPanelPipeline / OptionsAgentPipeline	src/trading/options/panelPipeline.ts (131 LOC)	POST /api/trading/options/strategies, /best-trade, scheduled strategy_discovery	Kernel panel configuration wrapper.
D2	strategyEngine	src/trading/options/strategyEngine.ts (1,373 LOC)	Called via StrategyRiskAgent for view & no-view strategy recommendations	Candidate-construction core under D1; contains 2 scoring variants in one module.
D3	discoveryService + discovery subsystem	src/services/discoveryService.ts (475 LOC) + related store/expression files	Injected as discoveryRunner for async jobs & NLQ	Second parallel discovery path (characterize → signals → thesis inference → fit gate → deltas).
D4	researchDiscovery	src/services/researchDiscovery.ts (899 LOC)	NLQ options_fit_discovery via fitDiscoveryRunner	Third discovery path / second NLQ path (the governed research pipeline).
D5	UnifiedOptionsService	src/trading/options/unifiedOptionsService.ts (1,419 LOC)	Orchestrator, NLQ execution, scheduled callbacks, ScannerPanel	Facade consolidating call sites but holding duplicate engine wrappers beneath it.
D6	goalScenarioEngine discovery	src/services/goalScenarioEngine.ts	Research agent runDiscovery	Discovers goals/scenarios, distinct from strategy engines.
D7	strategyDiscoveryEngine (Client)	src/client/options/strategyDiscoveryEngine.ts (942 LOC)	Client Strategy Discovery Panel	Thin-client interactive modeling layer (not an engine of record).
D8	llmIdeas	src/trading/options/llmIdeas.ts (825 LOC)	LLM options candidate generation	First-class LLM strategy candidate generator, rationalized in kernel target as LlmIdeaBuilder.
2. Recommendation Ranking & Scoring
Count: 3 Quant Rankers + 1 LLM Overlay + 1 Internal Optimizer

#	Implementation / Module	Location	Details / Differences
R1	RecommendationAgent	src/trading/options/recommendationAgent.ts (270 LOC)	"Best Trade" picker v1; risk-profile composite re-ranker inside D1 pipeline.
R2	OpportunityScanner	src/trading/options/opportunityScanner.ts (1,254 LOC)	Cross-symbol scanner with its own fit gate (evaluateFitGate) and per-name-best ranking (v1.2.0).
R3	llmComparison & strategyReviews	src/trading/options/llmComparison.ts (239 LOC) & src/services/strategyReviews.ts (87 LOC)	LLM judge overlay evaluating quant-verified candidates (annotates, never overwrites quant ranking).
R4	Internal CVaR Optimizer	src/services/recommendationBundle.ts (754 LOC)	Optimization and CVaR-25 alternative ranking embedded within the recommendation bundle.
3. Strategy Weighting Systems
Count: 2 Parallel Systems

#	Implementation / Module	Location	Details / Differences
W1	strategyWeights (v1)	src/services/strategyWeights.ts (280 LOC)	Older weight system backing /adaptation/weights/run and read by strategy bank reselection. Stores in mas_strategy_weights.
W2	strategyWeightsV2	src/services/strategyWeightsV2.ts (737 LOC)	Regime-conditioned, after-cost strategy weighting system executed via tick job runWeightsV2Adjustment.
4. Promotion & Self-Modification (RSI) Pipelines
Count: 2 Parallel Engines (1 Live, 1 Dormant)

#	Implementation / Module	Location	Details / Differences
P1	Promotion Pipeline v1	src/services/candidateEvaluation.ts (275 LOC), promotionGate.ts (428 LOC), stagedPromotion.ts (576 LOC)	Active RSI self-modification pipeline backing /adaptation/candidates/* and /adaptation/promotions/* routes.
P2	championChallenger	src/services/championChallenger.ts (905 LOC)	Stronger governed promotion model (prohibits self-promotion, requires human approval record, reversible). Currently dormant with no production mutation callers.
5. Report & PDF Generation Generators
Count: 4 Parallel PDF/Export Generators

#	Implementation / Module	Location	Details / Target Consolidation
PDF1	screenerReportPdf.ts	src/trading/screenerReportPdf.ts (411 LOC)	Dedicated PDF layout generator for stock screening runs.
PDF2	optionsReportPdf.ts	src/trading/optionsReportPdf.ts (253 LOC)	Dedicated PDF layout generator for options screening runs.
PDF3	researchReportPdf.ts	src/trading/researchReportPdf.ts (361 LOC)	Dedicated PDF layout generator for AI/FOSS research reports.
PDF4	unifiedReportPipeline.ts	src/services/unifiedReportPipeline.ts	Target consolidation pipeline (#1209) unifying asset report generation, blob storage (reportBlobStore.ts), and semantic indexing (reportSemanticIndex.ts).
6. Portfolio Repair & Algebra
Count: 2 Implementations at Different Structural Levels

#	Implementation / Module	Location	Level & Context
PR1	repairProposals	src/services/repairProposals.ts	Position-level 1x2 ratio repair proposals for underwater long stock.
PR2	Composition Repair Operators	src/services/strategyComposition.ts	Structural leg-graph repair algebra (e.g., repairVerticalToButterfly).
7. Market Data & Quote Provider Routes
Count: Multiple Overlapping Endpoints & Provider Logic

HTTP & WebSocket Quote Routes: Duplicated quote endpoints (/api/market/quotes, /api/foss/quotes, /api/trading/etrade/quotes) and WebSocket handlers spanning E*TRADE (src/trading/etrade/), Yahoo Finance (src/trading/dataProviders/), and Alpaca (src/trading/alpaca/).
Target Architecture: Consolidation under a provider-agnostic MarketDataService facade with 1-minute TTL quote caching (quote_cache.ts) across stock and options screeners.
8. REST Routes vs. MCP Commands
Count: 2 Duplicated Interface Layers

REST Handlers (src/agents/routes/): REST routes re-implement domain logic and parameter validation.
MCP Tool Commands (src/mcp/commands.ts): MCP JSON-RPC handlers duplicate business logic found in REST API routes.
Target Architecture: Refactoring REST API handlers to call reusable IMcpToolCommand execution methods directly, eliminating duplicate protocol adapters.
Summary of Consolidation Plan (Phase 0 / Epics #1151, #1256, #1257, #1209)
Discovery & Recommendation Kernel (GoF Strategy/Template Method): Unifies D1–D4 into a single RecommendationService facade over an EvaluateGateRankPipeline template method with pluggable CandidateBuilder strategies (including LlmIdeaBuilder).
Unified Weights & Promotion: Retires v1 weights and v1 promotion in favor of strategyWeightsV2 and championChallenger governance.
Unified Report Pipeline (#1209): Consolidates screenerReportPdf, optionsReportPdf, and researchReportPdf into unifiedReportPipeline.ts.
