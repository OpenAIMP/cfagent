### Agent Mesh S16 — G14 per-agent identity (#2426)

- Registry identity records (MESH_IDENTITIES): every fleet class now
  carries its DID/identity derivation, mesh credential, and
  attribution shape, drift-pinned against the fleet roster, the A2A
  resolutions, and the credential module.
- Per-agent A2A mesh credentials: each of the 15 A2A surfaces has its
  own env secret (A2A_TOKEN_<SURFACE>), verified timing-safely at the
  edge; a surface with its own secret accepts only it. The shared
  A2A_API_TOKEN remains as the recorded TRANSITIONAL fallback for
  surfaces whose secret is unset (removal condition in the registry
  and the issue's §15).
- Two-part attribution: the edge passes the authenticated caller into
  handleA2A; the payments path records it beside the agentId in the
  payments_agent.recorded audit payload.
- Attestation is keyed-or-labelled: with DID_ATTESTATION_KEY set,
  createDidAttestation produces a real HMAC-SHA256 proof
  (verifyDidAttestation added; payments service, MAS, MCP commands,
  facade, and think-harness call sites thread the key); without a
  key the value is labelled UnkeyedContentLabel2026 and never
  verifies. The sync variant and the DID document are relabelled to
  match.
- Synthetic identities retired: DID derivations fail closed on an
  empty login (no more "anonymous" DIDs); ScreenerAgent goal-gather
  paths thread the run owner's login as tenantId (the "default"
  literal is gone); ScheduledAgent's reconciliation audit row
  carries the threaded operator login or the named
  SCHEDULED_AGENT_AUDIT_ACTOR (the "system" literal is gone).
- Conformance matrix: SlackAgent identity GAP -> IMPLEMENTED;
  totals 59 IMPLEMENTED / 82 NOT-APPLICABLE / 27 GAP of 168, zero
  unclassified.
