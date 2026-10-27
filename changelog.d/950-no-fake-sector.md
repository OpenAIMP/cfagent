### Fixed
- Sector filter no longer rejects stocks with no sector data (#950): `resolveStockSector` returns undefined instead of the fake "Equities" default, the sector filter passes (never rejects) when the sector is unknown, the Nasdaq listings path drops the same default, and CSV/XLSX reports show "Unknown" instead of "Equities" for unknown sectors.
