# changelog.d — per-PR changelog fragments

A PR adds one file here and never touches `CHANGELOG.md`. That ends
the prepend race: under rebase-only merges, every PR touching the same
shared file guarantees conflicts whenever main moves (it killed #1650
and stalled #1791). No two PRs ever write the same fragment file, so
fragments merge cleanly.

## File name

`changelog.d/<issue>-<slug>.md` — the issue the PR fixes, plus a short
slug for the change. Same issue, different slug = different file, no
collision. If a filename collides (e.g. a rescue PR redoing the same
work), rename your slug.

## Format

The first non-empty line MUST be a `### <Section>` header
(`Added`, `Fixed`, `Changed`, `Removed`, `Security`, ...), followed by
at least one entry line. A fragment MAY contain several `### ` sections
(one PR touching Added and Fixed writes one file, not two). The Policy
Gate (check (d)) enforces the header-plus-entry minimum: a fragment
with no header, or a header with no entry, fails the gate.
Entries are single-line `- ` bullets, in the same voice as
`CHANGELOG.md` entries (bold summary, issue reference).

```markdown
### Added

- **Changelog fragments (#1801):** PRs add one file under `changelog.d/` instead of touching CHANGELOG.md.
```

## Lifecycle

- **PR time:** the fragment is the PR's changelog record. Policy Gate
  (d) accepts a fragment instead of a `CHANGELOG.md` entry (a direct
  entry still passes, for backward compatibility).
- **Release notes:** `scripts/ci/release-notes.mjs` reads this directory
  by default when it exists and appends fragment entries to the curated
  body, above the generated commits. `deploy.yml` needs no change.
- **Release time:** the release PR runs
  `scripts/ci/assemble-changelog.mjs --tag vX.Y.Z`, which moves the
  `## [Unreleased]` entries plus all fragments into a new versioned
  section and deletes the folded fragments, so the next release cannot
  double-count them. `CHANGELOG.md` itself stays the published
  artifact — fragments are its per-PR source, not its replacement.
