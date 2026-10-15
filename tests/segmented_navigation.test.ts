import { describe, expect, it } from 'vitest';
import { getSegmentNavigationTarget, getSegmentTabStop } from '../src/client/components/ui/segmentedNavigation';

const options = [{ id: 'a' }, { id: 'b', disabled: true }, { id: 'c' }];

describe('segmented control navigation', () => {
  it('uses the selected enabled option as the tab stop', () => {
    expect(getSegmentTabStop(options, 'c')).toBe(2);
  });
  it('falls back when selection is missing or disabled', () => {
    expect(getSegmentTabStop(options, 'missing')).toBe(0);
    expect(getSegmentTabStop(options, 'b')).toBe(0);
  });
  it('skips disabled options and wraps in both directions', () => {
    expect(getSegmentNavigationTarget(options, 0, 'ArrowRight')).toBe(2);
    expect(getSegmentNavigationTarget(options, 2, 'ArrowRight')).toBe(0);
    expect(getSegmentNavigationTarget(options, 0, 'ArrowLeft')).toBe(2);
    expect(getSegmentNavigationTarget(options, 2, 'ArrowLeft')).toBe(0);
  });
  it('supports vertical arrow keys and boundary keys', () => {
    expect(getSegmentNavigationTarget(options, 0, 'ArrowDown')).toBe(2);
    expect(getSegmentNavigationTarget(options, 2, 'ArrowUp')).toBe(0);
    expect(getSegmentNavigationTarget(options, 2, 'Home')).toBe(0);
    expect(getSegmentNavigationTarget(options, 0, 'End')).toBe(2);
  });
  it('handles empty and fully disabled groups', () => {
    expect(getSegmentTabStop([], 'a')).toBe(-1);
    expect(getSegmentTabStop([{ id: 'a', disabled: true }], 'a')).toBe(-1);
    expect(getSegmentNavigationTarget([], 0, 'Home')).toBeNull();
    expect(getSegmentNavigationTarget([{ id: 'a', disabled: true }], 0, 'ArrowRight')).toBeNull();
  });
  it('ignores unrelated keys and handles a disabled current option', () => {
    expect(getSegmentNavigationTarget(options, 0, 'Tab')).toBeNull();
    expect(getSegmentNavigationTarget(options, 1, 'ArrowRight')).toBe(0);
    expect(getSegmentNavigationTarget(options, 1, 'ArrowLeft')).toBe(2);
  });
});
