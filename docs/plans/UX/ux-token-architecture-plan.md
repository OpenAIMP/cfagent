# OpenAIMP/cfagent — UX, Open Issues & UX Token Architecture Plan

_Synced 2026-10-20 via `git clone` + `git pull --rebase` (main @ 6159842+). Repo: https://github.com/OpenAIMP/cfagent_

## Status — COMPLETE (2026-10-20)

All phases implemented and merged; issues #467–#476 and gate #491 closed.

- **Coverage: 3,105 → 0** raw color literals in `src/client` outside the token sources
  (`scripts/token-coverage.mjs` TOTAL). The Phase 2 ratchet allowlist is retired;
  `tests/ux_token_coverage_ratchet.test.ts` is now a hard zero gate.
- **One vocabulary**: `--color-*` semantic tokens only. The `--bg-*`/`--text-*`/
  `--border-*`/`--accent-*` shims and the `--opt-*` layer are deleted codebase-wide.
- **Three themes, one mechanism**: root `data-theme` only (legacy class/body adapters
  deleted in Phase 4). `high-contrast` shipped in Phase 5 as a pure token map —
  126 tokens, zero component changes. `generatedThemeTokens` covers 3 themes ×
  93 `--color-*` tokens; contrast audit: 75 pairs, 0 below WCAG AA.
- **PR trail**: #503, #505–#508, #516 (foundations), #509–#538 (Phase 3a),
  #544/#546/#549/#550 (3b), #554/#556 (3c), #558 (Phase 4), #559 (Phase 5),
  #562/#564 (Phase 6).
- Continuing separately: #492 (composable primitives program) and #400 (Chat.tsx split).


## What the product / UX is

**NextGenTP** (`ai-search-agent`, live at agent.openaimp.com): a Cloudflare Workers multi-agent
assistant + trading-research platform. React 19 + Vite SPA in front of an Orchestrator Durable
Object (Workers AI, RAG, NLQ analytics) with E*TRADE / options / screener tooling.
~141k LOC in `src` (TypeScript), 265 TS/TSX files, 15 CSS files.

### UX surfaces (all inside one SPA shell, `src/client/Chat.tsx`, 4,538 lines)

| Surface | Main files | Notes |
|---|---|---|
| Agent chat + NLQ | `Chat.tsx`, `components/UniversalChart.tsx`, `components/StockSearchBar.tsx` | Shell for everything; split proposed in #400 |
| Stock screener | `ScreenersHub.tsx`, `ScannerPanel.tsx` (1,730), `ScreenerResultsView.tsx` | Universes, scheduled runs, Slack/PDF reports |
| Options research | `options/OptionsResearchPanel.tsx`, `options/StrategyDiscoveryPanel.tsx` (3,598 + 5,107-line CSS), `options/ScheduledOptionsManager.tsx`, `options/flows/OptionsFlowsHub.tsx` | Strategy Library dialog (74 strategies), scheduled options analysis |
| E*TRADE trading | `ETradeTradingHub.tsx` (3,559), `ETradeDynamicMenu.tsx` | Accounts, orders, watchlists |
| Workflows / research hubs | `WorkflowsHub.tsx`, `MarketDataResearchHub.tsx` | FAQ/catalog driven |
| Risk / autopilot | `PortfolioRiskPanel.tsx`, `components/AutopilotControlCenter.tsx` | Repair/hedge proposals, policy envelope |
| Platform | `McpApiExplorer.tsx`, agentic wallet panel, `components/NavigationMenu.tsx` | MCP explorer, x402 wallet |

### Appearance system (three preference axes, all pre-paint, no FOUC)

- **Theme**: `light | dark | system | high-contrast` — `src/client/theme.ts`, localStorage `nextgentp_theme`,
  `prefers-color-scheme` resolution + live listener + cross-tab storage sync.
- **Density**: `compact | comfortable` — in `src/client/designTokens.ts`, key `nextgentp_density`.
- **Typography**: font scale + style — `src/client/typography.ts`.
- `index.html` has a blocking `appearance-bootstrap` inline script that stamps `data-theme`
  before first paint; `main.tsx` re-applies preferences without writing storage.
- `DESIGN.md` already specifies the intended architecture: 3 layers (primitives → semantic →
  component utilities), "components describe intent; themes supply appearance", surface/foreground
  pairing rule, WCAG 2.1 AA, density awareness. **The design intent is documented; the codebase
  just hasn't converged on it.**

## Standing directives (Venus, 2026-10-20)

1. **Dark / light / system, everywhere.** The system follows all three theme modes, implemented consistently across ALL UX elements and components — no dark-only or light-only corners. Enforced mechanically by the Phase 2 ratchet (#470) reaching zero (Phase 6, #476) and proven surface-by-surface by the verification gate **#491**.
2. **Fully composable, component-oriented UX.** Surfaces are assembled from shared components and primitives (`src/client/components/ui/` — seeded with `PillGroup` + `SegmentedControl`, pinned by `tests/composable_ui_primitives.test.ts`), not hand-built per page. Tracked in **#492**, with the Chat.tsx split (#400) and the Strategy Library extraction (#450) as its decomposition slices. New repeated elements become primitives (token-only styling, tests included), not page-local copies.

## Token architecture — measured current state (2026-10-20 audit)

Foundation exists, applied inconsistently — exactly as issue **#137** says, and slightly worse
than its 2026-10-17 survey because the client kept growing:

- `src/client/tokens.css` — 1,568 lines, **four accreted `:root` blocks**: primitives (~L13),
  `[data-theme="dark"]` map (L198), `[data-theme="light"]` map (L319), density/typography (L440).
- `src/client/designTokens.ts` — **not** a value mirror: a hand-maintained list of 33 color roles
  + `tokenVar()` + the density APIs. Drift risk = role names vs CSS var names.
- `src/client/styles.css` (14,683 lines) defines a **second vocabulary**: `--bg-*`, `--text-*`,
  `--border-*`, `--accent-*` aliases over `--color-*` (~250 usages). `optionsResearch.css` does
  the sanctioned version of this with `--opt-*` aliases (~140 usages).
- **1,216 hard-coded hex occurrences in client CSS (127 distinct values)**; 962 of them in
  `styles.css` alone. Then `scannerPanel.css` 39, `reports.css` 34, `portfolioRiskPanel.css` 21,
  `strategyDiscovery.css` 18, `agenticWalletPanel.css` 17. `tokens.css` itself holds 103 (legit —
  it's the source).
- **32 TSX files use inline `style={{}}`**; 134 TS/TSX files contain hex literals (incl.
  charts/canvas/SVG/PDF generators where CSS vars can't reach — those need the TS mirror).
- `theme.ts` still toggles **three legacy adapters** on every change — root `.dark`/`.light`
  classes, body `.theme-light`/`.theme-dark` classes, body `data-theme` — per its own comment
  "temporary legacy adapters". CSS consumption of them is already ~zero (one stray selector
  each; `[data-theme]` selectors exist **only** in `tokens.css`), so removal is close to free.
- Existing tests in the repo's source-pin style: `theme_preferences.test.ts`,
  `appearance_bootstrap.test.ts`, `density_tokens.test.ts`, `modal_token_architecture.test.ts`
  (modals must consume semantic tokens, no per-theme override hacks). **But there is no global
  pin against raw colors** — nothing stops new hard-coded hex from landing today.

## Open issues — 85 open (80 issues + 5 PRs), all by OpenAIMP except dependabot

**PRs:** #465 screener fix for #421 (honest sector label, `fix/421-honest-sector-label` → main);
#12/#31/#49/#50 dependabot bumps.

**UX / theming (the token cluster):**
- **#137** [UX] One token architecture for theming — the epic this plan implements.
- **#422** [ux] Sector info uses hardcoded dark colors instead of design tokens (mini-#137).
- **#450** [ux] Unify strategy catalog: one source of truth, dialog cards + scanner picker.
- #400 split `Chat.tsx`; #273 schedules management UI; #275 scanner nav/direction tags;
  #125/#126 results surfaces for scheduled runs; #339/#340/#341 reports-tab research views.

**Screener / research correctness:** #421 (fix in flight), #424 failed runs don't notify Slack,
#435 market-setup catalog, #385 reportUrl in webhooks, #292 default universe, #333–#338
PDF/R2/delivery pipeline.

**Infra / cost (Cloudflare free tier):** #415 migrate off KV → DO-SQLite + R2, #411 limit KV/API
traffic, #329 KV at 50% of daily free limit, #402 Error 1101 worker exception.

**Big refactors:** #359 split `orchestrator.ts` (303KB) + #379/#380 route extractions,
#399 extract `nlq.ts` (131KB), #400 `Chat.tsx` (183KB).

**Assessment hardening (epics #237, #143):** #115 fabricated-success audit, #313/#314 advertised
routes that 404, #175/#180/#183 identity/security, #168/#243/#244 silent empty-200 failures,
#255 retention, #256/#321 release discipline, #257 observability, #258 judge eval harness.

**Discovery / autonomy:** epic #13 + phases #14/#16/#17/#18, #204 LLM strategy ranking,
#223 scheduled options in UI, #79 autopilot policy envelope, #78 goal→plan→execute pipeline,
#219/#231 self-heal fixer, #232 RSI epic, #355 portfolio repair, #457 durable-schedules research,
#430 lane coordination (standing thread), foundations #1–#8.

## Plan — implement the UX token architecture consistently (executes #137)

Principles from #137 + DESIGN.md: single source of truth; a theme is a token map, nothing more;
every surface consumes semantic tokens only; parity-or-better per slice; enforcement so it can't
drift back; independently shippable PRs, suite + typecheck + build green at each step.

### Phase 0 — Baseline & measurement (1 PR)
- Parity baseline: capture current appearance (screenshots or computed-style dumps) for the top
  surfaces — Chat, Screeners, Options Research, Strategy Discovery, Trading Hub, modals — in
  dark + light × both densities. This is the no-regression reference for every later slice.
- Coverage metric script: count raw hex/rgb(a) literals outside the token source files, per file
  (today: 1,216 CSS occurrences / 127 distinct values; 32 inline-style TSX files). Print it in
  each migration PR ("coverage before → after").
- Contrast audit of the semantic pairs in the dark/light maps vs WCAG AA; fix defects inside
  `tokens.css` only (one file, fixes everywhere at once); list fixes in the PR.

### Phase 1 — Single source of truth (1–2 PRs)
- Consolidate `tokens.css` into exactly: one primitives `:root`, one `[data-theme="dark"]` map,
  one `[data-theme="light"]` map, one density/typography block. Document the layers and
  "how to add a theme" in the file header (mirrors DESIGN.md §1).
- **Generate the TS mirror**: `scripts/gen-design-tokens.mjs` parses `tokens.css` and emits the
  values map in `designTokens.ts` (keep the existing role list + density API surface). Wire
  generation + diff into `npm run check`, so drift fails CI. Charts/canvas/SVG/PDF consumers
  import values from here — never literals.
- Declare the alias vocabularies (`--bg-*`/`--text-*`/`--accent-*`, `--opt-*`) deprecated shims:
  no new usages (the Phase 2 pin enforces this).

### Phase 2 — Enforcement pin, ratcheted (1 PR, before mass migration)
- New source-pin test in the repo's existing style (cf. `modal_token_architecture.test.ts`):
  fails on raw color literals in client CSS/TSX outside an allowlist, on theme-class selectors
  (`.dark`, `.theme-*`) in CSS, and on new inline-style color literals.
- Ship it with a **ratchet allowlist**: current per-file violation counts; the test fails if any
  count goes up, and the allowlist is edited down as slices land. Final slice deletes it.
- Extend `theme_preferences.test.ts`: stored/system resolution, live OS-preference change,
  cross-tab storage sync, and bootstrap/`theme.ts` agreement (bootstrap equivalence is partially
  covered by `appearance_bootstrap.test.ts` today).

### Phase 3 — Migrate surfaces, one PR per slice (parity screenshot + coverage delta in each)
Order = hex density × user visibility:
1. `styles.css` global chrome (962 hex) — in component-family chunks: tables, badges, buttons,
   inputs, nav. Missing role → add the semantic token to **both** theme maps.
2. **Sector info (#422)** — tiny and self-contained; land it first as the proof-of-pattern slice.
3. `scannerPanel.css` (39), `reports.css` (34), `portfolioRiskPanel.css` (21).
4. Options family: `strategyDiscovery.css` (18), `scheduledOptions.css` (11); collapse the
   `--opt-*` alias layer onto semantic vars. **Sequence note:** do #450's `StrategyLibraryModal`
   extraction first, then token-migrate the unified component once — don't polish the doomed
   checkbox blob.
5. `agenticWalletPanel.css` (17) + remaining small CSS files.
6. Inline styles: the 32 TSX files with `style={{}}` — colors → Layer-3 utility classes
   (`.bg-*`, `.text-*`, `.border-*`) or `tokenVar()` where the value is dynamic.
7. Non-CSS consumers: `UniversalChart`, canvas, generated SVG, server PDF generators
   (`screenerReportPdf.ts` etc.) → generated TS token map from Phase 1.

### Phase 4 — Delete the legacy adapters (1 PR)
- Remove root `.dark`/`.light` toggling, body `.theme-*` classes, and body `data-theme` from
  `theme.ts`. Verify zero consumers by grep across CSS + TSX first (CSS is already ~zero).
- `data-theme` + `data-theme-preference` on `<html>` become the only mechanism.
  Storage key `nextgentp_theme` and the pre-paint bootstrap stay untouched (no user migration,
  no FOUC regression).

### Phase 5 — Prove the architecture (1 PR)
- Add a third theme as **one token map only** (e.g. `high-contrast`) + one registry line in the
  resolver. If it renders cleanly across surfaces and passes the AA audit, keep it — it is both
  #137's acceptance proof and a real accessibility win.

### Phase 6 — Collapse the alias vocabularies (cleanup PRs)
- Rewrite `--bg-*`/`--text-*`/`--accent-*`/`--opt-*` usages to `--color-*` directly and delete the
  alias `:root` blocks. Ratchet hits zero → pin becomes absolute.

### Definition of done (= #137 acceptance)
- [x] Architecture documented in the token source (Phase 1)
- [x] 100% token coverage outside token files, pin green with no allowlist (Phases 2–3, 6)
- [x] Third theme = one new token map, demonstrated (Phase 5)
- [x] `designTokens.ts` drift impossible — generated + checked (Phase 1)
- [x] Legacy adapters deleted; `data-theme` is the only mechanism (Phase 4)
- [x] Parity evidence + improvement list on every slice PR (Phase 3)

_Rule for all future work in this repo (per Venus): `git pull --rebase` / merge first, always._

## Implementation issues (created 2026-10-20, all sub-issues of #137)

| Step | Issue |
|---|---|
| Publish this plan under docs/plans/UX/ | #467 |
| Phase 0 — baseline: parity, coverage, contrast audit | #468 |
| Phase 1 — single source of truth: consolidate tokens.css, generate designTokens.ts | #469 |
| Phase 2 — enforcement: ratchet pin + theme-switch tests | #470 |
| Phase 3a — migrate styles.css global chrome | #471 |
| Phase 3b — migrate feature CSS families | #472 |
| Phase 3c — inline styles + charts/canvas/SVG/PDF consumers | #473 |
| Phase 4 — remove legacy theme adapters | #474 |
| Phase 5 — third theme (high-contrast) as one token map | #475 |
| Phase 6 — collapse alias vocabularies; ratchet to zero | #476 |
| Related existing slice: sector info hard-coded colors | #422 |
| Related sequencing: unify strategy catalog (before 3b options slice) | #450 |
| **Gate (directive): theme-consistency verification — EVERY element follows dark/light/system** | **#491** |
| **Direction (directive): composable, component-oriented UX** | **#492** |

## Phase 3a chunking notes (from literal analysis, 2026-10-20)

styles.css: 1,984 literals — 99 distinct hex, 239 distinct functional values.
Top hexes are palette copies with clear roles: #38bdf8 (108, accent), #94a3b8
(103, text-muted), #cbd5e1 (51, text-secondary), #f8fafc (41), #f59e0b (19,
warning), #f87171 (34, sentiment-bearish), #ef4444 (15, sentiment-very-bearish).
Several are STALE pre-Phase-0 token values (#059669 x16 = old light primary;
#64748b x30 = old dark text-dim) — drift made visible. #ffffff (137) and
black-alpha shadows (rgba(0,0,0,*) ~100+) are the ambiguous tail: role depends
on the rule. --shadow-sm/md/lg/card tokens already exist in tokens.css.
=> Migrate per component family with per-rule role checks (never a global
find/replace): nav/chrome -> tables -> badges -> buttons -> inputs -> cards.
Each chunk: replace, run coverage + ratchet, eyeball both themes.
