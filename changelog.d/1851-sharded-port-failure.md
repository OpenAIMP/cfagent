### Fixed

- **Sharded wired-port submission failure now publishes `screener.failed` (#1851):** the inner catch in `autonomousMarketScreenSharded` audited the failure but returned a silent `{success:false}`, bypassing the caller catch's full failure path (audit + session message + `screener.failed` event + job outcome). It now audits and rethrows, mirroring the #1412 missing-port fix. The inner audit stays — it carries the sharded flag (submission-attempt record), distinct from the caller run-failure record.
