### Screener workflow doc

- Added `docs/architecture/business/screener-workflow.md`: current-state map of the screening pipeline (9 stages, agents, workflows, queues, schedules, job systems, persistence and error handling per stage, AOP fit/gap) plus the transformation to the unified workflow — goal-screen divergence (#1963, fix merged), the corrected workflow/gather record, the connectedness verdict, and phased transformation with #1972 queue decision still open. Published for lane feedback before any journey work starts; no implementation in this change.
