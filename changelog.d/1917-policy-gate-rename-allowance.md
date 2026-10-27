### Added

- **Policy Gate check (i) test-rename allowance (#1917):** a deleted test file now passes the no-deletion check when an added test file preserves every one of its test names (exact, or fuzzy at ratio >= 0.55 under a distinct assignment) and git pairs the two as a rename at a 20% threshold, or every old title appears verbatim in the new file. Non-test deletions still fail unconditionally; no label bypass added. Unblocks the #1906 legacy-name sweep, whose one deletion sits at 41% similarity with all 39 test names preserved.
