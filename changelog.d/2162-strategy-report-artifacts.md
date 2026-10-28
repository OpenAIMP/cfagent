### Strategy screens produce PDF + XLSX + CSV report artifacts (#2162)

Strategy screens recorded a run but produced no documents, so Docs and Reports
showed every `options_strategy` row with an unexplained "—". This closes the
last non-producing options path named by #2088.

- New `src/trading/strategyReport.ts`: one row model for *ranked strategies*
  (ranked list, both fit directions, best-trade alternatives, AI rank/score/
  rationale joined by candidate id) plus PDF (`pdf-lib`), XLSX (Strategies /
  Legs / Summary tabs), and CSV renderers. Economics render as money/percent;
  an unbounded max profit is stated, never invented.
- `ScreenerAgent.generateAndStoreStrategyReport` stores each format under the
  existing `options:pdf:` / `options:xlsx:` / `options:csv:` families, so
  `/api/options/report.pdf|xlsx|csv?key=` serve them with no new route surface.
  Each format has its own failure domain (#1278): a failed leg records
  `*Status: "failed"` + `*Error` and never fails the run.
- Wiring: `/api/trading/options/strategies` and `/best-trade`, plus the unified
  strategy/AI actions (`strategies`, `best_trade`, `compare`, `llm_ideas`,
  `llm_evaluate`), record the keys/statuses on the canonical `options_strategy`
  row and the job outcome, and return `reportUrl` / `xlsxUrl` / `csvUrl`.
- Read side: `runSummaries` and `scheduledReportPdfUrl` map `options_strategy`
  to the options artifact routes, so the Docs and Reports table shows all three
  downloads for strategy runs — or their recorded failure state.
