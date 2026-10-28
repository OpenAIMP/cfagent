### Scheduled options reports + all-strategy evaluation (#2091)

- Scheduled options runs now record their artifacts: the sharded serve stage writes one canonical mas_reports row (generationId `options:<timestamp>`) plus the timestamp-keyed history row, carrying PDF + XLSX + CSV keys, so Docs and Reports list the run. The monolithic service returns its keys + canonical row id, and the orchestrator writer skips its second keyless row when the service already wrote one.
- Scheduled runs evaluate the chain against every wanted strategy (new `evaluateAllStrategies` flag, scheduled paths only): the request thesis orients scoring but no longer excludes strategies. Manual runs keep the thesis default.
- Options PDF gains "Strategies fit my name" + "Names fit my strategy" sections plus a coverage note (rendered only when the run carries a matrix); the XLSX gains "Strategies by Name", "Names by Strategy", and "Strategy Coverage" tabs. CSV is unchanged (contracts table).
- Limits stated plainly: fetch bands stay thesis-gated, so strategies whose required expiries were not fetched report as not-evaluated with the horizon reason — far-expiry fetch widening is a separate budget question.
