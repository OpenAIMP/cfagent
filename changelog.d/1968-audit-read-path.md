### Audit read path (#1968)

- GET /api/audit now honors type/event_type, agent, before/to, after/from, limit, and offset query params, with filtering applied before the limit; added GET /api/audit/:id returning a single session-scoped event with its full payload.
- Records & Ledger Explorer table reads return newest-first for tables with a created_at column, and clicking a browsed row opens its full payload as expanded JSON.
