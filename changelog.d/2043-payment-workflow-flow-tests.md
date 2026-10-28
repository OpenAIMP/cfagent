### Added

- **Repo payment workflow flow tests**: `tests/payment_workflow_flow.test.ts` ports the 9 workspace flow cases plus caller-seam cases (param validation, binding/host start, event delivery) into repo vitest with fake step/cfpay/deps — no worker runtime, no key, no network (#2043).
