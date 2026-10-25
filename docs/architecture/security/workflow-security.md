# Workflow security — unattended work

How work that runs without a user in the room is authenticated,
authorized, and guarded. User-driven work is in [authn.md](authn.md) and
[authz.md](authz.md); the background identity exception is tracked in
#1066 and documented in [etrade.md](etrade.md) §7.

## 1. Unattended work has an identity problem

Cron ticks, queue jobs, and renewal passes have no session. Today they
run as the synthetic `default_trader` identity, hardcoded in the worker
`scheduled()` and `queue()` handlers. That identity is the consumer of
the process-wide static E*TRADE token pair (see [etrade.md](etrade.md)
§7): background jobs stand or fall with one env-bound credential, and
their actions are attributed to a made-up name.

The #1066 plan replaces it with an explicit, non-secret **service
identity** whose token is obtained through the normal 3-legged flow and
stored like any user's — same expiry, renewal, revocation, and audit.
Until that lands, every claim in this doc about background work carries
the `default_trader` caveat, and no background path should be described
as "the user's" work.

## 2. What runs unattended

| Work | Trigger | Guard (fire/no-fire decided inside) |
| --- | --- | --- |
| ScheduledAgent tick (due goals, budget checks, Orchestrator jobs) | `*/30 * * * *` | Inside the tick route |
| Daily options-research run | Rides the 30-min tick (Workers Free ceiling: 5 cron triggers/account) | Weekday, ≥ 21:00 UTC, not already fired today (durable guard in `mas_settings`) |
| Weekly reflection job (#705) | Rides the 30-min tick | Sunday, not already fired this week |
| Weekly strategy-weight adjustment (#754) | Rides the 30-min tick | ISO-week guard + adaptation kill switch in `mas_settings` |
| E*TRADE token renewal | `0 3 * * *` | Iterates every stored token; renews unexpired ones |
| Nightly message retention (#255) | `0 4 * * *` | Retention window enforcement + one `mas_events` row per run |
| Options-analysis queue jobs | Queue messages | Ack on success, retry on failure; per-message `taskType` dispatch |
| Hourly Market Screen | Screener schedule | Durable per-minute execution claim (`screening:scheduled:last-slot:…`) suppresses duplicate delivery |

Guards are durable (stored state), not in-memory: a redeploy or a
duplicate delivery must not double-fire a job. "Skips are cheap and
explicit" is the design rule — a tick that decides not to fire still
records the decision.

## 3. The kill switch is a security control

The adaptation kill switch (#754, in `mas_settings`) can stop the
strategy-weight adjustment loop. It is not a feature flag: it is the
mechanism by which bounded adaptation stays bounded. Any workflow that
changes weights, budgets, or trading posture without consulting a kill
switch is outside the governed path, and the CISO clarification on
"kill switch as a measurable objective" (#907) is the reason this is
stated as a control rather than an option.

## 4. Routing and attribution for background calls

Background dispatches go to Durable Objects with an `x-user-login`
header set to the background identity — the same header user-driven
forwards carry, with a synthetic value. Downstream code therefore
cannot distinguish "background" from "user" by the header alone; it
distinguishes them by the identity value. That is exactly why the
service-identity migration matters: once background work carries a
distinct, real authorization, attribution stops depending on a name
everyone knows is fake.

Queue handling deserves one explicit note: a message is acked only
after its job is dispatched, and retried on failure. A poison message
that always fails is therefore retried, not dropped — retention and
dead-letter behavior for the queue is an open gap, not a verified
control.

## 5. Rules for adding unattended work

1. Name its identity explicitly. "Runs as the system" is not a name.
2. Give it a durable fire/no-fire guard. A cron schedule is not a guard.
3. Give it a kill switch if it changes anything consequential
   (weights, budgets, trades, memberships).
4. Make its audit events attributable to its identity, distinguishable
   from any real user.
5. Never let it fall back to a user identity silently. If it needs a
   user's authority, that authority is delegated explicitly (see
   [authz.md](authz.md) §5) or the job fails loud.
