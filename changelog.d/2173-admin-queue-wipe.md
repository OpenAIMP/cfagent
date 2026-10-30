### Added

- Admin panel Queue tab (#2173 slice): per-instance schedule/queue dump, fail-closed cancel-all preview → modal confirm → verify-empty, allowlisted clear-table preview → confirm, and a separate explicit Track 1 recreation action (2 stock crons + 2 hourly options legs, built through the schedule form's payload builder). Own-instance routes only; no new server route; platform-admin gate via the existing panel gate.
