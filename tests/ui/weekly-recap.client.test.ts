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
  refusals: {
    recorded: true,
    attempted: 0,
    recovered: 0,
    userVisible: 0,
    unknown: 0,
    affectedDates: [],
  },
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
  refusals: {
    recorded: true,
    attempted: 2,
    recovered: 1,
    userVisible: 1,
    unknown: 0,
    affectedDates: [
      {
        date: '2026-08-14',
        attempted: 2,
        recovered: 1,
        userVisible: 1,
        unknown: 0,
      },
    ],
  },
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
      const mood = target.querySelector<HTMLInputElement>('#weekly-sentiment');
      expect(mood?.getAttribute('aria-valuetext')).toBe('Positive');
      if (!mood) throw new Error('Missing weekly mood slider');
      mood.value = '2';
      flushSync(() => mood.dispatchEvent(new Event('input', { bubbles: true })));
      await tick();
      expect(mood.getAttribute('aria-valuetext')).toBe('Very positive');
      const renderCount = renderSpy.mock.calls.length;
      expect(renderCount).toBeGreaterThan(0);

      flushSync(() => click(target, '[data-testid="refresh-week"]'));
      await tick();
      expect(weeklyMetric(target)).toBe('72');
      expect(target.textContent).toContain('25K output tokens');
      expect(target.textContent).not.toContain('70K output tokens');
      expect(target.textContent).not.toContain('2 refusal signals');
      expect(mood.getAttribute('aria-valuetext')).toBe('Very positive');
      expect(renderSpy).toHaveBeenCalledTimes(renderCount);

      flushSync(() => click(target, '.weekly-recap-modal .icon-button'));
      flushSync(() => click(target, '[data-testid="open-weekly-share"]'));
      await tick();
      expect(weeklyMetric(target)).toBe('31');
      expect(target.textContent).toContain('70K output tokens');
      const refreshedMood = target.querySelector<HTMLInputElement>('#weekly-sentiment');
      expect(refreshedMood?.getAttribute('aria-valuetext')).toBe('Very negative');
      expect(target.textContent).toContain('2 refusal signals · 1 recovered · 1 user-visible');
      const marker = target.querySelector<HTMLElement>('[data-weekday="5"]');
      expect(marker?.classList.contains('affected')).toBe(true);
      expect(marker?.classList.contains('user-visible')).toBe(true);
      if (!refreshedMood) throw new Error('Missing refreshed weekly mood slider');
      refreshedMood.value = '2';
      flushSync(() => refreshedMood.dispatchEvent(new Event('input', { bubbles: true })));
      await tick();
      expect(refreshedMood.getAttribute('aria-valuetext')).toBe('Very positive');
      expect(target.textContent).toContain('2 refusal signals · 1 recovered · 1 user-visible');
      expect(marker?.classList.contains('user-visible')).toBe(true);
      expect(renderSpy.mock.calls.length).toBeGreaterThan(renderCount);
    } finally {
      renderSpy.mockRestore();
      unmount(component);
      target.remove();
    }
  });
});
