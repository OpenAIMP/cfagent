#!/usr/bin/env bash
# Shared Cloudflare Worker secret-push helpers (issue #590).
#
# Sourced by .github/workflows/deploy.yml:
#     source scripts/ci/put-secret.sh
#
# One implementation instead of three copies: the #590 segfault existed in
# triplicate precisely because every secret step carried its own wrapper.

# summary <line> — append a line to the job summary when GitHub provides one.
summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# put_secret <name> — push stdin as the secret value.
# Three attempts, 90s per attempt, 10s then 20s backoff. Fails closed on empty.
put_secret() {
  local name="${1:?put_secret requires a secret name}"
  local attempts=0 max=3 payload backoff
  payload="$(cat)"
  if [ -z "$payload" ]; then
    echo "::error title=Secret push failed::$name has no value; refusing to push an empty secret" >&2
    summary "- \`$name\` **empty — refused**"
    return 1
  fi
  while [ "$attempts" -lt "$max" ]; do
    # Bound each attempt: a hung Cloudflare API call must fail and retry, not
    # sit until the job timeout.
    if printf "%s" "$payload" | timeout 90 npx wrangler secret put "$name"; then
      summary "- \`$name\` pushed"
      return 0
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -lt "$max" ]; then
      backoff=$((attempts * 10))
      echo "put_secret: '$name' failed (attempt $attempts/$max), retrying in ${backoff}s..." >&2
      sleep "$backoff"
    fi
  done
  echo "::error title=Secret push failed::$name failed after $max attempts" >&2
  summary "- \`$name\` **failed after $max attempts**"
  return 1
}

# require_secret <name> <value> — push, and fail when an expected secret is empty.
require_secret() {
  local name="$1" value="${2:-}"
  if [ -z "$value" ]; then
    echo "::error title=Missing secret::$name is not configured for this environment" >&2
    summary "- \`$name\` **missing**"
    return 1
  fi
  printf "%s" "$value" | put_secret "$name"
}

# optional_secret <name> <value> — push when configured, report when absent.
# Absence is a warning, not a failure — but it is never silent.
optional_secret() {
  local name="$1" value="${2:-}"
  if [ -z "$value" ]; then
    echo "::warning title=Secret not configured::$name is empty; skipped (optional for this deployment)" >&2
    summary "- \`$name\` not configured (skipped)"
    return 0
  fi
  printf "%s" "$value" | put_secret "$name"
}
