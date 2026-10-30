### Changed

- #1976 step 4g (#2390, gate G-7 ruled): `mas_settings` is now owned by a dedicated settings port in `src/data/` — the port's DO-SQLite adapter is the table's only value writer and only DDL ensurer. The four former writers (reportDispatch's settings doors, screeningFlags' factories, governedHalt's kill-switch DO write, the enrichment adapter's killswitch write) are callers of the port; governedHalt's safety-ordered D1 dual-write protocol is preserved exactly and pinned; the duplicate DDL ensures in `orchestrator.ts` and the strategy-weights adapter retired to the adapter's `ensureSchema()`.

#CDO-mha7
