# FEAT-104: Strategy map & economics

## Ownership
Product owner: Ceos
Engineering owner: Muse (PM-amuse-dhmp)

## Outcome
User problem: strategy selection must follow the outlook deterministically,
and payoff economics must be computed correctly — including two-expiration
structures like PMCC where a spread-width shortcut is wrong.
Expected benefit: every candidate structure has exact legs, quote context, and
independently-checked economics.

## Scope
Included: outlook→structure map (verified):
- Bullish: bull call spread, bull put spread; cash-secured put and PMCC only
  when explicitly allowed/enabled.
- Bearish: bear put spread, bear call spread.
- Range-bound: iron condor, butterfly.
- Volatility expansion / unclear direction: long straddle, long strangle.
Economics (`src/services/researchEconomics.ts`): net debit/credit, breakeven,
max gain/loss, fees/slippage assumptions, 5+ scenario points; PMCC modeled
correctly — the long call's remaining value at the short leg's expiration is
accounted for (verified: `pmccEconomics`).
Falsification (`researchFalsification.ts`): thesis challenge + risk pre-mortem.
Excluded: gate logic (FEAT-103), report rendering (FEAT-105).

## Requirements
Functional:
- REQ-RES-030: only structures in the map for the candidate's outlook are
  evaluated; the map narrows, gates decide.
- REQ-RES-031: ownership-dependent structures (CSP, PMCC) require explicit
  opt-in configuration; default off.
- REQ-RES-032: payoff calculations pass an independent check (gate 5).
- REQ-RES-033: economics state commissions, slippage, and expiration-treatment
  assumptions.

## Acceptance
See `acceptance.md`. Deterministic tests: per-structure payoff fixtures;
PMCC two-expiration valuation fixture.
