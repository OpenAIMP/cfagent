### Fixed

- **Scan rows now show partial coverage**: runs-list rows built from the scan store carry the R6 partial qualification and append the partial segment to the row summary, so a partial interactive scan reads exactly like a partial canonical row instead of looking complete (#1850).
