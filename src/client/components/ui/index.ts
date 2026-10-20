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
 * - Spinner — loading indicator (sizes sm/md/lg; role="status" label).
 * - EmptyState — icon/title/description/action empty block (optional
 *   framed panel variant).
 * - Card — surface container (flat/elevated; padding scale).
 * - Notice — inline banner/alert (tones; box/strip; dismissible;
 *   role=alert for danger/warning).
 * - Tabs + TabPanel — WAI-ARIA tablist/tabpanel pair (roving tabindex,
 *   arrow/Home/End keys, automatic activation).
 *
 * Styles live in ./primitives.css (imported once by main.tsx). New
 * primitives are added here with their styles + tests in the same PR.
 */
export { SegmentedControl, type SegmentedControlOption, type SegmentedControlProps } from "./SegmentedControl";
export { PillGroup, type PillOption, type PillGroupProps } from "./PillGroup";
export { Badge, type BadgeProps, type BadgeTone } from "./Badge";
export { Button, type ButtonProps, type ButtonVariant } from "./Button";
export { Spinner, type SpinnerProps } from "./Spinner";
export { EmptyState, type EmptyStateProps } from "./EmptyState";
export { Card, type CardProps } from "./Card";
export { Notice, type NoticeProps, type NoticeTone } from "./Notice";
export { Tabs, TabPanel, type TabsProps, type TabOption, type TabPanelProps } from "./Tabs";
