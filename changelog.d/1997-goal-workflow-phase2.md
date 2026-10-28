### Added

- **Goal screen workflow rollout control (Phase 2, default OFF)** — the `goal_workflow` flag (strictly default-closed) gates the #1996 goal-workflow submission paths: flag ON makes the workflow required on manual and scheduled runs, with a coded failure instead of a silent fallback to the direct engine, and the panel tracks staged runs with live stage progress, keeps the previous result until the new one lands, and fetches the stored run by the report id the goal door now surfaces on the shard row (#1997).
