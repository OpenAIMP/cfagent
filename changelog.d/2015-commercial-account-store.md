### Added

- **Minimal commercial account store (#2015/#2020)**: `mas_commercial_accounts` (one row per user: tier, credits, included runs), `mas_tenant_settings` (per-tenant ads flag, #2022), and `mas_credit_redemptions` (one-time failure-credit claims, #2019), with operator-managed endpoints under `/payments/agentic/commercial/*` (operator allowlist `COMMERCIAL_STORE_OPERATORS`, empty = deny all; service identity `SERVICE_USER_LOGIN` for server-side hops to the canonical instance).
- **Dedicated paid-submission route (#2015)**: `POST /payments/agentic/commercial/submit` adopts the payment workflow seam for one-off runs (recurring schedules refused — they go through the schedule service, no CTO collision) and redeems failure credits for the same family before starting the screener; `GET /payments/agentic/commercial/submission-status` reports workflow status. The payment workflow now consumes coverage (included run or credits) in the store on the covered path, best-effort with loud logging so a store blip never denies a covered run.
- **Ads enforcement from the store (#2022)**: the ads handlers resolve tier and the tenant ads flag from the store via the verified login (tenant off beats tier); any store failure fails open to serve. The banner-config client path stays with #2090 — this PR covers server lists and tracking only.

### Notes

- Email on submission is the caller's checkout contact, supplied by the caller — it is not an identity proof (no verified email exists in the session; identity is the verified login).
- Redemption activates for credits issued after #2019 lands (family comes from the failure-credit audit payload, never from note text); pre-amendment credits without a family payload are not auto-redeemable.
- Residual gap, stated plainly: if a credit is claimed but the screener then fails to start, the audit row is the operator's re-issue signal — no operator credit-issue route exists yet.
