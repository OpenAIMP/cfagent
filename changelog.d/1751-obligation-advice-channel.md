### Added

- **Obligation/advice channel (#1751):** obligations and advice now attach to policy (`src/security/obligations.ts`): step-up-as-obligation and audit-before-allow for `role:assign`, audit-before-allow for `membership:revoke` and `audit:export`, enforced by the PEP-side `evaluateWithObligations` wrapper around the PDP seam with fail-closed semantics, and policy advice delivered with allow and deny alike. Authz.md §10 updated; live route adoption is a named CTO-lane #945 wiring follow-up.
