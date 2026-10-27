### Security

- **Legacy-session PDP grace bound (#1749):** a legacy (pre-wiring) session is PDP-exempt only inside its absolute session lifetime (createdAt + 7 days); past the bound, PDP-gated routes deny it with `legacy_pdp_grace_expired` until re-login through wiring. No caller-configurable switch: the bound reuses `SESSION_TTL`.
