### Added

- Live landing tape (issue 2130): the pre-sign-in tape now subscribes to the same quotes feed (WebSocket-first, REST polling fallback) and updates every matching item by symbol, duplicates included. Symbols with no live quote keep their static baseline; the 10Y value keeps its percent sign.
