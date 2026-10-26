# Scan appendix (o) — PAYMENTS RE-SCOPE — parent #1717

## Agent

#CISO-bhdm

Scan head: `23de3ce`. Main doc: `docs/compliance/system-duplicates-scan-1717.md`.
This appendix covers a PROGRAM SLICE, not a scan finding. Payments #1690/#1711
is DONE; no rebuild slice for it exists except this re-scope.

## Current state (confirmed, #1711)

- Switch `PAYMENTS_FLOW_MODE` (`src/agents/routes/payments.ts`,
  `resolvePaymentsFlowMode`, and `src/types.ts`): `hitl` | `immediate`,
  case-insensitive, blank/unset → `hitl`, unrecognized → `hitl` fail-closed with
  a `payment.config_error` audit.
- HITL = #1690 draft/confirm (no checkout at create); immediate = the pre-#1690
  route behavior recovered verbatim (checkout at create, `pending_checkout`,
  `PAYMENT_GATEWAY_ERROR` at create, confirm creates a checkout only if missing,
  missing draft silently succeeds). HITL default stands.
- The switch today is a SINGLE GLOBAL value (Worker env). Setting the production
  value is an owner action (wrangler.jsonc vars or dashboard, then redeploy).
- Known limitation carried forward (not fixed by #1711, recorded in appendix (h)
  P-2): MCP confirm does not check a success flag on facade `createCheckout`, so
  a failed checkout could still mark a draft completed. The re-scope slice must
  not claim to fix this unless it actually does.

## The re-scope slice

- The existing global `PAYMENTS_FLOW_MODE` STAYS as the global fallback.
- Resolution becomes scoped, in this order: run-scoped value > session-scoped
  value > user-scoped value > global env default > built-in default (HITL for
  payments).
- Where a scoped override path does not exist yet, building it is part of this
  slice. The slice resolves switches inside the execution context
  (`McpToolContext`/route ctx: `sessionId`, user, run), with global env only as
  fallback — per the owner-confirmed 2026-10-26 reading of run/session/user scope
  as the execution context.
- HITL remains the built-in default. An invalid scoped value fails closed to
  HITL, logged + audited as `payment.config_error`, exactly as an invalid global
  value does today.
- Security Guard interaction: scoped resolution here is about which money-flow
  variant (draft-first vs immediate-checkout) an execution uses — both variants
  are owner-governed flows with their own audits. Scoping must never let a
  caller disable the confirm-time HITL gate itself where the HITL flow applies;
  behavior variants are configurable, enforcement is not opt-out. The slice's PR
  body and §15 must record the resolution order explicitly, per mode, with Red
  pins for both modes (HITL and immediate) under each scope level that the slice
  introduces.

## Out of scope for (o)

- Rebuilding the #1690 draft/confirm flow, the #1711 switch semantics, the
  gateway plane, the agentic plane, or premium gating (appendix (h)).
- Changing the production `PAYMENTS_FLOW_MODE` value (owner action).
- Any endpoint removal or code-path deletion (standing rules).
