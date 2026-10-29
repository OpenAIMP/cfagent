### Added

- `POST /api/maintenance/clear-table`: bulk clears for caller-owned tables — `mas_async_jobs` (caller's session only, running rows never deleted), `mas_job_outcomes` (instance history, prune watermark preserved), and `paused_schedules`. Same contract as the schedules cancel-all: preview without `{ confirm: true }`, one audit event on confirm, fail-closed allowlist (audit history never clearable; messages route to `/clear`; the framework queue routes to cancel-all).
