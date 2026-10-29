### Fixed

- Durable Objects rows-read exhaustion (#2280): give the nightly retention batches covering `(created_at, id)` indexes on `mas_messages` and `mas_events`, so each 500-row prune batch seeks instead of scanning the whole table (up to 10 scans per run before).
