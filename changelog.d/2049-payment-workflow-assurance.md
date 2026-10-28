### Added

- PaymentWorkflow assurance page in the client UX (#2049): the real payment flow and gate run behind fake cfpay/screener seams, with 9 preset scenarios and tunable fakes. Test only — no charge, no real screener run, no mainnet. Gated by its own feature flag `payment_assurance`, default OFF (fail-closed); the page is hidden until the flag is explicitly enabled. Page styling conforms to the UX architecture: ui primitives only, token-only inline styles (no raw controls, no hardcoded density literals, no raw color literals).
