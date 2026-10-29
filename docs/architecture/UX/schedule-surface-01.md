# Schedules surface: one row per schedule (UX pattern 01)

| Field | Value |
|---|---|
| Status | Implemented (issue #2329) |
| Scope | The Schedules tab (`SchedulesPanel` → `ScheduledOptionsManager` / `ScheduledOptionsSection`) |
| Governs | `docs/agents/ux-architecture.md` §6 (primitives, tokens) and §20 (definition of done) |
| Pins | `tests/schedule_rows_2329.test.tsx`, `tests/schedule_ui_s7.test.tsx`, `tests/scheduled_options_manager.test.ts`, `tests/schedules_panel.test.tsx` |

## Decision

A schedule is rendered as **one table row**, not a card. The row carries the
facts a reader scans for, and every action sits in that row's single actions
cell:

| Column | Contents |
|---|---|
| Schedule | Job name + kind/model/status/cadence-type badges |
| Schedule ID | The **full** id (monospace, wrapping, selectable) — never a truncated snippet |
| Cadence | `cadenceText` (e.g. `Every 60 min`) + next run |
| Scope | One-line target summary + owner · environment |
| Actions | `Details`, `Edit`, `Trigger Now`, `Pause`/`Resume`, `Cancel` |

The table scrolls horizontally on narrow viewports instead of clipping the id
or the actions.

## One edit action

`Edit` is the only edit control on a screening row, and it opens the full form
(`ScheduleFormModal`) — which already owns cadence. The separate
`PUT /api/schedules/:id` cadence editor was removed from the screening surface;
the generic (non-screening) rows open the one cadence dialog
(`CadenceModal`) because their callbacks have no structured edit form. There is
no inline expansion anywhere: edit-type actions open dialogs.

## One details dialog, one vocabulary

`Details` opens `ScheduleDetailModal`, fed by `buildScheduleDetail`
(`src/client/scheduledOptionsManager/scheduleDetail.ts`). That pure model is
also the row's scope summary, so the row and the dialog cannot disagree. Every
kind uses the same labels in the same order:

```text
Schedule:     Schedule ID · Job · Callback · Cadence type · Cadence · Status · Next run · Created
Ownership:    Owner · Environment · Trigger
Scope:        Input model · Universe · Symbols · Watchlist · Max items · Sector ·
              Filters · Thesis · Risk profile · Profile
Delivery:     Slack · Email · Webhook
Saved views / Constraint sets (discovery only, one row per symbol)
Run definition (server record only): Cron (UTC) · Interval · Delay · Runs at
Raw payload (the stored payload, verbatim)
```

A kind's Scope fields are a **subsequence** of `SCHEDULE_SCOPE_LABEL_ORDER`: a
field is omitted when the schedule has no value for it, never renamed and never
reordered. Callbacks outside the three screening kinds are `System` jobs — they
are described by their callback name, never dressed as a screening kind.

## One create action, one refresh

- The page has exactly **one** create action: the screening hero's
  `+ New Schedule`. The duplicate `＋ New schedule` button in the tab row was
  removed with the `openCreateSignal` host signal it drove.
- The page has exactly **one** refresh control: the tab row's `↻ Refresh`. It
  refetches the panel's list, the screening list, the latest runs, and the
  audit trail (one `refreshSignal` bump).

## Confirmation

Destructive actions confirm in `ConfirmModal` (one dialog, `Modal` primitive)
that names the job and the id and states that the action cannot be undone. No
native `confirm()`/`alert()` (see #2283).

## What this does not change

No API, route, service, store, payload, or notification behaviour changes. The
create/edit payload builders, trigger routes, pause/resume, and cancel route
bodies are untouched and remain pinned by their existing tests.
