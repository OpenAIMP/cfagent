### Changed

- Nav-shell S2 phase 3, research (#1804, #2027): MarketDataResearchHub inner tabs run on the shared `useUrlSyncedTabs` hook with `?view=` as the canonical param and "screener" as the default; the lazy-load side effects (fetch screener / run comparison on first visit) now run on back/forward too. Panels stay conditional (no retention change).
