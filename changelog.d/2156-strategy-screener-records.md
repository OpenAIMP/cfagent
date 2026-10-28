### Strategy screener runs are recorded (#2156)

The Strategy Discovery panel (`POST /api/trading/options/strategies` and
`/best-trade`) returned ranked strategies but wrote no record, so a manual
strategy screen never appeared on the Reports tab or in Workflow Runs.

- New `recordStrategyScreenRun` seam writes one owner-scoped canonical
  `mas_reports` row (source `options_strategy`, ranked strategies + risk
  reports + screened-out + screen snapshot in the body) and one
  `mas_job_outcomes` row (kind `options`, counts, origin
  `options-strategy-screener`). An async-job execution twins the job id so
  the ledger attaches to the existing run.
- `runSummaries` maps `options_strategy` into the options-research family,
  so the run appears under the options filter on the Reports tab.

Strategy screens produce no PDF/XLSX/CSV today; the record is the canonical
body and the artifact list is honestly empty.
