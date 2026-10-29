### Fixed

- **Chained audit writes on the live audit store (issue #2178, slice 1):** every `mas_events` insert now links onto the table's current tail and stores its own SHA-256 hash, so tampering, reordering, or a bypass writer fails verification. Pre-chain rows are a genesis boundary, not a failure. The central audit writer (`recordAudit`) now goes through the same chained path instead of raw SQL, and record payloads are stored as JSON text rather than coercing to `[object Object]`.
