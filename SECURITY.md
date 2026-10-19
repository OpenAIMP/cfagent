# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

Only the current `main` branch and the latest tagged release receive
security fixes. Fixes land as PRs against `main` and are released with the
next tag (see issue #256 for release-discipline tracking).

## Reporting a Vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

Instead, use GitHub's private security advisories:

1. Go to the repository's **Security** tab → **Advisories** → **Report a vulnerability**.
2. Describe the issue, the affected surface, and — if you have one — a
   minimal reproduction.

What happens next:

- You will get an acknowledgment within **5 business days**.
- We will confirm the finding, assess severity, and keep you updated while
  a fix is developed.
- We ask that you do not disclose the issue publicly until a fix is
  available and a coordinated disclosure date is agreed.

If private advisories are unavailable to you, contact the repository owner
through a private channel and reference this policy; do not post exploit
details in issues, PRs, or discussions.

## Disclosure Policy

- Valid reports are fixed on `main` first, then disclosed.
- We publish a GitHub Security Advisory once the fix is released,
  crediting the reporter unless they prefer to stay anonymous.
- We do not operate a bug-bounty program; reports are handled on a
  best-effort basis by the maintainers.

## Scope

In scope: the worker, agents, and edge routes in this repository —
in particular the webhook ingestion paths, the NLQ engine, outbound
webhook/email dispatch, and authentication/session handling. See
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the surfaces we
actively defend.

Out of scope:

- Third-party services the platform integrates with (E*TRADE, Slack,
  TradingView, Cloudflare AI Search, email providers) — report issues in
  those services to their own security contacts.
- Vulnerabilities that require a compromised maintainer account, a
  compromised Cloudflare account, or physical access.
- Denial of service via sheer traffic volume against Cloudflare's edge
  (rate limiting is in place, but volumetric absorption is the platform's job).
- Social-engineering or phishing against users or maintainers.
- Findings in vendored test fixtures or documentation-only content.

## Hardening Notes for Operators

- Every signing/verification secret (`INBOUND_NLQ_WEBHOOK_SECRET`,
  webhook provider secrets, Slack signing secret) **must** be configured
  in production. Verification is fail-closed: an unconfigured secret means
  the request is rejected, never accepted.
- Restrict `EMAIL_TO_ALLOWED_DOMAINS` to the domains you actually send to;
  without it, any syntactically valid address passes the format check.
- Keep `wrangler.jsonc` bindings and secrets out of version control —
  secrets travel via GitHub Actions secrets / the deploy workflow only.
