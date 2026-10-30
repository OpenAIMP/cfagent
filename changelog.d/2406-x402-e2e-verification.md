### Monetization Phase 1.1: x402 end-to-end verification on the 3 priced endpoints (testnet)

- Per-path real-vs-simulated labeling: new `describeX402PaymentPath` helper
  (on-chain testnet/mainnet vs simulated local ledger, pure — no new
  per-request store reads); the 402 challenge body now carries a
  `paymentPath` label, the client price line shows the testnet note,
  and the NLQ paid-action refusal states the payment path next to the
  price.
- Per-tier end-to-end verification tests for all three priced endpoints
  (OPTIONS_SCREENER $0.05, MARKET_RESEARCH $0.10, STOCK_SIGNALS $0.02):
  labeled 402 at the tier price when unpaid, verified receipt → served
  result → completed `mas_transactions` ledger row when paid, and
  refusal (typed error, nothing served, no ledger row) for simulated
  proofs, replayed transactions, and failed verification. Prices pinned
  unchanged.
- Limitation (honest): the chain is verified with the production
  verifier seam (stub claim verifier + the real verifier's unit
  coverage). A live testnet transfer needs an owner-funded wallet plus
  HITL confirm and remains an explicit post-merge owner step.
