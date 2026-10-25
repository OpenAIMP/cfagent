# Emergency-Authority Register — DRAFT, NOT ADOPTED — FOR OWNER APPROVAL

> **DRAFT — NOT IN FORCE.** This register is a draft prepared for owner
> approval. **No entry in this document is in force until the human owner
> approves it**, entry by entry, and that approval is recorded in §7.
> Until approval exists, the charter rule applies (§6, ciso.md):
> *if no emergency authority exists, escalate and recommend the exact
> action.* Nothing in this draft grants authority by itself, and nothing
> in it may be read as an approval already given.

**Subject:** §17 charter artifact 9 — Emergency-authority register, for the
RSI-CISO Agent (role identifier `ciso`).
**Role:** RSI-CISO Agent — security requirements + assurance; reports to the
human CEO/owner.
**Human owner (per charter §18 assignment):** Mubasher — the human
security-accountable executive and risk owner. Material risk acceptance
stays with the human owner, never with the RSI-CISO acting alone.
**Charter basis:** `docs/agentic-org/ciso.md` §5 (decision rights), §6
(emergency authority and containment), §13 (governed meta-improvement),
§17 item 9 (required executive artifacts), §18 (initial assignment).
**Baseline verified for this draft:** cfagent main `b1fc5ca`.
**Status:** DRAFT. Filed in
`docs/architecture/security/emergency-authority-register.md`, per the
durable-docs rule. Not posted to any issue.
**Signed:** #CISO-bhdm

---

## 1. What this register is — and what it is not

Emergency authority, under §6, must be defined *before* an incident.
Each pre-authorized action must specify: trigger, permitted target,
exact action, maximum scope, duration, expected customer impact,
evidence requirements, notification, reversal or recovery procedure,
and human owner. This register is that definition, in draft form.

It is **not** a grant of new power. The charter is explicit, and this
draft preserves every bound in it:

- The charter **does not grant** credentials, access to customer
  records, permission to conduct intrusive testing, or authority to
  change production systems (ciso.md, preamble and §5).
- The RSI-CISO must not weaken controls, expand its privileges, or
  approve its own changes (§5, prohibited self-authorization).
- The RSI-CISO must not autonomously modify its own emergency powers
  (§13). Only the human owner can approve, amend, or revoke an entry
  here — including the entries in §4, which exist precisely so the
  owner can decide them rather than the role deciding them itself.
- "Emergency" is never a bypass for unrelated governance (§6). An
  invocation of one entry authorizes exactly that entry's action, for
  exactly its stated scope and duration, and nothing else.

"Containment" in this register therefore means **least-disruptive
containment within the role's existing authority envelope**, plus —
only after owner approval — the specific entries the owner chooses to
pre-authorize in §4. Everything else is recommendation and escalation,
however urgent the incident feels.

## 2. Invocation procedure (applies to every entry)

1. **Observe and evidence.** Record what was observed, the attributable
   evidence, and why the entry's trigger condition applies. An alert is
   not, by itself, a confirmed incident; a trigger that requires
   *confirmed* exposure requires evidence, not suspicion.
2. **Match exactly one entry.** If no entry matches, do not improvise
   one: escalate to the human owner with the exact action recommended
   (§6). If two entries match, use the least disruptive one that
   addresses the confirmed exposure.
3. **Act within scope and duration only.** Never widen scope, extend
   duration, or chain entries to reach an action no single entry
   permits. An extension past an entry's maximum duration requires
   fresh human-owner approval before expiry — the role never
   self-extends.
4. **Preserve evidence.** Do not delete, alter, or conceal adverse
   evidence, audit, or monitoring data in the course of containment.
5. **Notify the human owner immediately.** Proposed channel and delay
   are in §7 as owner decisions (proposed: incident record plus a
   direct owner notification at invocation; the maximum delay is an
   owner decision, not a number this draft asserts as approved).
6. **Record the invocation.** Every invocation creates a record with
   all §6 fields: trigger, permitted target, exact action, scope,
   duration, expected customer impact, evidence, notification, and
   reversal/recovery. The record is attributable audit evidence, not a
   private note.
7. **Reassess before expiry.** Before an entry's duration ends, either
   reverse it (§5), or escalate to the owner for a decision (extend,
   replace with a stronger authorized action, or accept the residual
   risk). A time-bounded control left to lapse silently is a failure
   of this procedure, not a reversal.
8. **Verify the outcome.** Do not claim containment succeeded without
   verification (§6). Report what was verified, what remains
   unverified, and what exposure remains after reversal.

## 3. Part A — Proposed pre-authorized entries (within the §5 may-act envelope)

These entries are **proposed** for owner approval. They stay within
actions §5 already permits the role to take alone (inspect, analyze,
recommend, request a hold, stop its own work, run authorized
non-destructive checks, invoke explicitly preauthorized containment),
and they change no production system, no privilege, and no other
lane's work. Even these are NOT in force until the owner approves them
(see §7). Proposed durations below are proposals, not approvals.

### EA-01 — Stop the CISO lane's own work

| Field | Definition |
|---|---|
| Trigger | A §16 stop condition is met in the CISO lane's own work: testing authority is missing, scope is ambiguous, evidence integrity is uncertain, a proposed action may create disproportionate harm, required CI/CD is unhealthy, or a remediation outcome is unknown. |
| Permitted target | The RSI-CISO lane's own workstreams and child tasks only. Never another lane's work, never a production workload. |
| Exact action | Pause or stop the affected workstream; preserve all evidence and work products as-is. |
| Maximum scope | The affected workstream(s) only; no tool, token, route, or workload outside the lane's own work. |
| Maximum duration | **Proposed:** until the human owner reviews the stop condition and orders resume, or 72 hours, whichever is first — owner decision required (§7). If the owner has not ordered resume by expiry, the work stays stopped (fail closed); the role does not self-resume on expiry. |
| Expected customer impact | None direct; delayed security work only. Any customer-facing impact must be reported to the owner at invocation. |
| Evidence requirements | The §16 condition met, with the specific uncertainty or harm recorded. |
| Notification | Human owner at invocation (channel/delay per §7). |
| Reversal / recovery | Resume only on human-owner order that the condition is cleared, recorded in the invocation record. |

### EA-02 — Request a release hold

| Field | Definition |
|---|---|
| Trigger | Attributable evidence of a confirmed material exposure in a release candidate (not a scanner score alone, not an untested concern). |
| Permitted target | The specific release candidate. |
| Exact action | Issue a release-hold *request* to the release owner, with evidence and the exact remediation or verification required to lift it. |
| Maximum scope | That release candidate only. |
| Maximum duration | **Proposed:** until the human owner (or the release owner under approved policy) decides the hold — owner decision required (§7). |
| Expected customer impact | Delayed release only, unless the owner decides otherwise. |
| Evidence requirements | Confirmed material exposure, with evidence and the verification that would clear it. |
| Notification | Human owner and release owner at invocation. |
| Reversal / recovery | Hold lifted only by the deciding owner, recorded. |
| Binding note | Per §5, a release hold becomes binding **only where organizational policy grants that authority**. This entry does not itself make a hold binding; whether any policy grants that is an owner decision (§7). |

### EA-03 — Preserve evidence and open an incident record

| Field | Definition |
|---|---|
| Trigger | A confirmed incident, weakness, or control failure requiring an attributable record. |
| Permitted target | Approved security information already available to the role. Never customer records, never secrets, never data outside the role's approved scope. |
| Exact action | Copy/preserve the approved evidence into an incident record and open that record for the owner and authorized reviewers. No alteration of the source evidence. |
| Maximum scope | The incident's approved evidence set only. |
| Maximum duration | Preservation is not time-bounded by this entry; retention follows the approved evidence-retention policy (retention period is an owner decision, §7). |
| Expected customer impact | None. |
| Evidence requirements | The incident or weakness record itself, with sources cited. |
| Notification | Human owner at invocation. |
| Reversal / recovery | Not reversed; retention and disposal follow approved policy, never unilateral deletion by the role. |

### EA-04 — Refuse an unsupported security claim (assurance hold)

| Field | Definition |
|---|---|
| Trigger | A security claim presented for CISO assurance lacks attributable evidence, or its evidence contradicts the claim. |
| Permitted target | The RSI-CISO lane's own assurance statements only (its reviews, recommendations, and §15-style reports). Never another lane's claim, never a production control. |
| Exact action | Withhold endorsement and record the evidence gap and what evidence would close it. |
| Maximum scope | That claim only. |
| Maximum duration | **Proposed:** until evidence is supplied and independently reviewed — owner decision required (§7). |
| Expected customer impact | None direct; the unendorsed claim simply carries no CISO assurance. |
| Evidence requirements | The claim, the evidence offered, and the specific gap. |
| Notification | Human owner and the claim's owner at invocation. |
| Reversal / recovery | Endorsement may be given only after the evidence gap is closed and reviewed; the role does not silently reverse a refusal. |

### EA-05 — Run authorized non-destructive checks

| Field | Definition |
|---|---|
| Trigger | Triage of a confirmed or credibly reported weakness requires a check the role is already authorized to run. |
| Permitted target | Systems and data already within an approved investigation scope. |
| Exact action | Run the pre-approved, non-destructive check set only. No intrusive or adversarial testing, no production scanning with material load or side effects, no probing of unrelated systems, customer environments, or third-party services. |
| Maximum scope | The approved check set and investigation scope only. |
| Maximum duration | **Proposed:** a single investigation window, 24 hours — owner decision required (§7). A new window requires a new trigger and record. |
| Expected customer impact | None by design; any observed impact stops the check and escalates. |
| Evidence requirements | The question the check answers and its result, recorded. |
| Notification | Human owner at invocation if the check touches a production-adjacent system; otherwise recorded in the investigation record (owner decision, §7). |
| Reversal / recovery | Checks are read-only by definition; no reversal needed beyond stopping the check. |

## 4. Part B — Proposed entries REQUIRING an owner decision before they can be pre-authorized (NOT IN FORCE)

These are the containment actions §6 names as examples and §5 places
under "requires additional authorization": credential/token action,
permission changes, network blocking, workload shutdown, customer
account action, and anything touching a production system. **The role
may not invoke any entry in this part on its own authority.** Each is
drafted here so the owner can decide, entry by entry, whether it may
ever be pre-authorized — and if so, on what evidence standard, scope,
and duration — or whether it stays escalation-only forever. Until the
owner decides, every Part B action is escalation-only: the role
recommends the exact action to the human owner (or to the authorized
operations owner through the human owner) and does not perform it.

### EA-10 — Revoke one compromised integration token (charter §6 example)

| Field | Proposed definition (NOT approved) |
|---|---|
| Trigger (proposed) | Attributable evidence that a single named integration token is compromised, with confirmed exposure — not suspicion, not a scanner alert alone. |
| Permitted target (proposed) | That single named integration token only. Never a shared or platform token, never a token whose revocation would shut down an unrelated system. |
| Exact action (proposed) | Revoke that token through the authorized rotation procedure. |
| Maximum scope (proposed) | One token. |
| Maximum duration (proposed) | Revocation is permanent; replacement happens only through an owner-authorized credential-rotation procedure, never by the role restoring the token itself. |
| Expected customer impact (proposed) | Loss of that one integration until rotation completes; must be stated to the owner at invocation. |
| Evidence requirements | Compromise evidence, exposure assessment, and the rotation procedure to be followed. |
| Notification | Human owner before revocation where feasible, otherwise immediately after, with the rotation plan (owner decision, §7). |
| Reversal / recovery | Re-issue only via owner-authorized rotation. |
| **Owner decision required** | Whether token revocation may EVER be pre-authorized, and on what evidence standard. If the owner answers no, EA-10 stays escalation-only permanently. |

### EA-11 — Pause one affected tool or workflow in production

| Field | Proposed definition (NOT approved) |
|---|---|
| Trigger (proposed) | Confirmed evidence that one named tool or workflow is the vector of an active exposure. |
| Permitted target (proposed) | That one tool/workflow only. |
| Exact action (proposed) | Pause that tool/workflow. |
| Maximum scope (proposed) | One tool/workflow; no org-wide pause, no shutdown of an unrelated system. |
| Maximum duration (proposed) | 4 hours, then auto-resume unless the owner orders otherwise before expiry — owner decision required (§7), including whether auto-resume or fail-closed is correct here (contrast EA-01, which fails closed). |
| Expected customer impact (proposed) | Loss of that tool/workflow's function for the pause; must be stated at invocation. |
| Evidence requirements | Vector evidence and the verification that would justify resume. |
| Notification | Human owner at invocation. |
| Reversal / recovery | Resume with verification that the exposure is addressed; record the verification. |
| **Owner decision required** | Whether production tool pauses may ever be pre-authorized, the duration, and auto-resume vs. fail-closed. |

### EA-12 — Block one network source or route

| Field | Proposed definition (NOT approved) |
|---|---|
| Trigger (proposed) | Confirmed evidence of active abuse from one identified source or route. |
| Permitted target (proposed) | That one source/route only. |
| Exact action (proposed) | Block that source/route at the approved enforcement point. |
| Maximum scope (proposed) | One source/route; no broad network blocking. |
| Maximum duration (proposed) | 1 hour — owner decision required (§7). |
| Expected customer impact (proposed) | Loss of traffic from that source/route only; any wider impact stops the action and escalates. |
| Evidence requirements | Abuse evidence tied to that source/route. |
| Notification | Human owner at invocation. |
| Reversal / recovery | Unblock at expiry or on owner order, with verification that legitimate traffic is unaffected or the block is re-justified. |
| **Owner decision required** | Whether network blocking may ever be pre-authorized, and the duration. |

### EA-13 — Shut down one affected workload

| Field | Proposed definition (NOT approved) |
|---|---|
| Trigger (proposed) | Confirmed evidence that one named workload is actively causing material harm or exposure that no lesser action addresses. |
| Permitted target (proposed) | That one workload only. Never the organization, never an unrelated workload. |
| Exact action (proposed) | Shut down that workload through the authorized operations path. |
| Maximum scope (proposed) | One workload. |
| Maximum duration (proposed) | Until the owner orders restart — owner decision required (§7). |
| Expected customer impact (proposed) | Loss of that workload's function; must be stated to the owner at invocation, with the lesser actions already considered and why they were insufficient. |
| Evidence requirements | Harm/exposure evidence and the record of lesser actions considered. |
| Notification | Human owner at invocation (before shutdown where feasible). |
| Reversal / recovery | Restart only on owner order, with verification. |
| **Owner decision required** | Whether workload shutdown may ever be pre-authorized. The default, if the owner does not decide, is escalation-only. |

### EA-14 — Suspend one customer account (recommendation-only by construction)

| Field | Proposed definition (NOT approved) |
|---|---|
| Trigger (proposed) | Confirmed evidence of abuse by one identified account, with material exposure. |
| Permitted target (proposed) | That one account only. |
| Exact action (proposed) | **The RSI-CISO does not perform this action.** It recommends suspension, with evidence, to the human owner, who (through the authorized operations owner) performs or declines it. This entry exists so the recommendation path and its evidence standard are defined in advance — not to pre-authorize the role to suspend accounts, which would require customer-record access the charter does not grant. |
| Maximum scope (proposed) | One account. |
| Maximum duration (proposed) | As ordered by the human owner; not set by this register. |
| Expected customer impact (proposed) | Loss of account access; must be stated in the recommendation. |
| Evidence requirements | Abuse evidence tied to that account, and the lesser actions considered. |
| Notification | Human owner with the recommendation. |
| Reversal / recovery | By the authorized operations owner on owner order. |
| **Owner decision required** | Confirm that EA-14 is recommendation-only, or define a different authorized path (owner decision, §7). |

## 5. Explicit exclusions — never pre-authorized, never by an emergency claim

No entry in this register, and no invocation of one, authorizes any of
the following. Each requires its own separate authorization under
normal governance, and "emergency" does not change that:

- Expanding the role's privileges, or granting itself new capabilities.
- Accepting material risk on behalf of the organization.
- Changing organizational risk appetite.
- Weakening protected controls, or removing safeguards to accelerate work.
- Altering protected evaluation criteria, or modifying held-out security cases.
- Disabling audit or monitoring, or deleting adverse evidence.
- Approving the role's own production control changes.
- Modifying its governing instructions, or its own emergency powers (§13).
- Credential rotation beyond a Part B entry the owner has approved.
- Permission changes, source or configuration modification, repository mutations, or production deployment.
- External disclosure, or collection of additional personal data.
- Intrusive or adversarial testing outside an approved scope.
- Org-wide shutdown, broad network blocking, or suspension of accounts by the role itself.
- Surveillance beyond the role's approved scope, or autonomous retaliation ("hack back").
- Any action whose scope, duration, or target exceeds the invoked entry's stated limits — including chaining entries to reach a wider action.

## 6. Evidence, review, and expiry of this register

- **Invocation records** are attributable audit evidence, retained per
  approved policy (period: owner decision, §7), accessible to
  authorized reviewers.
- **Register review (proposed):** quarterly, and after any invocation,
  whichever is first — owner decision required (§7). Review covers:
  entries invoked, whether triggers matched correctly, whether scopes
  and durations held, reversals completed, and whether any entry
  should be narrowed, widened, or revoked.
- **Register expiry (proposed):** if the register is not re-approved
  at review, its entries lapse to escalation-only until re-approved —
  owner decision required (§7). Lapse is fail-closed, not a silent
  continuation.
- **Versioning:** this draft is version 0.1 (DRAFT). Adoption creates
  version 1.0 with the approval record in §7 filled in. Amendments are
  new versions, approved by the owner; the role never amends its own
  register in force.
- **What this draft does not do:** it does not select a notification
  tool, a rotation procedure, or an enforcement point. Those are
  implementation details the owner (with the CTO/operations owners)
  names at adoption; until named, the corresponding entry cannot be
  invoked, because its procedure is incomplete.

## 7. Owner decisions required — nothing below is decided by this draft

Adoption requires the human owner to decide, explicitly, each of the
following. Until each decision is recorded, the affected entry is not
in force. **Do not treat any proposed value in §§2–6 as approved.**

| # | Decision | Proposed value in this draft (NOT approved) | Status |
|---|---|---|---|
| D1 | Adopt this register at all, in whole or entry by entry | Whole-register adoption proposed; per-entry adoption also acceptable | PENDING |
| D2 | Approve each Part A entry's trigger, scope, and reversal (EA-01–EA-05) | As drafted in §3 | PENDING, per entry |
| D3 | Approve each proposed maximum duration | EA-01: 72h-or-owner-review; EA-02: until owner decision; EA-04: until evidence reviewed; EA-05: 24h single window | PENDING, per duration |
| D4 | Decide whether any Part B entry may EVER be pre-authorized (EA-10–EA-13), or stays escalation-only permanently | Each drafted as a proposal; default if undecided is escalation-only | PENDING, per entry |
| D5 | Approve Part B durations and EA-11's auto-resume vs. fail-closed question | EA-11: 4h auto-resume (proposed); EA-12: 1h; EA-13: until owner order | PENDING, per entry |
| D6 | Confirm EA-14 is recommendation-only | Recommendation-only as drafted | PENDING |
| D7 | Name the notification channel and maximum notification delay for invocations | Proposed: incident record plus direct owner notification at invocation; delay not asserted | PENDING |
| D8 | Decide whether an EA-02 release-hold request becomes binding under any policy, and which policy | Per §5: binding only where policy grants it; no policy named by this draft | PENDING |
| D9 | Set evidence-retention location and period for invocation records | Per approved policy; no period asserted by this draft | PENDING |
| D10 | Set register review cadence and lapse-on-non-renewal rule | Proposed: quarterly + after any invocation; lapse to escalation-only if not re-approved | PENDING |
| D11 | Name an alternate human owner if Mubasher is unavailable, or confirm there is none | None named by this draft; if none, invocations requiring owner action wait for the owner | PENDING |
| D12 | Confirm the scope boundary: entries apply to the CISO lane only, never to other lanes' work | CISO-lane-only as drafted | PENDING |
| D13 | Name the concrete rotation procedure, enforcement points, and notification tool for any approved Part B entry | None named by this draft; entry uninvokable until named | PENDING, per entry |

### Approval record (to be completed on adoption — blank by design)

| Field | Value |
|---|---|
| Approved by (human owner) | _— blank until adoption —_ |
| Approval date | _— blank until adoption —_ |
| Entries approved (list EA numbers) | _— blank until adoption —_ |
| Entries left escalation-only | _— blank until adoption —_ |
| Decisions D1–D13 as recorded | _— blank until adoption —_ |
| Register version on adoption | _— 1.0 on adoption —_ |

Until this table is filled, this document is a proposal. A future
reader must not mistake the draft's proposed values for approvals.
