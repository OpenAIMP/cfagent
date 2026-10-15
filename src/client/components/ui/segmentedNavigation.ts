export interface SelectableOption {
  id: string;
  disabled?: boolean;
}

export function getSegmentTabStop(options: readonly SelectableOption[], value: string): number {
  const selected = options.findIndex(option => option.id === value && !option.disabled);
  return selected >= 0 ? selected : options.findIndex(option => !option.disabled);
}

export function getSegmentNavigationTarget(
  options: readonly SelectableOption[],
  currentIndex: number,
  key: string,
): number | null {
  const enabled = options.flatMap((option, index) => option.disabled ? [] : [index]);
  if (!enabled.length) return null;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  const direction = key === 'ArrowRight' || key === 'ArrowDown' ? 1
    : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
  if (!direction) return null;
  const position = enabled.indexOf(currentIndex);
  if (position < 0) return direction > 0 ? enabled[0] : enabled[enabled.length - 1];
  return enabled[(position + direction + enabled.length) % enabled.length];
}
