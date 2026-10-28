### Fixed

- **Workflow-produced screens record their full document set (#2081):** `ScreenerScreenWorkflow` shards now carry `xlsxKey`, `csvKey` and the run's `trigger` through `toShardResult`, the shard summary, child-output validation and the parent projection. The canonical store payload merges those keys and stamps the command trigger, so the Docs and Reports row for a workflow run links PDF, XLSX and CSV and shows Manual/Scheduled instead of an em dash.
