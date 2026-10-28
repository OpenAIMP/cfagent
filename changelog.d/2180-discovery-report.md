### Strategy discovery runs produce a PDF + XLSX + CSV run report (#2180)

Scheduled strategy discovery was the last report-producing path with no
documents: its canonical row carried only the run identity, the per-symbol
outcomes lived in `mas_discovery_runs`, and the publish seam had no artifact
step — so Docs showed an unexplained "—".

- New run-report renderers from one row model
  (`src/trading/discoveryReportData.ts`): `discoveryReportPdf.ts` (batch
  header + counts, then one block per symbol: what ran, the judged pick with
  economics and legs, or the recorded reason), `discoveryReportXlsx.ts`
  (`Symbols`, `Legs`, `Run Summary`), `discoveryReportCsv.ts` (the Symbols
  table).
- `generateAndStoreDiscoveryReport` stores all three under
  `discovery:pdf|xlsx|csv:<runId>` (deterministic per run) with the report
  retry policy; each format fails independently and is recorded, never fatal.
- `persistDiscoveryCanonicalAndBridge` generates **before** the canonical write
  and records every key/status/error on the `discovery` row (the store is
  insert-only per generation id, so a later write could not attach them). With
  no blob storage wired, the row still lands and the artifacts record "storage
  not configured".
- Serving: `GET /api/discovery/report.pdf|xlsx|csv?key=` (owner-scoped,
  400 without a key, 404 for an unknown one).
- Read side: `discovery` maps onto those three routes, so Docs and Reports
  shows the run's downloads instead of "—".
- Abstained and failed symbols render their recorded reason with no pick; a
  no-view run renders its constraint set and never invents a thesis.
