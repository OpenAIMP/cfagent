# Shared UI foundations

## Scope

Button, Surface, StatusBadge, and AsyncState are incremental primitives exported by src/client/components/ui. Their stylesheet is imported by Foundations.tsx and uses scoped ds- classes. Existing controls are unchanged until migrated.

## Contracts

- Button defaults to type=button. Use primary for the main action, secondary for supporting actions, and danger for destructive actions. Loading disables activation and exposes aria-busy; provide a meaningful visible label, including when busy. Icon-only usage requires an accessible name.
- Primary is currently outlined: existing filled brand color pairs have not been verified for small text contrast. This is not a claim of complete WCAG compliance.
- Surface supports card, raised, and sunken backgrounds with paired foregrounds. It remains a div; use real headings and landmarks at the composition layer.
- StatusBadge must contain text. Its color is supplementary, and it is not a live region by default. Do not conflate call/put or long/short with success/error.
- AsyncState renders loading/empty as status and errors as alert. Use distinct state messages and optional recovery actions. Do not recreate live regions on every background polling response or steal focus on automatic updates.
- Density uses control-height and input-padding, while text uses app-font-scale. Controls can grow with text and labels can wrap. Small buttons retain the density-dependent minimum height.
- Focus styling, reduced-motion behavior, and a forced-colors focus rule are included. Runtime contrast, keyboard, zoom, and screen-reader behavior still require validation.

## Validation

The added Vitest suite uses server rendering to check markup contracts and a stylesheet guard for raw colors/important overrides. It does not simulate clicks, focus, keyboard navigation, or browser layout. No tests or browser validation have been run by the authoring assistant at this checkpoint. Inspect CI before merge.

## Pending migration

1. Migrate embedded and standalone AsyncJobsPanel without changing API endpoints.
2. Separate initial load, refresh errors, result loading/errors, and empty results.
3. Protect against stale result responses and unmount updates.
4. Extend browser interaction, accessibility, and visual regression coverage.
5. Extract legacy feature repairs from tokens.css while preserving cascade order; remove universal font overrides only with consumer migration and validation.
6. Add canonical generated tokens, contrast tests, domain-specific roles, and remaining controls.
