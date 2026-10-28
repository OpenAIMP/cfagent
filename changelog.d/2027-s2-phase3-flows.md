### Changed

- Nav-shell S2 phase 3, flows (#1804, #2027): OptionsFlowsHub inner tabs run on the shared `useUrlSyncedTabs` hook with `?view=` as the canonical param and "live" as the default; ticker-select and summary-return navigation now flow through the hook so the URL stays in sync. Panels stay conditional (no retention change: hidden panels must not keep polling).
