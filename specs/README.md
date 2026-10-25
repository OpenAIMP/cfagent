# Research pipeline SDD specs

Specification-driven-development artifacts for the autonomous options research
pipeline, per `docs/agents/product-architecture.md` §12 (feature spec template)
and §17 (repository structure). Part of #581; issue #582.

Source design doc: `docs/research/autonomous-options-research-pipeline.docx`
(spec #319, closed). Each FEAT below maps to docx sections and to the
implementation in `src/services/research*.ts` / `src/agents/research-agent.ts`.

## Traceability: docx § → FEAT → code

| docx § | FEAT | Implementation (verified 2026-10-20) |
|---|---|---|
| §1 GPS contract | FEAT-101, FEAT-105 | `researchConfig.ts`, `researchPipeline.ts` |
| §2 ARR autonomy/recurrence | FEAT-101 | `researchScheduleGuard.ts`, `researchTriggers.ts` |
| §3 OODA loop | FEAT-102 | `researchPipeline.ts` candidate loop |
| §4 Seven gates | FEAT-103 | `researchGates.ts` (`gateDataIntegrity` … `gatePublication`) |
| §5 Strategy map + PMCC | FEAT-104 | `researchEconomics.ts` (`pmccEconomics`) |
| §6 Research card/report | FEAT-105 | report types in `researchPipeline.ts`; canonical row in `mas_reports` (#308) |
| §7 Think wrapper + fallback | FEAT-106 | `src/agents/research-agent.ts` (`ResearchAgent extends Think`) |
| §8 Limits/safeguards | FEAT-101…104 | enforced in gates + config |
| §9 Outcome evaluation | FEAT-107 | `runResearchEvaluation` in `researchPipeline.ts` |

Out of scope for these specs (separate lanes): per-run PDF (#335) and scheduled
delivery (#336) — collaborator lane.

## Conventions

- Each FEAT directory holds `spec.md` (blueprint §12 template) and
  `acceptance.md` (Gherkin acceptance criteria) at minimum.
- "Verified" marks behavior confirmed in code on 2026-10-20; "specified"
  marks intended behavior from the docx not yet confirmed — never presented
  as implemented (blueprint §18).
- Requirement IDs use REQ-RES-###; tests TEST-RES-###; evaluations EVAL-RES-###.
