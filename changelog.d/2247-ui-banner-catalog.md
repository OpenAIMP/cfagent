### Fixed

- **Screener failure banners render from the error catalog (#2247):** research-report PDF/XLSX failure records now carry the catalog code (REPORT_001 for PDF, REPORT_002 for XLSX) with the specific reason as detail, and the UI renders them through the Notice primitive — ReportsPanel's PDF-unavailable row and RunDetailView's XLSX block — instead of raw strings and bare spans. CSV failure text is unchanged: it has no catalog code and no UI surface rendering it.
