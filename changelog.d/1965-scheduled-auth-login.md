### Fixed
- Scheduled runs now resolve identity and environment from the schedule payload first, with the saved execution context as the legacy fallback, so a stale context no longer blocks runs with AUTH_003 (#1965).
