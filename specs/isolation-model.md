# Research pipeline isolation model (#584)

Part of #581. Documents the tenant-isolation posture of the research pipeline
as audited 2026-10-20 (blueprint EP-003, EP-009).

## Findings

| Layer | Posture |
|---|---|
| ResearchAgent DO storage (`research_runs`, `research_evaluations`, task ledger) | Per-user: DO id is `research:<login>` — one isolate per user. Cross-user reads impossible by construction. |
| `mas_reports` canonical rows | Owner recorded on write (`user_login`; #584). Legacy rows backfilled to `"default"`. |
| `/reports` list + search API | Filtered by `x-user-login` when the caller provides it; legacy unfiltered behavior when absent (see below). |
| AI Search report surface (`searchScheduledReports`) | Same contract: strict when the caller passes a user, unfiltered otherwise. |
| Report write paths (scheduled tick, manual uploads, research publish) | All thread the caller's login into `user_login`. |

## Known limitation (accepted)

The deployment's identity strings are not unified: the scheduled handler
writes as `"default_trader"`, some routes fall back to `"default"`, manual
uploads use the session id. Until the identity model is unified (#488),
read-path filtering cannot be strict-by-default without hiding a user's own
rows — so header-less callers keep legacy behavior. The write path is ready:
once identities unify, flipping the read default to strict is a one-line
change in `scheduledReports.ts`.

## Metering (EP-009)

`usage_events` table (`id, user_login, run_id, category, created_at,
detail_json`). Written best-effort on research run completion
(`research_run`) and on outcome evaluation (`research_evaluation`), attributed
to tenant + task. `recordUsageEvent` / `listUsageEvents` never throw —
metering must not break the metered operation.

## Negative tests

`tests/research-isolation-metering.test.ts`: cross-user list/search exclusion,
legacy backfill, per-user usage-event scoping.
