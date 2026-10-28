### Added

- IAAA login-keyed state cutover decided and executed (#1759): alias-forever for DO names (`resolveDoNameForUser`) plus dual-read for E*TRADE tokens (internal-id key first, alias-login key second), provider-neutral user DIDs (`getLoginDid` / `getSessionDid` / `getDisplayUserDid`) so no session renders another provider's prefix in UI, and a follow-up obligation (§7) in the provider-onboarding checklist.
