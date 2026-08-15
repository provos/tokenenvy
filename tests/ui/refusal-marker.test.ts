import { describe, expect, it } from 'vitest';
import {
  refusalCanvasLineColor,
  refusalMarkerLineDash,
} from '../../src/lib/components/LongitudinalShareModal.svelte';

describe('exported refusal marker style', () => {
  it('keeps model-unattributed markers gray-dashed in canvas exports', () => {
    expect(refusalMarkerLineDash(false)).toEqual([]);
    expect(refusalMarkerLineDash(true)).toEqual([4, 3]);
  });

  it('keeps unmatched evidence muted while preserving selected-family warning colors', () => {
    expect(refusalCanvasLineColor(0, 2, 1, '#muted')).toBe('#ff826f');
    expect(refusalCanvasLineColor(0, 1, 0, '#muted')).toBe('#f0bd68');
    expect(refusalCanvasLineColor(1, 2, 1, '#muted')).toBe('#muted');
    expect(refusalCanvasLineColor(0, 0, 0, '#muted')).toBe('#muted');
  });

  it('renders unavailable canvas evidence in the muted color', () => {
    expect(refusalCanvasLineColor(0, 0, 0, 'rgba(242, 238, 230, 0.68)')).toBe(
      'rgba(242, 238, 230, 0.68)',
    );
  });
});
