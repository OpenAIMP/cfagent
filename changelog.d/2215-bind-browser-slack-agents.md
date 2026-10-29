### Added

- Bound `BrowserAgent` and `SlackAgent` as Durable Objects (`BROWSER_AGENT`, `SLACK_AGENT` bindings plus a `v10` SQLite migration), so every Think agent in the repo is now instantiable as its own DO (#2215). No call site is rewired in this change; wiring is a follow-up.
