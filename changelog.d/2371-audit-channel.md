### Audit channel resolves outcome catalog aspects (#2371)

- GET /api/audit and GET /api/audit/:id now attach a read-time `resolvedAspects` field (code, business message, category, retryability, audit-channel variant) for any cataloged code in the record payload, resolved through the single #2381 outcome resolver (success and failure; pre-rename codes resolve via `legacyAliases`); unknown codes pass through unresolved and stored rows are never rewritten.
- The records explorer shows the resolved business message first, with the raw code secondary and category/retryability visible.
