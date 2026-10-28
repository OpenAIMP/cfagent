### Fixed

- **Signed-in users can create screening schedules (#2071):** the accepted login shape now covers the identities the app actually forwards — emails and IAAA `issuer:subject` ids — while still rejecting whitespace, control characters and oversized values. The Orchestrator stores the screener execution context for those identities, so the schedules routes stop answering "An authenticated E*TRADE account is required" to a signed-in user.
- **Repeated schedule creation is idempotent (#2071):** a second identical create (same callback, payload and cadence) returns the schedule that already exists with `duplicate: true` instead of arming a duplicate; interval schedules are no longer double-armed by a double submit.
