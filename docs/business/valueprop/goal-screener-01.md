# NextGenTP Unified Goal Screener — Value Proposition (01)

> **Product:** NextGenTP's Unified Goal Screener — a goal thesis run on the
> unified workflow, end to end.
> **Status:** Living business document. First issued 2026-10-28.
> **Scope:** Program #1972 (goal screen on the unified workflow).
> **Charter rule for this document:** never claim the product is finished.
> What is proven vs. pending is stated in §7; commercial proof is tracked
> separately from implementation claims.

## 1. Value proposition

**State a goal. Get tradeable candidates.**

A user states a goal thesis in plain investment terms — income,
directional, volatility event, hedge/protect, repair, deconcentrate, IV
harvest, capital-efficient leverage, cash-secured entry — plus an outlook
(bullish, bearish, volatile, range-bound, unknown) and optionally some
names. The system returns **selective, stored, auditable, backtestable
results**: stocks that fit the thesis, and options structures that
implement it.

Three layers make up the proposition:

1. **Selection, not search.** The user never translates a goal into
   filter parameters and never reads a raw screener table to find the
   idea. The thesis *is* the query.
2. **Completeness, not tickers.** Options results are complete trade
   ideas — iron condors, butterflies, cash-secured puts and their kin —
   shown in a Candidate structures column, not a list of contracts to
   assemble by hand.
3. **Trust, not ephemera.** Every run is stored as a canonical report
   with PDF/XLSX/CSV artifacts, and stock hits can be backtested in the
   panel — so a user can check whether a thesis would have worked
   before putting money on it.

### Who gains, and how

The product serves day-traders to wealth managers, across the scenario
set the platform is built for. The goal screener covers the goal-driven
subset:

- **Pick the best trade.** An income investor states an income goal and
  gets premium-generating structures on names they hold or name.
- **Names fitting a thesis.** A directional trader states a bullish view
  and gets breakout candidates selected on enriched data, not on a
  quote snapshot alone.
- **Strategies fitting a name.** A user names symbols and a goal, and
  gets the structures that implement that goal on those names.
- **No-thesis discovery.** Unknown is a real mode, not a broken
  direction: it means everything, and returns the universe with
  standouts flagged.
- **Portfolio repair and hedging.** A user with a concentrated or
  damaged position states a repair, deconcentrate, or hedge/protect goal
  and gets candidates that fix the problem, rather than more names
  going up.

The boundary, stated plainly: this is a **research product**. It
recommends and creates autonomously; a human approves before any trade
execution. No path executes without human approval.

## 2. Business strategy

**Why goal first.** Stock, options, and strategy screens already have
partial staged paths. Goal is the missing leg — and the only family
commercially unusable for its core job (thesis selection) before this
program. The first product is therefore the goal screener; the platform
play is all four families on the same staged pipeline.

**Positioning.** Thesis-driven, not filter-driven. Structures, not
tickers. Stored, auditable, and backtestable, not ephemeral tables. One
unified pipeline (schedule → queues → feed → gather → store → serve →
deliver), not four separate tools.

**Growth path, in program order:** submission → staged execution →
gather wiring → UI read-back → direct-path retirement. Then the
remaining families onto the same pipeline. Then the closed
outcome→calibration loop (#1904 P4) — which turns delivered results
back into calibrated theses.

**Deliberately NOT in the first product:** a new workflow, a new
provider, the PROD E*TRADE reconnect (an owner step), an options Yahoo
fallback, the P4 closed loop, and any pricing or tier change. Each is a
later decision, not a v1 gap to fill quietly.

**Commercial proof is a separate track from implementation claims.**
This document states what the system does and what is proven about it
(§7). Whether users pay for it, retain, and expand is tracked
separately by the product owner.

## 3. Competencies

The enduring strengths the proposition rests on — what the organization
must be good at, not what one release contains:

- **Think-agent goal orientation.** A goal thesis drives execution
  through an agent with its own workflow (ScreenerAgent), rather than
  through a form that queries a database. Memory and vector retrieval
  are the maturing direction here; no retrieval graph is populated in
  production yet (§7).
- **Multi-provider market data with provenance.** E*TRADE live as the
  primary source, Yahoo complementing columns on live rows, Nasdaq
  listings as the universe feed. Any fallback or derived data is
  labeled as such wherever it surfaces — never presented as live.
- **Unified staged pipeline engineering.** Schedule → queues → feed →
  gather → store → serve → deliver, with gates that fail closed rather
  than fabricate values when data is missing.
- **Screening science.** Thesis taxonomies (nine goal kinds, five
  outlooks), technicals over captured bars, and structure construction
  for the options leg.
- **Delivery and observability.** Multi-channel delivery with durable
  or explicitly lossy semantics, stage visibility for every run, and
  audits that make failures diagnosable without worker-log access.
- **Flag-driven rollout.** Flagship feature flags let a new execution
  path ship default-off, prove itself, and flip to default-on in code —
  the path `goal_workflow` itself took (#1997 → #2051).

## 4. Capabilities

The system capabilities that deliver the proposition, each mapped to
the layer it enables:

| Capability | Enables | Status |
| --- | --- | --- |
| Manual + scheduled goal submission through the unified run-request path (#1996) | Selection: any thesis enters the same pipeline | Shipped |
| Staged execution: one goal shard, store/deliver doors, report id surfaced (#1996, #1997) | Trust: a run is a durable, addressable result | Shipped |
| `goal_workflow` flag + fail-loud semantics: a failed start answers a coded 500 / throws, never silently falls back (#1997, #2065) | Trust: failures are visible at their stage | Shipped; #2065 remainder in flight |
| Feed: multi-provider collection (listings, quotes, chains, bars) | Selection: the screen sees real markets | Shipped |
| Gather: persisted enrichment — one `mas_data_captures` row per live symbol, digest-verified read-back, live rows with Yahoo complementing columns (#1998, #2056) | Selection: thesis selection runs on enriched, attributable data | Shipped; #2056 in flight |
| Store: canonical `mas_reports` row + `mas_data_captures` under the same run id, R2 blobs for PDF/XLSX/CSV | Trust: every run is auditable | Shipped |
| Serve: reports API + panel read-back via job history and report fetch by id (#1997) | Trust: the user can always get back to a run | Shipped |
| Deliver: email with PDF, Slack text post with PDF, report in UI, sent immediately with no approval hold (delivery contract, #1347/#1336) | Completeness: the result reaches the user where they are | Shipped for scheduled/on-demand runs; see §6 note |
| Validate: backtest on stock hits, candidate structures column, partial/failure visibility per leg class (#1963) | Trust: check before committing capital | Shipped |
| Observe: D1 stage rows, `goal.gather.stored` events, audits, coded start failures (#1743, #2065) | Trust: any run's state is explainable | Partial: aspect-adjacent, not aspect-driven (#1969) |

## 5. Value chain

Each stage adds value and persists its own results — feed rows, gather
rows, analysis results, and the report are separate records, never
updates in place:

1. **Submit.** Intent is captured as a goal thesis (manual or
   scheduled). Value: the user's goal becomes a machine-executable
   request. Artifact: the run request + idempotency key.
2. **Schedule.** Timed or on-demand triggering with minute-slot
   dedup. Value: the thesis runs when it should, once. Artifact: the
   schedule record + tick history.
3. **Queues.** Durability and fan-out for the run and its deliveries.
   Value: a run survives process boundaries. Artifact: queue envelopes
   + the D1 stage projection.
4. **Feed.** Collection from multiple providers. Value: the screen sees
   live markets, with provenance per row. Artifact: `mas_data_captures`
   feed rows (raw + normalized, run-linked, immutable).
5. **Gather.** Combination and enrichment of feed data. Value: the
   thesis is evaluated on complete, attributable data — not on a quote
   snapshot that lacks the fields the filters need. Artifact: gather
   rows (live rows, Yahoo-complemented columns) + route version.
6. **Store.** The canonical run record and its data under one run id.
   Value: the result is permanent and addressable. Artifact:
   `mas_reports` row + R2 blobs.
7. **Serve.** Read-back through the panel and the reports API. Value:
   the user (or a later run, or a backtest) can retrieve the result.
   Artifact: the served report body.
8. **Deliver.** Email, Slack, UI, webhook, voice. Value: the result
   arrives where the user acts. Artifact: delivery job rows; terminal
   delivery failure is a failed job with a code, never a silent drop.
9. **Act.** The user trades, holds, or discards — with human approval
   before any execution. Value: the only step that converts research
   into return.
10. **Learn (future, #1904 P4).** Outcomes feed calibration, so theses
    improve. Not in v1; the chain is explicit about where it ends
    today.

Loss modes are explicit at each handoff: a store failure throws rather
than claiming success for an unstored run; a delivery failure is a
failed job with a code; a leg failure is visible at its stage with its
class and reasons.

## 6. Channels

How the value reaches users:

- **In-app UI (primary).** The Screening hub (Autonomous Screen panel,
  Reports), the Goal Screen panel (submit, track via job history, view
  results, backtest, download PDF/XLSX/CSV), and the reports API. Every
  run surfaces here with full artifacts.
- **Email.** The run report with PDF, sent immediately on scheduled and
  on-demand runs.
- **Slack.** A text post with PDF, sent immediately on scheduled and
  on-demand runs.
- **Webhook and voice.** Routed delivery channels accepted by the goal
  screen contract, for users whose workflow consumes results outside
  the app and inbox.
- **API and downloads.** Report endpoints and per-run PDF/XLSX/CSV
  downloads for users who pull results into their own tooling.

Channel note (honest): manual goal runs surface in the UI with full
artifacts today; email and Slack delivery ride scheduled and on-demand
runs. Reconciling the delivery contract's manual-run wording against
the goal screen's observed manual-run behavior is an open item, not a
claim this document settles.

Not channels, stated so they are not assumed: the goal screen contract
routes no mobile-app or push channel — the channels above are the
complete set it routes — and there is no true push realtime feed:
today's "live" is fetch-at-run-time plus polling.

## 7. Proof status: proven vs. pending (2026-10-28)

**Proven in code (merged, battery-verified):** goal submission through
the unified path; the flag and fail-loud semantics; persisted gather
for the goal stock leg; panel read-back by report id; backtest on stock
hits; the structures column; partial/failure visibility per leg class.

**Pending proof (needs a live session):**

- **Two-thesis live proof.** Income+Bullish and Directional+Bullish
  flagged staged runs returning selective results, with structures on
  options rows and backtest on stock hits. This is the proof that
  thesis selection on enriched data works in production — the case that
  returned zero hits before #1998.
- **#2065 prod start success.** A panel goal workflow start succeeding
  in prod after the remainder merges and deploys.
- **#2051 default-ON deploy.** `goal_workflow` on by default in code,
  not only by the dashboard value already enabled in prod Flagship.
- **Commercial proof.** Tracked separately; this document makes no
  commercial claim.

**Honest limits, never claimed otherwise:** no retrieval graph
populated in production; no true push realtime feed; the options leg
has no gather enrichment; AOP is aspect-adjacent, not aspect-driven
(#1969); the PROD E*TRADE session is owner-gated, so scheduled stock
runs complete via the labeled Yahoo fallback while the session is dead.

## 8. Sources

- `docs/architecture/business/screener-workflow.md` §0 (product
  framing, v2) and §7 (phases #1997–#2000).
- Program #1972 (standalone); #1996 (submission), #1997 (staged
  execution + flag), #1998 (persisted gather), #1999/#2000 (audited
  ship, durability — next).
- #1963 (goal screen RCA: partial/failure visibility, structures,
  backtest); #2051 (default-ON); #2056 (live-rows gather rule); #2065
  (start diagnostics + bounded derivation).
- Delivery contract (#1347, #1336); #1904 P4 (future closed loop);
  #1743 (observability stream); #1969 (AOP program).
