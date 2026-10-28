### Added

- Flagship feature flag "monetization" (#2043) for the cfpay monetization gate: Flagship ON/OFF now turns PaymentWorkflow charging ON/OFF, default OFF and fail-closed; the raw MONETIZATION_ENABLED env read in PaymentWorkflow is replaced by FeatureFlagPort evaluation.
