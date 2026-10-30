### Fixed

- Scheduled E*TRADE guard (#2440): the guard now resolves the run-as login to its session identity via the alias record before checking tokens, so tokens stored under internal-id or alias-login keys resolve exactly as the panel seam resolves them — scheduled runs no longer fail FAILURE_AUTH_NO_SESSION for an already-connected account. No identity resolvable → today's login-only lookup, unchanged; unknown logins still fail closed.
