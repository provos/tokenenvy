// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ShareFailureCounts, ShareRefusalCounts } from '../../src/lib/components/share';
import type { DayDetailResponse } from '../../src/lib/types';
import ShareModalHarness from './fixtures/ShareModalHarness.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

const initialDetail: DayDetailResponse = {
  date: '2026-08-14',
  timezone: 'America/Los_Angeles',
  summary: {
    count: 30,
    sessions: 6,
    median: 70,
    q1: 55,
    q3: 91,
    p10: 35,
    p90: 105,
    ciLow: 64,
    ciHigh: 76,
    outputTokens: 2_400,
  },
  speedIndex: {
    value: 112,
    ciLow: 104,
    ciHigh: 120,
    percentile: 88,
    eligible: true,
    reason: null,
  },
  models: [],
  histogram: [{ lower: 60, upper: 80, count: 30 }],
  hourly: [],
  exclusions: {},
};

const updatedDetail: DayDetailResponse = {
  ...initialDetail,
  summary: {
    ...initialDetail.summary,
    median: 20,
    q1: 15,
    q3: 25,
  },
  speedIndex: {
    value: 80,
    ciLow: 70,
    ciHigh: 90,
    percentile: 5,
    eligible: true,
    reason: null,
  },
  histogram: [{ lower: 10, upper: 30, count: 30 }],
};

const initialRefusals: ShareRefusalCounts = {
  recorded: true,
  attempted: 0,
  recovered: 0,
  userVisible: 0,
};

const updatedRefusals: ShareRefusalCounts = {
  recorded: true,
  attempted: 3,
  recovered: 1,
  userVisible: 1,
};

const initialFailures: ShareFailureCounts = {
  recorded: true,
  attempted: 0,
  overloaded: 0,
  serverError: 0,
};

const updatedFailures: ShareFailureCounts = {
  recorded: true,
  attempted: 10,
  overloaded: 7,
  serverError: 3,
};

function click(target: ParentNode, selector: string) {
  const button = target.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button: ${selector}`);
  button.click();
}

function modalState(target: ParentNode) {
  const mood = target.querySelector<HTMLInputElement>('#share-sentiment');
  const metric = target.querySelector<HTMLElement>('.share-metric-lockup strong');
  const preview = target.querySelector<HTMLElement>('.share-preview');
  if (!mood || !metric || !preview) throw new Error('Share modal did not render');
  return {
    mood,
    metric: metric.textContent,
    busy: preview.getAttribute('aria-busy'),
  };
}

describe('share modal client state', () => {
  it('selects the suggested mood and holds its snapshot through background refreshes', async () => {
    const renderSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(ShareModalHarness, {
      target,
      props: {
        initialDetail,
        updatedDetail,
        initialRefusals,
        updatedRefusals,
        initialFailures,
        updatedFailures,
      },
    });

    try {
      flushSync(() => click(target, '[data-testid="open-share"]'));
      await tick();
      expect(modalState(target)).toMatchObject({ metric: '70', busy: 'false' });
      expect(modalState(target).mood.getAttribute('aria-valuetext')).toBe('Positive');
      // A quiet day carries no failure stamp at all.
      expect(target.querySelector('.share-failure-stamp')).toBeNull();

      const mood = modalState(target).mood;
      mood.value = '0';
      flushSync(() => mood.dispatchEvent(new Event('input', { bubbles: true })));
      await tick();
      expect(modalState(target).mood.getAttribute('aria-valuetext')).toBe('Neutral');
      const renderCount = renderSpy.mock.calls.length;

      flushSync(() => click(target, '[data-testid="refresh-day"]'));
      await tick();
      expect(modalState(target)).toMatchObject({ metric: '70', busy: 'false' });
      expect(modalState(target).mood.getAttribute('aria-valuetext')).toBe('Neutral');
      expect(target.textContent).not.toContain('Refreshing this day before sharing');
      expect(target.textContent).not.toContain('3 refusals');
      expect(target.querySelector('.share-failure-stamp')).toBeNull();
      expect(renderSpy).toHaveBeenCalledTimes(renderCount);

      flushSync(() => click(target, '.share-modal .icon-button'));
      flushSync(() => click(target, '[data-testid="open-share"]'));
      await tick();
      expect(modalState(target)).toMatchObject({ metric: '20', busy: 'false' });
      expect(modalState(target).mood.getAttribute('aria-valuetext')).toBe('Very negative');
      expect(target.textContent).toContain(
        '3 refusal signals · 1 recovered · 1 user-visible · 1 unresolved',
      );
      expect(target.textContent).toContain('explicit lower bound');
      expect(target.querySelector('.share-failure-stamp')?.textContent).toBe(
        '\u229710 API failures \u00b7 the service could not',
      );
      const refreshedMood = modalState(target).mood;
      refreshedMood.value = '2';
      flushSync(() => refreshedMood.dispatchEvent(new Event('input', { bubbles: true })));
      await tick();
      expect(refreshedMood.getAttribute('aria-valuetext')).toBe('Very positive');
      expect(
        target.querySelector('.share-preview-refusals')?.classList.contains('user-visible'),
      ).toBe(true);
      expect(target.textContent).toContain('explicit lower bound');
    } finally {
      renderSpy.mockRestore();
      unmount(component);
      target.remove();
    }
  });
});
