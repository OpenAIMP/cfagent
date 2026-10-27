### Added

- **Policy Gate no-deletion and deprecation rules (#1894):** no PR may delete a file (retire by deprecating in place, which must name what superseded it); the gate evaluates the PR branch head and reads attribution from the PR body and labels only.
