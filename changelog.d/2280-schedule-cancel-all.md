### Added

- `POST /api/schedules/cancel-all`: cancels every schedule on the caller's own instance (the #2280 post-reset queue wipe mechanism). Fail-closed: without `{ confirm: true }` it returns the preview and cancels nothing; paused-schedule resume records are preserved, never deleted.
