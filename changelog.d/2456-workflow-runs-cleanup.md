### Fixed

- Workflow Runs no longer shows queued page-load reads as runs: GET/HEAD requests are never queued as async jobs, and standalone GET/HEAD http.request traces are hidden from the runs read model (#2456).
