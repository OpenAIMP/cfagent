### Fixed

- **Goal stage contracts are fail-visible**: gather failures carry a first-class `failed` state, the chain-bridge submission retries under the report policy with a `followup.schedule_failed` audit, and lost audit inserts warn with type + login instead of vanishing (OpenAIMP/cfagent#1999).
- **Goal audit rows carry attribution**: scheduled rows record a `system` principal and manual route rows record a `session` principal, alongside the run owner's login (OpenAIMP/cfagent#1999).
- **IV-collection store failure reports failure**: a lost `mas_reports` row audits `options.iv_collection_persist_failed` and returns `success: false` instead of claiming success (OpenAIMP/cfagent#1999).
