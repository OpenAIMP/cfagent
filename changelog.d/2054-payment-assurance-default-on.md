### Changed

- `payment_assurance` flag is ON by default (#2054, owner direction): the PaymentWorkflow assurance page is visible without explicit enablement. Flagship provider default, Env adapter default, and in-memory default are all true for this flag; an explicit disable (dashboard flag OFF, FEATURE_FLAGS bulk false, or FEATURE_PAYMENT_ASSURANCE=0) still wins, and a provider error still fails closed. `FEATURE_PAYMENT_ASSURANCE=1` added to wrangler.jsonc vars for runtimes without the FLAGS binding.
