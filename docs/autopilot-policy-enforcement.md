# Autopilot policy enforcement

*Phase 1 of the autopilot hardening work (see the linked issue). This document
describes the policy envelope that now sits between an order idea and the
broker.*

## The problem this closes

The Autopilot Control Center displayed four limits — max position, cash reserve,
orders/day, drawdown alert — and the line **"Enforced at runtime by
RiskPolicyEngine & W3C Agent DID"**. Before this change:

- `RiskPolicyEngine` did not exist anywhere in the repository; the string
  appeared exactly once, as that label.
- The "Run Policy Check" button decided pass/fail with
  `Math.random() > 0.15` in the browser and then wrote the result to the audit
  ledger.
- No server path consumed the limits: `maxPositionPct`, `cashReservePct`,
  `ordersPerDay`, and `drawdownAlertPct` occurred only inside
  `AutopilotControlCenter.tsx`.
- Run state, limits, and the kill switch lived in `localStorage`, so a page
  reload cleared the kill switch and a second browser ran its own envelope.
- The ledger mapper synthesised a signature (`sig_ed25519_<event id>`) for any
  row that lacked one, so a row could not be told apart from a fabricated one.

## What the envelope is

`src/services/riskPolicyEngine.ts` is a pure, deterministic evaluator. Rules are
applied in order; the first blocking finding becomes `bindingRule`:

| # | Rule | Fails when | Severity |
|---|---|---|---|
| 1 | `kill-switch` | the platform kill switch is active | block |
| 2 | `autopilot-paused` | autopilot is not running | approval |
| 3 | `insufficient-data` | equity, notional, cash, or per-symbol exposure is unknown | block (autonomous) / info (hitl) |
| 4 | `drawdown-alert` | peak-to-trough drawdown ≥ the alert | block |
| 5 | `orders-per-day` | broker submissions today ≥ the budget | block |
| 6 | `max-position` | projected single-name exposure > the cap | block |
| 7 | `cash-reserve` | projected cash after a buy < the reserve | block |
| 8 | `outside-universe` | symbol outside a configured allowlist | block |

Modes:

- **`autonomous`** (autopilot running) — every rule is a hard gate; a blocked
  verdict means `executionAllowed: false`.
- **`hitl`** (autopilot paused) — findings are advisory and `executionAllowed`
  stays `true`, because a human is the authorizer. This is the product's
  "pausing sends new ideas to approval instead".

`evaluatePolicy` is pure: same inputs ⇒ same verdict ⇒ same `verdictId`. Unknown
inputs are `null` and fail closed in autonomous mode — they never read as safe.

## Where it is enforced

| Surface | Behaviour |
|---|---|
| `POST /api/etrade/order/preview` | Evaluates and records a verdict; returns `409` with the verdict when a running autopilot blocks the order. |
| `POST /api/etrade/order/execute` | Re-evaluates with fresh state (orders/day, drawdown and exposure may have moved since the draft); `409` when blocked; on success the daily counter increments. |
| `POST /api/autopilot/evaluate` | Dry-run evaluation used by the control center's "Run Policy Check"; records a signed verdict. |
| Control center UI | Reads state from the server, writes run state / limits / kill switch to the server. |

The HITL gate is untouched: `/etrade/order/execute` still refuses `did:agent:*`
callers. Phase 1 does not add autonomous execution — it makes the envelope real
around the path that already exists.

## State and endpoints

Run state and limits live in the Durable Object (`mas_autopilot`), verdicts in
`mas_policy_verdicts` (append-only).

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/autopilot` | GET | run state, limits, daily usage, recent verdicts |
| `/api/autopilot/state` | POST | `{ running: boolean }` |
| `/api/autopilot/kill-switch` | POST | `{ active: boolean, reason?: string }` |
| `/api/autopilot/limits` | PUT | `{ limits: AutopilotPolicyLimits }` (normalised + clamped) |
| `/api/autopilot/evaluate` | POST | `{ symbol, action, quantity, dryRun? }` → signed verdict |

## Signatures

Verdicts are signed in the Worker with HMAC-SHA256 over a canonical payload,
using a key derived from `SESSION_SECRET` with the label
`autopilot-verdict-v1`. `verifyVerdictAttestation` re-derives it, so any ledger
row can be checked. The browser never signs a policy decision, and the ledger
mapper no longer invents signatures: an unsigned row renders `UNSIGNED`.

## Failure behaviour

If the envelope cannot be evaluated at all (for example the signing key is
missing), the request fails closed **while autopilot is running** (`503`) and
fails open with a recorded `autopilot.policy_check_failed` event while it is
paused, so a human authorizer is never blocked by an engine outage.

## Known limits (tracked as follow-ups)

- Daily order budgets roll at 00:00 UTC, not exchange-local midnight.
- Per-symbol exposure is derived from executed trades in `mas_trades`; a
  canonical live-book feed is not wired up yet, and a null result fails closed.
- The approval queue is still a status (`routed_to_approval`), not a durable
  work item with a signed resume path.
- The audit ledger is append-only but not yet hash-chained, so tamper-evidence
  relies on the per-verdict signature.
- Cross-channel order paths (Slack / voice / email) hold this envelope only
  through `/api/etrade/order/preview` + `/execute`; a channel-level gate is not
  yet asserted by tests.
