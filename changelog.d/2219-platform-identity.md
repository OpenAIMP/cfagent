### Added

- **Platform identity on the payment screen (#2219):** tenant, user, and account tier are now automatic and read-only — the checkout panel displays the resolved identity from a new self-only endpoint instead of asking for a tenant id, and the paid-submission and subscription checkout/purchase routes derive the tenant from the verified account, ignoring any client-supplied tenant id even on mismatch. Paid paths with no resolved account fail closed with an account-setup message; the free path (flag OFF) proceeds as before. No price, flag, or money-path behavior changes.
