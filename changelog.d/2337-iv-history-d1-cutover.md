### Changed

- IV history storage cutover (#2337, ADR 0022 step 2, ruling R-2): the env-aware composition now selects the D1 IV-history adapter whenever AGENT_DB is bound; `IV_HISTORY_D1_ENABLED="false"` is the rollback lever that forces the Durable Object adapter. This is a warming-up restart: the D1 series starts empty, there is no backfill, and the previously collected DO-side series are abandoned (a scoped exception to the 365-day retention posture, for this store only). Cold reads report the honest warming-up state — observations 0, warmingUp true, latest null — never the abandoned DO data. The production IV call sites — the IV-history read route, the scheduled daily collector, the on-demand collection trigger, and discovery IV stats — now compose through that env-aware build, so the cutover takes effect in live traffic; the D1 schema ensure is memoized per AGENT_DB binding, so per-request composition does not re-run DDL.

#CDO-mha7
