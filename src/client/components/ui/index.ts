/**
 * Shared UI primitives (#492) — the composable component layer.
 *
 * Inventory (each primitive: semantic tokens only via primitives.css,
 * themed by construction, pinned by tests/composable_ui_primitives.test.ts):
 * - SegmentedControl — single-selection radio group (sizes sm/md/lg, badges,
 *   roving-tabindex keyboard navigation).
 * - PillGroup — selection pill group (sizes sm/md; tone variants
 *   default/cyan/emerald/amber/purple).
 *
 * Styles live in ./primitives.css (imported once by main.tsx). New
 * primitives are added here with their styles + tests in the same PR.
 */
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from "./SegmentedControl";
export { PillGroup, type PillOption, type PillGroupProps } from "./PillGroup";
