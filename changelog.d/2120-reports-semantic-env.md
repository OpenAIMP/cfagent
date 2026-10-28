### Fixed
- Reports semantic search now runs: detail-branch guard stops `/api/reports/semantic-search` from 404ing, and the reports-route mount passes `env` so Vectorize bindings reach the handler (#2120 slice 0). Lexical half unchanged.
