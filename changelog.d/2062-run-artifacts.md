### Added

- **Full document set per screener run (#2062):** every stock run now generates and stores a CSV beside its PDF and XLSX (`screener:csv:<id>` plus the latest pointer), with the same retry/status contract as the workbook. The canonical screener body records `xlsxKey`, `csvKey` and its `runSource`, and scheduled canonical rows record their trigger, so the Docs and Reports table links all three artifacts and shows the run's own family instead of an inferred one.
