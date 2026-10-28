### Changed

- **Workflow run details now open in a dialog** (`?tab=workflow-runs`, #2095): clicking "Details" opens the run's full story — trigger evidence, ordered stages with reasons/errors, inputs, outputs, artifacts, delivery states, and per-stage IO — in the `Modal` primitive over the table, with its own scroll. The inline detail below the list (and its scroll-into-view workaround) is removed, so the detail is always immediately visible.
