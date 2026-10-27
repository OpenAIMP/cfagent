### Added

- **Test-parity harness (#1746):** `scripts/parity.mjs` (`npm run parity`) captures baseline suite snapshots, compares old vs new behavior (typecheck + suite + build), validates the per-PR parity checklist, and renders the §15 migration parity report; a parity failure blocks like a red gate, removals need an accepted reason, and a red baseline refuses comparison.
