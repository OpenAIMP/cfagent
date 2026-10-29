### Fixed

- **Policy Gate no longer re-runs on a merged PR.** `pull_request: edited` re-fired the gate when a merged PR's body was edited; its diff against `main` is empty by then, so check (d) failed and the merged PR showed a red required check that never existed at merge time (#2272). The job now runs only while `github.event.pull_request.state == 'open'`, so open-PR edits still re-validate attribution and merged history keeps the gate result that actually gated the merge.
