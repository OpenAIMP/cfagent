### Options runs: owner-scoped reports + complete artifact records (fixes Reports tab / Workflow Runs)

The options screener produced PDF, XLSX, and CSV artifacts on every path, but the
run record around them lost data, so a produced run could be invisible:

- **Reports tab.** Every options canonical write stored its `mas_reports` row
  without `user_login`, i.e. under the `default` owner. The Reports tab reads
  `/api/runs`, which is owner-scoped (`WHERE user_login = ?`), so the run's row
  and its PDF/XLSX/CSV links never rendered for the signed-in user. All options
  write sites now go through one owner-aware seam
  (`storeOptionsCanonicalReport`): the scheduled scanner (monolithic), the
  manual contract screen, and the unified options screen. This mirrors the
  stock screener's #911 fix.
- **Workflow Runs.** The options `options.completed` event now carries the
  XLSX/CSV keys, statuses, and errors (it previously carried only the PDF), and
  `screenerOutcomeFromEvent` maps `withTrades` → `matchedCount`. The bridged job
  outcome therefore records all three artifacts instead of a PDF-only run with
  a null match count.
- **Runs with no job tree.** The sharded serve recorder now writes a
  `mas_job_outcomes` row (keyed by the run's delivery id, so a replay
  converges) and the unified manual options path records its own outcome. Both
  previously left artifacts with no ledger row, so Workflow Runs showed nothing.
- Scheduled and manual options canonical bodies now record per-format statuses
  (`pdfStatus` / `xlsxStatus` / `csvStatus` and the format errors), matching the
  stock screener's report shape, so a failed format is named instead of absent.

No artifact generation changed: scheduled and manual runs still generate PDF,
XLSX, and CSV through the same pipeline and ScreenerAgent stores. What changed
is that every path records the owner and the artifact set the run produced.
