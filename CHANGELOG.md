# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release discipline

- **How to cut a release:** open a PR that moves the `## [Unreleased]` entries into a
  versioned `## [X.Y.Z] - YYYY-MM-DD` section. CI's *Test & Build* job
  (typecheck + vitest + build) is the required gate on every release PR.
- **Tagging:** after the release PR merges, place the tag `vX.Y.Z` on its merge
  commit (e.g. `git tag -a v0.1.0 <merge-sha> && git push origin v0.1.0`).
- **Semver rules:** MAJOR = breaking contract or API changes; MINOR = new
  capabilities, backward-compatible; PATCH = fixes with no contract change.

## [Unreleased]

Nothing pending yet — add entries here as work merges.

## [0.1.0] - 2026-10-18

First tagged release. Assessment P0 hardening wave (#143).

### Security

- **NLQ table allowlist** (#245): a 25-table allowlist derived from the NLQ
  planner's real targets; every other table is refused at the execution seam.
  Classic SQL injection was already closed by parameter binding — verified
  before the fix.
- **Webhook replay cache + `emailTo` domain allowlist** (#249): provider-derived
  nonces with 24h TTL; duplicate TradingView / E\*TRADE / NLQ deliveries are
  rejected 409 before any order mutation. `EMAIL_TO_ALLOWED_DOMAINS` restricts
  email delivery targets (inert until configured).
- **SSRF guard + rate limiting** (#242): URL validator on outbound webhook
  dispatch; token-bucket throttling (429 + Retry-After) on the NLQ webhooks and
  the memory search route.
- **Secret scanning** (#239, #251): gitleaks workflow installed and active;
  its pull-request scan path was broken by a missing `GITHUB_TOKEN` env and is
  now fixed — every PR is scanned.

### Added

- **Storage retention** (#262): nightly pass in the scheduler deleting
  `mas_messages` rows older than `MAS_MESSAGES_RETENTION_DAYS` (default 90,
  `<=0` disables), with a per-run cap and a `mas_events` summary record.
  This enforces the 90-day retention the UI advertises.

### Docs

- **Collaboration protocol** (#252): branch-as-lock shared rule for
  multi-agent coordination, documented in `docs/collaboration.md`.
