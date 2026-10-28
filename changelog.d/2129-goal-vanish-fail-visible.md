### Fixed

- **Staged goal runs no longer vanish without a trace (#2129):** a projection that lands nowhere now warns with chain, stage, and cause instead of silently no-op'ing, and the Goal Screen panel persists its tracking handle in sessionStorage, resumes it on mount with the original submit deadline, and otherwise loads the newest stored goal run as the previous result.
