# Parity checklist (program #1736, issue #1746)

Paste into the PR body and tick each box with evidence. The harness
validates this file with `node scripts/parity.mjs check --checklist <file>`.

- [ ] Baseline snapshot captured (snapshot file / commit: ___)
- [ ] Behavior comparison run (compare output: ___)
- [ ] verify-before-merge.sh run on the rebased head (head: ___)
- [ ] Pin updates in the same PR (list them, or tick the next line instead)
- [ ] No pin updates in this PR
- [ ] Gate green (link: ___)
- [ ] Red checks diagnosed and classified (only when the gate is not green)
- [ ] Parity section in §15 written (comment id: ___)
