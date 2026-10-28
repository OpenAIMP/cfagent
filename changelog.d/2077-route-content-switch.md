### Changed

- **Tab content now resolves through the route table**: Chat's `<main>` region renders one table-keyed lookup (`TAB_CONTENT[tab]`) instead of 14 inline `{tab === ...}` conditionals, and the retained trading set lives as `retain` flags in `routes.ts` (chat/types.ts derives TRADING_TABS from it), so a route id can no longer exist without content or drift from the hub wiring (#2077, part of #1804).

### Fixed

- **Docs tab no longer renders blank**: its existing DocsAndReportsPanel was mounted nowhere; the content map wires it, so the Docs and Reports nav item now shows content (#2077).
