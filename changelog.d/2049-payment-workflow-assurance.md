### Added

- PaymentWorkflow assurance page in the client UX (#2049): the real payment flow and gate run behind fake cfpay/screener seams, with 9 preset scenarios and tunable fakes. Test only — no charge, no real screener run, no mainnet. Gated by its own feature flag `payment_assurance`, default OFF (fail-closed); the page is hidden until the flag is explicitly enabled.
