### Fixed

- **Workflow Runs page now scrolls** (`?tab=workflow-runs`, #2095): the page owns a flex scroll container (`flex: 1 0 auto; overflow: auto`) instead of shrinking inside `.tab-viewport`, so long run lists, stage tables, and the detail pane stay reachable at any viewport height. Pinned by `tests/workflow_runs_panel.test.tsx`.
