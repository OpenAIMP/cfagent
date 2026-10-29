### Fixed

- Durable Objects rows-read exhaustion (#2280): replace the already-running gate's full-table `NOT IN` scan of `mas_async_jobs` with a bounded `IN ('queued', 'running')` seek on a new `(status, created_at)` index.
