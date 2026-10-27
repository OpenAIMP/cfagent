### Added

- **PAYMENTS_FLOW_MODE scoped resolution (#1735):** the payments-flow switch now resolves run > session > user > global env > built-in HITL via the new `src/config/paymentsFlowModes.ts` port; the global env value stays the fallback, HITL stays the default, and an invalid winning value still fails closed to HITL with a `payment.config_error` audit. The run value is execution-owner-set only — request input can never flip a caller's own execution to immediate.
