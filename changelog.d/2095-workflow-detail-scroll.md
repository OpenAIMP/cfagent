### Fixed

- **Workflow Runs list uses the full page** (`?tab=workflow-runs`, #2095): the run table is no longer capped at `52vh`, and the scroll-into-view workaround is gone — a run's detail opens in a dialog over the list, so the list no longer has to be shortened to keep the detail near it. Pinned by `tests/workflow_runs_panel.test.tsx`.
