### Changed

- **PaymentsAgent Think migration (#1957, tracker #1951):** `PaymentsAgent` now extends `PortThink` instead of `Agent`. The class is a non-chat, RPC-only actor with no turn hooks or scheduler callbacks, so the migration is the base class alone; its RPC surface (`budgetCheck`, `processPaidRequest`, `todaySpent`, `listPayments`, `migrateLegacyLedger`) and observable behavior are unchanged, pinned by `tests/payments-agent-think.test.ts`. The plain-Agent adopters pin in `tests/agent-conformance.test.ts` drops Payments, leaving only ReportAsset.
