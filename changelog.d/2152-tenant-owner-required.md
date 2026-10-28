### Tenant ownership is mandatory for reports and goals (multi-tenant SaaS)

`mas_reports` has always been tenant-scoped on read (`WHERE user_login = ?`), but the
write path still had a synthetic `"default"` owner, and several writers omitted the
owner entirely. In a multi-user SaaS that files a real run under a fake tenant and
hides it from everyone.

- **No more `"default"` owner.** `ScheduledReportInput.userLogin` and
  `CanonicalReportInput.userLogin` are required. `reportOwnerOf` refuses a blank
  owner; `storeReportAtGeneration` / `storeReportAtGenerationWithR2` /
  `persistScheduledReportSql` return null and log why instead of writing a
  `"default"` row. The legacy NULL→`"default"` backfill in
  `ensureScheduledReportsTable` is removed: an unknown owner is not a tenant, so
  legacy NULL rows stay unowned (visible only to unscoped legacy reads) rather
  than being misattributed.
- **Every writer now names its owner:** scheduled stock screens, strategy
  discovery, IV collection, options research, paid research/options routes,
  sharded store stages, retention (skips the row when no tenant), and the
  bundle canonical row. Research/paid routes fail closed (skip + log) when no
  login exists.
- **Goal screen fixed.** `persistWorkflowGoalScreenReport` received `userLogin`
  but never wrote it onto the canonical row, so goal-screen runs were stored
  under `"default"` and never appeared on the Reports tab. It now writes the
  owner. The goal direct path and the workflow path also record a
  `mas_job_outcomes` row (`kind: "goal"`) with the run's artifact keys, so goal
  runs appear in Workflow Runs (they have no async-job tree).
- **Goal scenario store** (`mas_goals`, `mas_scenarios`, `mas_outcomes`) requires
  an owning login for create/record calls; the `"default"` fallback is gone.
