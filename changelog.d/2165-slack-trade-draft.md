### Fixed

- **Slack options-order approval no longer claims QUEUED when its draft fails to persist**: a failed `trades.create` now posts an error message instead of the QUEUED blocks, returns failure instead of success, and audits `trade.options_draft_create_failed` with the draft ID and error (issue #2165).
