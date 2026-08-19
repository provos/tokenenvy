// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import DailyChart from '../../src/lib/components/DailyChart.svelte';
import type { DailyPoint, DatedFailureCounts, ModelFamily } from '../../src/lib/types';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

const points: DailyPoint[] = [
  {
    date: '2026-08-17',
    family: 'sonnet',
    count: 40,
    sessions: 6,
    median: 52,
    q1: 40,
    q3: 60,
    p10: 30,
    p90: 80,
    ciLow: 48,
    ciHigh: 57,
    outputTokens: 3000,
    provisional: 0,
  },
  {
    date: '2026-08-18',
    family: 'opus',
    count: 30,
    sessions: 4,
    median: 70,
    q1: 55,
    q3: 91,
    p10: 35,
    p90: 105,
    ciLow: 64,
    ciHigh: 76,
    outputTokens: 2400,
    provisional: 0,
  },
];

const failures: DatedFailureCounts[] = [
  { date: '2026-08-17', attempted: 2, overloaded: 2, serverError: 0 },
  { date: '2026-08-18', attempted: 10, overloaded: 8, serverError: 2 },
];

function render(props: { visibleFamilies: ModelFamily[]; failures?: DatedFailureCounts[] }): {
  target: HTMLElement;
  dispose: () => void;
} {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(DailyChart, {
    target,
    props: {
      points,
      timezone: 'UTC',
      today: '2026-08-18',
      visibleFamilies: props.visibleFamilies,
      failures: props.failures ?? failures,
      selectedDate: '2026-08-18',
      onselect: () => {},
    },
  });
  flushSync();
  return {
    target,
    dispose: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe('DailyChart failure markers', () => {
  it('renders one fault marker per failing day regardless of the family filter', () => {
    for (const visibleFamilies of [
      ['opus', 'sonnet'],
      ['sonnet'],
      ['haiku'],
      [],
    ] as ModelFamily[][]) {
      const { target, dispose } = render({ visibleFamilies });
      try {
        expect(target.querySelectorAll('.failure-marker')).toHaveLength(2);
        expect(target.querySelectorAll('.failure-marker.server-fault')).toHaveLength(1);
      } finally {
        dispose();
      }
    }
  });

  it('parks the fault row above the refusal row and keeps markers decorative', () => {
    const { target, dispose } = render({ visibleFamilies: ['opus', 'sonnet'] });
    try {
      const markers = [...target.querySelectorAll('.failure-marker')];
      expect(markers).not.toHaveLength(0);
      for (const marker of markers) {
        expect(marker.getAttribute('aria-hidden')).toBe('true');
        // Refusal triangles sit at y = -18; failures must clear them.
        expect(marker.getAttribute('transform')).toMatch(/ -36\)$/);
      }
    } finally {
      dispose();
    }
  });

  it('adds headroom to the viewBox only when failures exist', () => {
    const withFailures = render({ visibleFamilies: ['opus'] });
    const withoutFailures = render({ visibleFamilies: ['opus'], failures: [] });
    try {
      const viewBox = (result: { target: HTMLElement }) =>
        result.target.querySelector('svg.trend-chart')?.getAttribute('viewBox');
      expect(viewBox(withoutFailures)).toBe('0 0 890 380');
      expect(viewBox(withFailures)).toBe('0 0 890 398');
      expect(withoutFailures.target.querySelector('.failure-marker')).toBeNull();
      expect(withoutFailures.target.querySelector('.chart-failure-legend')).toBeNull();
    } finally {
      withFailures.dispose();
      withoutFailures.dispose();
    }
  });

  it('describes failures for screen readers without a model attribution', () => {
    const { target, dispose } = render({ visibleFamilies: ['sonnet'] });
    try {
      const list = target.querySelector('ul[aria-label="API failures by day"]');
      expect(list?.textContent).toContain('10 API failures: 8 overloaded, 2 server faults');
      expect(list?.textContent).toContain('not model refusals');
      const target18 = target.querySelector('[data-date="2026-08-18"]');
      expect(target18?.getAttribute('aria-label')).toContain('10 API failures');
    } finally {
      dispose();
    }
  });
});
