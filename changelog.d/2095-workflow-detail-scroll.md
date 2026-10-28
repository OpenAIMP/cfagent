### Fixed

- **Workflow run details open in view** (`?tab=workflow-runs`, #2095): clicking "Details" now scrolls the selected run's detail into view, and the run table is capped at `52vh` with its own scroll, so the detail is never stranded below a long list. Pinned by `tests/workflow_runs_panel.test.tsx`.
