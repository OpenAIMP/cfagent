### Fixed

- **Quotes fallback fetches now resolve 202 stubs**: the ticker tape and stock search bar fetched `/api/market/quotes` with raw `fetch`, bypassing rule #71 — a 202 async-job stub would have reached the UI unresolved. Both now import `apiFetch` as `fetch` (one line each, call sites unchanged); a pin test keeps both files on the import (#2098).
