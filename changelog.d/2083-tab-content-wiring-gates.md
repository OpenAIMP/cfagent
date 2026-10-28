### Changed

- **A missing tab now fails loud instead of rendering blank**: the main-region fallback renders an explicit missing-content notice naming the tab (trading tabs keep the hub path), so a deleted content entry can no longer surface as an empty viewport (#2083).

### Fixed

- **Wiring gates for tab content**: every `TAB_CONTENT` entry body must contain real JSX, and every component file under `src/client` must be wired by an import path or be on an explicit known-orphans list — the two holes that let #2060 delete the Docs render branch while CI stayed green (#2083).
