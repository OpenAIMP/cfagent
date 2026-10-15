# Async jobs UI migration

The embedded and standalone views now share one rendering path using Button, Surface, StatusBadge, and AsyncState. The embedded list still previews five jobs; standalone shows the fetched list. The /api/jobs?limit=30 and /api/jobs/:jobId endpoints and four-second polling interval remain. Job IDs are URL-encoded for detail requests. JSON export and the existing 10,000/100,000-character preview limits remain.

List loading/error state and result loading/error state are independent. A failed refresh retains existing jobs and shows an explicit error rather than an empty state. Successful list polling cannot clear a result error. Missing result payloads have an explicit empty state. Selecting another result aborts the previous request; controller identity and mounted checks guard state updates. Polling skips overlapping list requests. Unmount cleanup aborts outstanding requests. No automatic focus movement is introduced.

The new scoped layout replaces old feature class names rather than adding theme-specific patches. Native details/summary remains in standalone mode. Per-job status is textual and non-live; async state transitions use the shared live-region contract.

## Validation limits

Added tests cover server-rendered initial states, disclosure semantics, and scoped CSS conventions. They do not exercise effects, request races, abort behavior, downloads, focus restoration, or browser layout. Those behaviors have not been validated by the authoring assistant. Inspect CI and perform browser tests before merge.

## Remaining work

- Add interaction tests for refresh success/failure, result requests, out-of-order responses, StrictMode cleanup, and JSON export.
- Browser-test keyboard focus after closing a result, live-region announcements during polling, narrow layouts, larger text, and both themes.
- Remove now-unused legacy async-jobs CSS after confirming no other consumers.
- Continue canonical token generation, contrast verification, global-font cleanup, and remaining workflow migrations.

This migration implements the first three pending feature items in ui-foundations.md at the code level; runtime validation remains outstanding. No trading calculations or order execution behavior is changed.
