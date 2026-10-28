### Changed

- Quotes feed consolidated into one implementation (#2100): singleton quotes service + `useMarketQuotes` hook + shared symbol sets replace the duplicated WebSocket/REST/flash lifecycle in the ticker tape and search bar. Named harmonizations: search fallback 10s → 12s, search flash 750ms → 800ms and flash on snapshot/poll like the tape, search reopens to cached quotes when the tape already subscribes.
