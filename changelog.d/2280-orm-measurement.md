### Added

- `DatabaseORM.execQuery` reports platform cursor totals (`rowsRead`/`rowsWritten`, statement template only) to an optional resource sink; `OrchestratorAgent.getOrm()` threads the shared resource-usage port. Coverage is `execQuery` only — repository helpers, the `exec` passthrough, and framework SQL are out of scope and documented as such.
