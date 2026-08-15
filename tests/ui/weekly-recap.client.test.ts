// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { WeeklyRecapData } from '../../src/lib/components/weekly-recap';
import WeeklyRecapModalHarness from './fixtures/WeeklyRecapModalHarness.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

const initialRecap: WeeklyRecapData = {
  weekStart: '2026-08-10',
  throughDate: '2026-08-14',
  daysObserved: 4,
  observedDates: ['2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14'],
  requestCount: 84,
  sessions: 12,
  median: 72,
  speedIndex: {
    value: 108,
    ciLow: null,
    ciHigh: null,
    percentile: null,
    eligible: true,
    reason: null,
  },
  models: [{ family: 'sonnet', requestCount: 60, outputTokens: 18_000, share: 0.72 }],
  fastestDay: { date: '2026-08-13', median: 91 },
  slowestDay: { date: '2026-08-11', median: 54 },
};

const updatedRecap: WeeklyRecapData = {
  ...initialRecap,
  requestCount: 120,
  sessions: 18,
  median: 31,
  speedIndex: { ...initialRecap.speedIndex, value: 79 },
  models: [{ family: 'opus', requestCount: 100, outputTokens: 41_000, share: 0.88 }],
  fastestDay: { date: '2026-08-14', median: 45 },
  slowestDay: { date: '2026-08-12', median: 21 },
};

function click(target: ParentNode, selector: string) {
  const button = target.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button: ${selector}`);
  button.click();
}

function weeklyMetric(target: ParentNode): string | null {
  return target.querySelector<HTMLElement>('.weekly-recap-center > strong')?.textContent ?? null;
}

describe('weekly recap client state', () => {
  it('holds the entire open recap and prepared image through background refreshes', async () => {
    const renderSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(WeeklyRecapModalHarness, {
      target,
      props: {
        initialRecap,
        updatedRecap,
        initialOutputTokens: 25_000,
        updatedOutputTokens: 70_000,
      },
    });

    try {
      flushSync(() => click(target, '[data-testid="open-weekly-share"]'));
      await tick();
      expect(weeklyMetric(target)).toBe('72');
      expect(target.textContent).toContain('25K output tokens');
      const renderCount = renderSpy.mock.calls.length;
      expect(renderCount).toBeGreaterThan(0);

      flushSync(() => click(target, '[data-testid="refresh-week"]'));
      await tick();
      expect(weeklyMetric(target)).toBe('72');
      expect(target.textContent).toContain('25K output tokens');
      expect(target.textContent).not.toContain('70K output tokens');
      expect(renderSpy).toHaveBeenCalledTimes(renderCount);

      flushSync(() => click(target, '.weekly-recap-modal .icon-button'));
      flushSync(() => click(target, '[data-testid="open-weekly-share"]'));
      await tick();
      expect(weeklyMetric(target)).toBe('31');
      expect(target.textContent).toContain('70K output tokens');
      expect(renderSpy.mock.calls.length).toBeGreaterThan(renderCount);
    } finally {
      renderSpy.mockRestore();
      unmount(component);
      target.remove();
    }
  });
});
