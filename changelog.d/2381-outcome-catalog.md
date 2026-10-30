### Outcome catalog (#2381)

- New single outcome catalog (`src/outcomes/outcomeCatalog.json` + `src/outcomes/outcomeAspects.ts`) covering success and failure with outcome-encoded names (`SUCCESS_*` / `FAILURE_*`); all emitters and P1 channel renderers (UI banner, email, CSV, XLSX, traceinfo) now resolve through it.
- All 22 legacy codes renamed 1:1 (messages preserved verbatim); pre-rename stored values resolve at read time through the `legacyAliases` map — stored rows are never rewritten, and unknown codes pass through unresolved instead of falling back to a substitute code.
- `src/errors/errorAspects.ts` and `src/errors/errorCatalog.json` deprecated by rename to `*.deprecated.*` (frozen, zero consumers); ledger entry at `docs/architecture/transition/deprecations.md`.
