### Options research runs record and serve PDF + XLSX + CSV (#2167)

`options_research` was the last report-producing path without a full document
set: it generated a PDF only, wrote its canonical row before generation (so the
row never carried a key), and had no Docs mapping or workbook/CSV routes.

- New research renderers from one shared row model
  (`src/trading/researchReportData.ts`): `researchReportXlsx.ts` (Ideas, Legs,
  Trade Cards, Watchlist, Rejected, Run Summary) and `researchReportCsv.ts`
  (the ranked idea table, identical columns to the Ideas tab).
- `ResearchAgent.generateAndStoreResearchArtifacts` stores the workbook and CSV
  under `report:xlsx:research:<id>` / `report:csv:research:<id>` — the same
  family as the run's `report:pdf:research:<id>` — with the report retry policy
  and a per-format failure domain: a failed leg is recorded, never fatal.
- `runResearchAndPublish` now generates the full set **before** the canonical
  write and records `pdfKey`/`pdfStatus`/`pdfError`, `xlsxKey`/`xlsxStatus`/
  `xlsxError`, `csvKey`/`csvStatus`/`csvError` on the owner-scoped
  `options_research` row; a run whose documents all fail still gets its record.
  The manual-run response returns the same artifact links.
- Serving: `GET /api/research/report.xlsx` and `/api/research/report.csv`
  (key-addressed, owner-scoped, same contract as the PDF route).
- Read side: `options_research` maps into the Docs options family and onto the
  research artifact URLs (`scheduledReportPdfUrl`, `xlsxUrlForSource`,
  `csvUrlForSource`), so Docs and Reports shows all three downloads.
- The research PDF's leg lines now use the shared `researchLegLine` (side from
  the quantity sign, price from the mid) instead of reading fields the leg type
  does not have — every leg previously printed blanks and a "—" price.
