### Added

- **cfpay revenue report (#2022)**: `GET /payments/agentic/ledger/cfpay-revenue` aggregates charge/credit totals from the durable `mas_transactions` cfpay rows (authoritative for money) with family and coverage attribution joined from the `mas_events` payment payloads on run id, including explicit "unknown" buckets where an audit row is missing; the payment workflow adapter now stamps family on every payment audit event and the covered event carries its paidVia. Cost-per-run is not reported: no per-run cost accounting exists yet.
