### Changed

- Nav-shell S2 phase 2 (#1804, #2027): ScreenersHub migrates onto the shared `useUrlSyncedTabs` hook — canonical `?view=` param, `?screenerTab=` (and `?tab=`) kept as read-only legacy aliases, hash links still resolve; the hub's bespoke URL/retention code and `parseScreenerTabFromUrl` are retired.
