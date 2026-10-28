### Added
- Vectorize index coverage for screener, goal, options-scan, and research-report rows (#1169 S4-1): canonical report writes now upsert a `report:<id>` vector at write time (best-effort, never failing the store), with a session-gated backfill route for pre-existing rows; `retention` rows are excluded.
