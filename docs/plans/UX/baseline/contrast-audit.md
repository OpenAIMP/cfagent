# Contrast audit — semantic token maps (Phase 0 baseline, #468)

Method: `node scripts/token-contrast.mjs` parses the `[data-theme="dark"]` and
`[data-theme="light"]` maps in `src/client/tokens.css` and computes WCAG 2.1
contrast ratios for the semantic foreground/surface pairs DESIGN.md S2.1
requires to travel together (50 pairs incl. badge foregrounds). AA text
threshold: 4.5:1.

## Result after fixes: 50 pairs, 0 below AA, 1 manual review

Manual review: dark `--color-muted-foreground` on `--color-muted`
(rgba(255,255,255,0.05) over surface) cannot be composited generically;
composited over `--color-surface` (#060913 -> ~#12151f) the pair estimates
~7.4:1 — pass.

## Defects found in the 2026-10-20 audit and fixed in tokens.css (this PR)

Dark map:
| Token | Was | Now | Pair ratio before -> after |
|---|---|---|---|
| `--color-text-dim` | #64748b | #7c8fb0 | 4.18 on surface / 3.75 on card -> 6.07 / 5.45 |
| `--color-primary-foreground` | #ffffff | #04241c | 2.54 on `--color-primary` -> 6.50 |
| `--color-success-foreground` | #ffffff | #04241c | 2.54 on `--color-success` -> 6.50 |
| `--color-danger-foreground` | #ffffff | #2e0a10 | 3.67 on `--color-danger` -> 4.90 |

Light map:
| Token | Was | Now | Pair ratio before -> after |
|---|---|---|---|
| `--color-primary` | #059669 | #047857 | white fg 3.77 -> 5.48 |
| `--color-accent` | #0284c7 | #0369a1 | 3.91 on surface -> 5.67 (white on accent 4.10 -> 5.93) |
| `--color-success` | #16a34a | #15803d | 3.15 on surface -> 4.79 (white fg -> 5.02) |
| `--color-warning` | #d97706 | #b45309 | 3.04 on surface -> 4.80 (white fg 3.19 -> 5.02) |
| `--color-info` | #0284c7 | #0369a1 | 3.91 on surface -> 5.67 (white fg 4.10 -> 5.93) |

Derived `-subtle` rgba tints for accent/success/warning/info in the light map
were updated to the new base colors. No other token values changed; every
other pair was already AA (full pair table reproducible via the script).
