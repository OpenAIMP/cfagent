### Fixed

- **Goal screen legs that error now fail per-class instead of reporting Complete** — an error-status options leg (no symbols, dead E*TRADE auth) or a no-universe stock leg surfaces as a qualified PARTIAL with its reason, per the #462 partial contract (#1963).
- **Stock legs whose filter the feed cannot evaluate now fail per-class** — a listings-feed refusal of a technical momentum filter surfaces as PARTIAL with the feed's reason instead of Complete with 0 hits (#1963).
- **Candidate structures column hidden when no hit carries structures** — stock hits never carry structures, so the column no longer renders thousands of meaningless dashes (#1963).
