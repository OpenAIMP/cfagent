# 2016 — Mainnet enablement for the cfpay gate

- **Base mainnet admitted (#2016)**: the gate's network allowlist grows from Sepolia-only to `base-sepolia`, `ethereum-sepolia`, `base`, and `eip155:8453` (Base mainnet forms, per cfpay's chain map). Ethereum mainnet is NOT admitted — it is not in cfpay's chain map. Unknown networks are still refused fail-closed when monetization is enabled, and the guard still does not apply when the flag is OFF.
- **Default unchanged**: the workflow adapter still defaults `MONETIZATION_NETWORK` to `base-sepolia` — mainnet requires an explicit opt-in value. The gate's network value is the operator-declared deployment network and an allowlist only; settlement chain follows the cfpay deployment's own configuration, so the two must be kept in agreement by the operator.
- **Disclosure updated**: the pre-payment disclosure no longer claims testnet-only; it states mainnet acceptance on Base and that settlement follows the cfpay deployment configuration. The refund disclosure is unchanged (one-time replacement-run credit, never a cash refund).

### Notes

- Prices are unchanged in this PR — the per-run prices remain the proposed values (stock $0.02, goal $0.10, options $0.05, strategy $0.10).
- This PR changes capability, not activation: charging in PROD still requires the Flagship `monetization` flag, a configured cfpay key, and the operator's `MONETIZATION_NETWORK` value. No flag default was changed — the fail-closed OFF default stays.
