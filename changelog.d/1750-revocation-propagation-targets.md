### Added

- **Numeric revocation-propagation targets per trigger (#1750):** membership revocation 0 ms at the PDP gate, API-key deletion 0 ms at verification, admin removal 0 ms at admin gates, token expiry 0 ms past the deadline, session revocation 0 ms same-isolate and ≤ 60 s every isolate (the isolate-cache TTL), recorded in authz.md §9 with residual gaps named, backed by `src/security/revocationTargets.ts` and proving tests per trigger.
