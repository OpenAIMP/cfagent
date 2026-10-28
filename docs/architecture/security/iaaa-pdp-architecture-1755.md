# IAAA PDP architecture — #1755 decisions and build

Parent program: #1717 (system-wide duplicate/overlap unification).
Slice: #1755. Decisions recorded on #1755 (comment 6463655721) before
the build portion started. This slice changes where policy lives and
how it is served. It changes no enforcement decision.

## Decisions

### (a) Policy store/editor — tables stay authoritative; portable form + store interface added; no editor

- The `ROLE_GRANTS` tables in `src/security/authorization.ts` stay
  the authoritative policy. They are reviewed code, versioned by
  git, and gated by CI + Policy Gate.
- The tables gain a portable form: `PolicySnapshot` (version +
  permissions + role grants as JSON data) with `exportPolicySnapshot()`
  and a validated `parsePolicySnapshot()` in `src/security/pdpPorts.ts`,
  served through the `PolicyProvider` port.
- The compiled tables are the default provider. The only alternative
  source is a platform-configured snapshot: `IAAA_PDP_POLICY_SOURCE`
  (`code` | `snapshot`, case-insensitive, blank/unset = `code`) plus
  `IAAA_PDP_POLICY_SNAPSHOT_JSON`. Invalid source or snapshot fails
  closed to compiled, with `invalid=true` so the misconfiguration is
  visible. No production value is set by this slice: unset = compiled.
- The switch is platform-only by design. There is no run, session,
  or user carrier for it: a caller-choosable policy source would let
  a gated subject pick its own policy, which the program's security
  guard forbids. Enforcement switches stay admin/platform-controlled
  and fail closed; this one additionally has no caller input path
  at all.
- No policy editor is built here. A runtime editor would be a second
  source of truth and an unaudited privilege path; it needs its own
  approval/audit design as a follow-up. No XACML conformance is
  claimed: the snapshot is portable JSON, not an XACML policy set,
  and versioning is still the single string `iaaa-authorization-1`.

### (b) PDP service boundary — stays in-process; gains a logical service boundary; no network endpoint

- The PDP is a pure, synchronous function with no I/O. A network hop
  would add latency, an availability dependency, and a newly
  authenticated surface to protect, with no consumer needing
  independent deployment or scaling — the PDP ships with the Worker.
- The logical boundary is the `PolicyDecisionPoint` port in
  `src/security/pdpPorts.ts`: `PdpDecisionRequest` (plain data) in,
  `AuthorizationDecision` (plain data) out. Both are JSON-serializable
  by construction, pinned by test. The only live adapter is the
  in-process one (`createInProcessPdp`), which runs
  `authorizeWithPolicy()` over the provider's policy and the PIP's
  attributes.
- No PDP HTTP endpoint and no independent deployment are added. An
  endpoint would be a new privileged surface needing its own threat
  review. A future network PDP is a new adapter behind the same
  port, not a rewrite.

### (c) PEP/PIP consolidation — no single runtime gateway; one gateway pattern + a real PIP port

- No single runtime gateway: `requireAuth` (authentication, 401)
  must precede any permission evaluation; the `integration:connect`
  gates need session + tenant resolution + the #1749 legacy-grace
  rule; the schedule and access-request gates have their own
  preconditions. One gateway swallowing them would duplicate those
  preconditions or change enforcement.
- The consolidation is the pattern: `evaluateRoutePep()` in
  `src/security/pepGateway.ts` centralizes the `shouldEnforcePdp` +
  PDP decision + grace-expired-403 mapping that was copy-pasted,
  identically, at the four `integration:connect` sites in
  `src/server.ts` (E*TRADE/Public start + verifier). All four sites
  now call it, with byte-identical responses (generic 403, or 403
  `legacy_pdp_grace_expired` for grace-expired legacy sessions).
- The PIP port is real: `AttributeProvider` in
  `src/security/authorization.ts` (`getMembershipsByUser`). The PDP
  core, `authorizeWithPolicy(policy, attributes, request)`, reads
  memberships only through it. `authorize()` and `canGrantRole()`
  are thin adapters over it (compiled policy + store adapted to the
  port), and `checkPermission()` keeps its signature while routing
  through the same core. No PDP code path reads a store directly
  anymore. The only live attribute source is still the SessionStore
  membership store — no federation, transformation, or caching
  layer exists yet; the port is where one lands.

## What is still honestly not true

- No policy editor; no XACML evaluation; no policy-set versioning.
- No PDP network endpoint, deployment, or remote adapter.
- No single runtime gateway; the session, schedule, and
  access-request PEPs are unchanged.
- No live route consumes a snapshot policy: the snapshot path is
  unit-pinned and gateway-pinned, but production runs compiled
  policy until the owner configures a platform snapshot.
- No obligation/evaluator wiring change: `evaluateWithObligations()`
  (#1751) still wraps the seam, unchanged.

## Files

- `src/security/authorization.ts` — `PolicySnapshot`,
  `getCompiledPolicySnapshot()`, `AttributeProvider`,
  `membershipStoreToAttributeProvider()`, `authorizeWithPolicy()`;
  `authorize()` / `canGrantRole()` delegate through the PIP.
- `src/security/pdpPorts.ts` — snapshot export/parse,
  `PolicyProvider`, `resolvePdpPolicySource()`,
  `PolicyDecisionPoint`, `createInProcessPdp()`.
- `src/security/pepGateway.ts` — `evaluateRoutePep()`.
- `src/security/iaaaPdpSeam.ts` — seam routes through the PIP core.
- `src/server.ts` — four `integration:connect` sites use the gateway.
- `tests/iaaa_pdp_architecture_1755.test.ts` — conformance suite.
- `docs/architecture/security/authz.md` §10 — updated to this state.

#CISO-bhdm
