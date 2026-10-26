# Scan appendix (k) — Report generator remainders — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
Standing rules: NEVER EITHER/OR ALWAYS CONFIGURABLE; scoped defaults run >
session > user > global env > built-in (public route behavior); never remove an
endpoint; never delete a code path.

## Pipeline map (what #1641 actually unified)

- Single dispatch: `src/services/unifiedReportPipeline.ts` (`generateReportPdf` /
  `getReportFileName` — the ONE generator dispatch, consolidation C4 #1329;
  `generateReportStage` / `runReportPipeline` / `storeReportStage` /
  `serveReportStage`).
- Single generate owner: `src/agents/report-asset-agent.ts` (`ReportAssetAgent`,
  #680; `generatePdfAsset` is the single entry point; failure returns null, never
  throws; #1278 retry policy in the pipeline stage).
- Single blob seam: `src/services/reportBlobStore.ts` (`putReportPdf` /
  `getReportPdf`; R2 when `REPORTS_BUCKET` is bound, legacy DO-storage base64
  otherwise; key-family mapping `screener:` → `stocks/`, `options:` → `options/`,
  `goal_screen:` → `goals/`, `knowledge:` → `knowledge/`).
- Single canonical store + single semantic index: `src/services/scheduledReports.ts`
  (`storeReportAtGeneration`, idempotent on generation id, #308) wrapped by
  `src/orm/index.ts` (`storeCanonicalReport` — literally calls
  `storeReportAtGeneration`); `src/services/reportSemanticIndex.ts` (`indexReport`
  / `semanticSearchReports` / `mergeSearchHits`).
- Research publish (`src/agents/orchestrator/researchPublish.ts`, #992): single
  publish entry `runResearchAndPublish` — canonical store via
  `storeReportAtGeneration`, semantic index (best-effort), PDF via the unified
  pipeline's `generateReportStage` (#1641 fix: the old screener-else-options
  mapping that silently generated an OPTIONS pdf for research input is gone),
  delivery via `deliverResearchReport` (#336, Slack/email/webhook through the #308
  seams, HITL hold via report confirmations #277).

## R-1 — The three PDF renderers remain parallel generators — DIVERGENT (type-specific, not merged)

- Implementations: `src/trading/screenerReportPdf.ts` (`generateScreenerPdf`, 411
  lines, stock screens), `src/trading/optionsReportPdf.ts` (`generateOptionsPdf`,
  253 lines, options screens), `src/trading/researchReportPdf.ts`
  (`generateResearchPdf`, 361 lines, research runs). All are reached only through
  the single dispatch in `unifiedReportPipeline.ts` (verified: no direct
  generator call site remains outside the dispatch and the generator definitions
  themselves), so the ROUTING is unified — but the RENDERERS are three separate
  pdf-lib implementations with duplicated machinery (print palette #473, page
  helpers, glyph cleaning) and observable rendering deltas:
  - Margins: screener 36pt vs options/research 48pt.
  - Text layout: screener and research word-wrap; options `text()` truncates each
    string to 120 chars with no wrap.
  - Glyph cleaning: screener and options replace Δ/→/←/•/—/–/quotes (screener
    additionally ▲/▼); research `text()` performs no glyph replacement at all.
  - Content models differ by type (screener run vs option screen result vs ranked
    research report ≤5 qualified + watchlist + rejected-with-reasons), so a single
    merged renderer would be a redesign, not a dedup — recorded here as "parallel
    generators remain", not as "same contract, different answers".

## R-2 — Goal-screen artifacts bypass the unified pipeline entirely — DIVERGENT

- Implementations: `src/services/goalScreenReports.ts` (`generateGoalScreenPdf` /
  `generateGoalScreenXlsx` / `generateGoalScreenCsv`,
  `generateAndStoreGoalScreenArtifacts`) vs the unified pipeline +
  `ReportAssetAgent`.
- Deltas: goal-screen PDF is a fourth, self-contained pdf-lib renderer (own
  pagination at y<56, own 100-hit cap, own Yahoo-fallback provenance line #1571)
  called directly, never through `generatePdfAsset` / `generateReportStage`; keys
  live in their own family (`goal_screen:<format>:<uuid8>`, R2 `goals/`); failure
  contract is per-format `REPORT_001` with the run still succeeding (same error
  code as the pipeline, different orchestration — a per-format loop with the #1278
  retry policy, not the pipeline's generate stage). Blob store is shared
  (`putReportPdf`); everything above it is parallel. Its canonical-row write goes
  through `storeReportStage` in the scheduled path (see R-4), so the store leg is
  unified while the generate leg is not.

## R-3 — Tabular (XLSX/CSV) generation has two orchestration sites over the same generators — DIVERGENT

- Implementations: `src/agents/screener-agent.ts` (`generateAndStoreOptionsXlsx`,
  `generateAndStoreOptionsCsv`, screener XLSX inline in `persistRun`-adjacent
  code; per-run key + `latest` key, both `putReportPdf`) vs
  `src/services/shardExecutors.ts` (`generateTabular` shard: same
  `generateOptionsXlsx` / `generateScreenerXlsx` / `generateOptionsCsv` /
  `generateScreenerCsv` generators from `src/trading/`, same `putReportPdf` store,
  but single per-run key, explicit XLSX/CSV content types, and a store shard that
  verifies the blob reads back before writing the `mas_reports` row).
- The underlying tabular generators are shared (one XLSX/CSV implementation per
  type in `src/trading/screenerReportXlsx.ts`, `screenerReportCsv.ts`,
  `optionsReportXlsx.ts`); what is duplicated is the generate-and-store
  orchestration (key naming, latest-pointer writes, content-type handling,
  read-back verification). Goal-screen tabular generators
  (`generateGoalScreenXlsx/Csv`) are a third, type-specific set (see R-2), not
  shared with screener/options.

## R-4 — Canonical store — IDENTICAL

- `src/orm/index.ts` `storeCanonicalReport` is a direct wrapper over
  `src/services/scheduledReports.ts` `storeReportAtGeneration` (same function,
  same idempotency on generation id, same never-throws contract).
  `storeReportStage` (`unifiedReportPipeline.ts`) is a thin null-safe adapter
  over the same ORM method.
- Caveat (caller-level, not store divergence): generation ids are derived
  differently by callers — pipeline `type:trigger:timestamp`, report-dispatch
  `sha256Hex(bodyJson)` (via `storeResearchReportCanonicalAsync`), scheduled-report
  `generationIdOf(input)`. Two callers can therefore mint different generation ids
  for the same logical report and store two rows; the store itself cannot dedupe
  across id schemes. The R2-body variant (`storeReportAtGenerationWithR2`, body
  pointer vs inline body) is the same contract with a storage flip, not a second
  store.

## R-5 — Blob store — IDENTICAL

- One seam (`putReportPdf` / `getReportPdf`, `src/services/reportBlobStore.ts`)
  used by `ReportAssetAgent`, screener-agent, research-agent, goal-screen
  artifacts, shard executors, and the knowledge-corpus seam (`r2KeyForStorageKey`).
  R2-vs-DO fallback is inside the seam, not re-implemented per caller.
  Key-naming differences (per-run vs `latest` pointers, family prefixes) are
  caller key choices, not store divergence.

## R-6 — Semantic index — IDENTICAL

- One index path (`indexReport`, `src/services/reportSemanticIndex.ts`,
  best-effort, never fails the run) and one search path (`semanticSearchReports` /
  `mergeSearchHits`, served by `src/agents/routes/reports.ts`
  `GET /reports/semantic-search`). Research publish, and only research publish,
  was found indexing at generation; no second indexing pipeline was found.

## R-7 — Report-confirm delivery: canonical vs legacy paths inside one handler — DIVERGENT

- Implementation: `src/agents/routes/reports.ts` (`POST /trading/reports/confirm`,
  HITL release for report delivery). State machine is its own (pending →
  approved/rejected/expired; missing → 404, already-decided → 409, expired → 410
  with `research_report.confirmation_expired` audit, TTL via
  `reportConfirmationTtlMs()`), and it is NOT a mirror of `POST /payments/confirm`
  (different resource, different states, different outcomes: dispatch vs
  settlement).
- Internal divergence: approved confirmations branch three ways — (a)
  `kind: "screener"` resubmits a held follow-up delivery job (`submitFollowupDelivery`,
  audit `screener.followup_delivery_released`); (b) rows with `report_id` deliver
  the STORED canonical copy (email via `deliverStoredReportEmail`, webhook via
  `deliverStoredReportWebhook`, audits `research_report.emailed` /
  `research_report.webhook_dispatched` with `reportId`); (c) legacy pre-#308 rows
  deliver from the embedded `payload_json` (same audit names but with `fileName` /
  `sheets` count instead of `reportId`). Error mapping also differs by path
  (missing stored report → 500, email unavailable → 503, webhook not-configured →
  503 vs webhook failure → 502). The legacy path is a compatibility shim, not a
  second delivery system, but its audit payloads and error codes are observably
  different from the canonical path for the same approval.
- Slice guidance: the legacy path exists for pre-#308 rows; the slice must record
  whether its retirement is gated on those rows draining (like P1's drain
  condition in appendix (j)) rather than deleting the shim on a date.

## R07 — Routes-scan carry-over (resolved into R-1..R-7)

- `/screener/report.{pdf,xlsx,csv}`, `/options/report.{pdf,xlsx,csv}`,
  `/research/report.pdf`, `/screening/goal-screen/report.{pdf,xlsx,csv}`
  (`src/agents/routes/screenerResearch.ts`) vs `GET /reports` /
  `/reports/research/browse` / `/reports/semantic-search`
  (`src/agents/routes/reports.ts`) vs `agentdb.reports.list` (appendix (i) G04).
  Old doc §5 names four parallel PDF generators + `unifiedReportPipeline.ts`
  (#1209); the routes scan did not diff the generators, so no new verdict was
  claimed there — the item stays open, and is covered here by R-1..R-7 (not a
  separate pair). The old doc's "4 parallel generators" framing is outdated —
  the pipeline is no longer a fourth parallel generator; it is the single dispatch
  over three renderers plus one bypass (goal-screen).

## S1 — Two research-report engines — DIVERGENT (engine-level, not renderer-level)

- (a) `src/services/fossResearch.ts` `FossResearchService.generateResearchReport()`:
  single-symbol equity report from Yahoo fundamentals + quote + bars, DID
  attestation, served by REST `GET /foss/research` (audited) and MCP research
  commands. Provenance: Foss `live/cached` vocabulary.
- (b) `src/agents/research-agent.ts` `ResearchAgent` +
  `src/services/researchPipeline.ts` `runResearchPipeline()` /
  `runResearchEvaluation()`: the governed options-research OODA loop over
  `EtradeResearchDataProvider` (`researchProviders.ts`), with research
  settings/runs/evaluations tables, task ledger (#577), schedule guard, and
  stored PDF reports (`research:pdf:*`). Multi-leg strategy research, not a
  single-symbol equity report; provenance via research gates and evaluation
  datasets, not Foss provenance.
- Both are "research reports" with PDF/history surfaces, different inputs
  (symbol vs strategy/universe), engines, stores, and provenance vocabularies.
  No shared report builder was found between them. Do not merge naively: the
  slice must first decide (recorded) whether these are one capability with two
  engines or two capabilities sharing a word — the scan's evidence points to
  the latter for the research inputs, with the PDF/history surfaces as the
  shared seam (R-4/R-5/R-6).

## S2 — Goal/scenario screen: orchestration over the one pipeline, NOT a second engine — IDENTICAL

- `src/services/goalDrivenScreen.ts` (`buildGoalScreenPlan()`,
  `runGoalDrivenScreenWithLedger()`): plan + ledger orchestration ONLY — it states
  "there is no second screening implementation here", executes through the Phase 0
  `ScreeningProviderRegistry` (appendix (e) M12's pipeline), and mirrors the
  screener task ledger for idempotency/heartbeat/escalation.
  `goalScenarioEngine.ts` supplies the scenario/taxonomy language (goal kinds,
  outlooks, DTE/liquidity constraints), not a competing screener. The ResearchAgent
  goal-discovery tool (`research-agent.ts` `run_goal_discovery`) produces PROPOSED
  goals/scenarios for human confirmation — a different stage (discovery of goals)
  from screening against them.
