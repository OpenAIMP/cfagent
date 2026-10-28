### Added

- **Docs and Reports page (screener workflow):** new left-nav entry listing one row per screener-workflow run — date-time, run type (manual / scheduled), run source (stock / options / goal / strategy), PDF / XLSX / CSV download links, and the run id. The page reads the existing Runs API (`GET /api/runs`); links appear only for artifacts the run recorded, and a store that records no trigger renders "—" instead of a guessed value.
