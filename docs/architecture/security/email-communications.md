# Email communications — welcome, daily mail, deactivation, opt-out

What email does in this system today, and what the requested lifecycle
(welcome on sign-up, daily mail afterwards, deactivation, and opting
out) would require. Sections marked **PROPOSED** do not exist; everything
else was verified in code. Do not quote a PROPOSED section as current
behavior.

## 1. What email is today (verified)

Email in cfagent is a **trading and response channel**, not a lifecycle
or marketing channel:

- **Inbound:** Cloudflare Email Routing delivers mail to the worker's
  `email()` handler (`handleCloudflareEmailMessage`), which parses
  intents (quotes, screener, portfolio, trade previews) and executes
  email-based order approval (`APPROVE <orderId>`) and rejection
  (`CANCEL <orderId>`) against the trade ledger, with human-in-the-loop
  order preview emails carrying agent DID attestation.
- **Outbound infrastructure (exists):** `sendOutboundEmail` via the
  Cloudflare Email Sending binding (`env.EMAIL.send`, raw MIME). Today
  it sends: replies to inbound emailed queries, HITL order preview
  emails, and outbound transaction receipts.
- **Other channels:** scheduled and screener notifications go to Slack
  (e.g. `#screener_slack_channel`), not email. There is no digest,
  drip, or newsletter sender anywhere in the codebase.

## 2. What does NOT exist today (verified absences)

| Requested item | Status |
| --- | --- |
| Welcome email on sign-up | **Does not exist.** The only "welcome" in code is a voice-trading greeting string, unrelated to email or sign-up. No sign-up email is sent on first login or first provisioning. |
| Daily emails after sign-up | **Do not exist.** No daily digest, onboarding drip, or recurring user email sequence. Scheduled work exists (ticks, research, reflection) but delivers via Slack/in-app, not email. |
| User notification preferences | **Do not exist.** No per-user email preference store, no settings surface for mail, no category toggles. (Unrelated "unsubscribe" hits in code are event-emitter and market-stream unsubscribes, not email opt-out.) |
| Email opt-out / unsubscribe | **Does not exist** for user mail — there is no user mail to opt out of. Transactional trading mail (previews, receipts) has no unsubscribe mechanism either, by the same absence. |
| Self-service account deactivation | **Does not exist** as a route (see [identity-lifecycle.md](identity-lifecycle.md) §8). |

The absence of user mail is, paradoxically, the current privacy posture:
the system cannot spam, leak, or mis-target mail it never sends. Any
proposal below must preserve that property for users who never opt in.

## 3. PROPOSED: welcome email on sign-up

**Trigger — first provisioning, not first login.** Login and
provisioning are different lifecycle states
([identity-lifecycle.md](identity-lifecycle.md) §1): a user who signed
in but holds no membership has not joined anything, and mailing them a
"welcome" would be wrong. The welcome trigger is the first membership
grant for an internal id (bootstrap-on-login or admin grant), detected
in the post-login runner / grant path — not in the login path.

**Content (proposal):** what the user joined (tenant), what they can
do, where to manage their account, and how to stop mail (linking §5).
No credentials, no tokens, no membership details beyond what the user
already holds. **Delivery:** the existing `env.EMAIL.send` path; the
send is best-effort and must never block provisioning (a failed welcome
mail is logged, not retried into a provisioning failure).

## 4. PROPOSED: daily emails after sign-up

**What they are (proposal):** a daily digest for opted-in users —
account-relevant summary (positions/screener highlights the user
already has access to), never new authority, never trade execution by
email reply unless the user separately uses the existing inbound trading
channel. Cadence is daily, driven by the existing scheduled tick
infrastructure, with a durable per-user per-day guard (the same
fire/no-fire pattern as [workflow-security.md](workflow-security.md) §2)
so a redeploy never double-sends.

**Suppression rules (proposal, non-negotiable):**

- No digest to an identity with no membership (deprovisioned users get
  nothing).
- No digest to a user who opted out (§5) — checked at send time, not
  at schedule time, so an opt-out takes effect the same day.
- No digest on a day the user has no content: an empty digest is spam
  with better formatting. Skip and record the skip.
- Digest content is per-user and per-tenant: never a shared blast.

## 5. PROPOSED: notification preferences and opt-out

**Model (proposal):** a per-user preference record (new store — it does
not exist today), keyed by internal id, with one toggle per category:

| Category | Default | Opt-out allowed? |
| --- | --- | --- |
| Welcome (one-time) | Sent once on first provisioning | N/A (single send; no list to leave) |
| Daily digest | **Off** (opt-in, not opt-out) | Yes, at any time, effective same day |
| Trading receipts + HITL previews | On (transactional) | No — these are receipts for the user's own actions; suppressing them would hide executions. A user who wants no trading mail must not use email trading. |
| Security mail (deactivation receipt, suspicious-activity notice) | On | No — security mail is the receipt for safety actions, including deactivation itself |

**Mechanisms (proposal):** an authenticated preferences surface (the
honest mechanism — the user manages mail while signed in), plus a
one-click unsubscribe link in every digest carrying a signed,
single-purpose token that flips only the digest toggle (no login
required, no other toggle affected, token expiry enforced). An
unsubscribe must be confirmed in the response ("you are unsubscribed
from the daily digest") — a silent 200 that changes nothing is a dark
pattern, and a token that flips everything is a vulnerability.

**Deactivation coupling (proposal):** deactivation
([identity-lifecycle.md](identity-lifecycle.md) §8) sets every
suppressible toggle off and stops all digest mail, but still delivers
the one security receipt for the deactivation itself. Re-provisioning
does **not** silently re-enable the digest: the preference record
survives deactivation (it is a preference, not authority), and the user
re-opts in explicitly.

## 6. What building this requires (proposal scope)

1. Preference store + authenticated preferences surface + unsubscribe
   token mechanism (§5).
2. Welcome trigger in the post-login/grant path (§3), best-effort send.
3. Digest builder + scheduled send with per-user per-day guard (§4).
4. Deactivation wiring to set toggles off (§5 coupling) — depends on
   the deactivation route itself ([identity-lifecycle.md](identity-lifecycle.md) §8).
5. Audit: every send category, every toggle change, and every
   deactivation-coupled suppression recorded; a send to an opted-out
   user is a bug with an audit trail, not an accident without one.

Nothing in §3–§6 is implemented. The sending primitive
(`env.EMAIL.send`) and the scheduled-tick + durable-guard patterns are
real and reusable; the preferences, triggers, and digest content are
new work, and the welcome/digest features must ship as **opt-in**
(default digest off) or not at all.
