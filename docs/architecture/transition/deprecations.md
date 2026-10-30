# Deprecation ledger

Single ledger for rename-based deprecations (gitops.md §22). Deprecated
files are frozen: no new features, no new consumers, refactoring only
to migrate consumers off them. Deletion needs zero consumers plus an
owner decision plus a gate amendment, and is never part of a program
slice.

## 2026-10-29 — outcome catalog supersedes the error catalog (#2381)

- File: `src/errors/errorAspects.ts` → `src/errors/errorAspects.deprecated.ts`
- File: `src/errors/errorCatalog.json` → `src/errors/errorCatalog.deprecated.json`
- Date: 2026-10-29
- Reason: Issue #2381 replaces the failure-only error catalog with the
  unified outcome catalog (success + failure, outcome-encoded names
  `SUCCESS_*` / `FAILURE_*`). The old cryptic codes
  (`AUTH_*`, `SCREEN_*`, `REPORT_*`, `DELIVER_*`, `SYS_001`, `QUOTE_*`,
  `WATCHLIST_001`, `DATA_001`, `MCP_001`) are retired as emitters;
  pre-rename stored values still resolve at read time through the
  outcome catalog's `legacyAliases` map.
- Replacement: `src/outcomes/outcomeCatalog.json` +
  `src/outcomes/outcomeAspects.ts` (single catalog, single resolver).
- Consumers at deprecation: none — every importer was migrated to the
  outcome module in the same slice (emitters, P1 channel renderers,
  and the report parsers now resolve through `outcomeAspects`).
- Deletion condition: zero consumers (already met) plus an owner
  decision plus a gate amendment; deletion is outside the #2381
  program slices. Retain until the owner confirms no pre-rename
  debugging still needs the frozen originals.
