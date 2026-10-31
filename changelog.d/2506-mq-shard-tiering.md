### Changed
- Split `ci.yml` test shards into `test-shard-pr` (parallel with fast-gates on pull_request) and `test-shard-mq` (needs fast-gates on merge_group), so stacked Merge Queue batches wait for typecheck/build before burning 4 shard runners. Required check `Test & Build (Node 22) [PROD]` is unchanged in name.
