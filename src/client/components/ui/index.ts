/**
 * Shared UI primitives (#492) — the composable component layer.
 *
 * Inventory (each primitive: semantic tokens only via primitives.css,
 * themed by construction, pinned by tests/composable_ui_primitives.test.ts):
 * - SegmentedControl — single-selection radio group (sizes sm/md/lg, badges,
 *   roving-tabindex keyboard navigation).
 * - PillGroup — selection pill group (sizes sm/md; tone variants
 *   default/cyan/emerald/amber/purple).
 * - Badge — status/label pill (tones neutral/accent/success/warning/
 *   danger/info/purple/trade; sizes sm/md; optional status dot).
 * - Button — action button (variants primary/secondary/ghost/danger/
 *   trade; sizes sm/md/lg; loading state with aria-busy).
 *
 * Styles live in ./primitives.css (imported once by main.tsx). New
 * primitives are added here with their styles + tests in the same PR.
 */
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from "./SegmentedControl";
export { PillGroup, type PillOption, type PillGroupProps } from "./PillGroup";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Button, type ButtonProps, type ButtonVariant } from "./Button";
