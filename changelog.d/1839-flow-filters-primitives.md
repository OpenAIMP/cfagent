### Changed
- platform-wide P3 (#1839): FlowFiltersSidebar migrated to primitives — 24 raw buttons to Button, 4 checkboxes to Checkbox, 2 range + 2 number inputs to TextInput (range sliders render natively via P1's `.ui-input[type="range"]` reset, now on main), 2 selects to Select. Freeze 34 → 0 for this file; no density literals (none at snapshot, none added). No behavior change.
