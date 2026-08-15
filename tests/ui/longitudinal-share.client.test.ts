// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { LongitudinalSummary } from '../../src/lib/types';
import LongitudinalShareModalHarness from './fixtures/LongitudinalShareModalHarness.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

const initialSummary: LongitudinalSummary = {
  timezone: 'UTC',
  days: 90,
  startDate: '2026-05-17',
  throughDate: '2026-08-14',
  families: ['sonnet'],
  observedDays: 32,
  measuredRequests: 800,
  measuredOutputTokens: 2_400_000,
  qualifiedDays: 26,
  comparableRequestCoverage: 0.84,
  quality: 'robust',
  variationPct: 18,
  trendPct: 4,
  points: [
    { date: '2026-05-17', index: 97, requestCount: 25, coverage: 0.8 },
    { date: '2026-08-14', index: 103, requestCount: 30, coverage: 0.9 },
  ],
  refusalsRecorded: true,
  refusals: [],
};

const updatedSummary: LongitudinalSummary = {
  ...initialSummary,
  days: 365,
  startDate: '2025-08-15',
  families: ['opus'],
  measuredOutputTokens: 9_900_000,
  variationPct: 42,
  refusals: [
    {
      date: '2026-08-14',
      selected: { attempted: 3, recovered: 1, userVisible: 2, unknown: 0 },
      unattributed: { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
    },
  ],
};

function click(target: ParentNode, selector: string) {
  const button = target.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing button: ${selector}`);
  button.click();
}

function preview(target: ParentNode): HTMLElement {
  const card = target.querySelector<HTMLElement>('.longitudinal-share-preview');
  if (!card) throw new Error('Longitudinal card did not render');
  return card;
}

describe('longitudinal share client state', () => {
  it('holds range, filters, metrics, mood, and image through background refreshes', async () => {
    const renderSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(LongitudinalShareModalHarness, {
      target,
      props: { initialSummary, updatedSummary },
    });

    try {
      flushSync(() => click(target, '[data-testid="open-longitudinal-share"]'));
      await tick();
      expect(preview(target).textContent).toContain('90-day · Sonnet');
      expect(preview(target).textContent).toContain('18%');
      const mood = target.querySelector<HTMLInputElement>('#longitudinal-sentiment');
      expect(mood?.getAttribute('aria-valuetext')).toBe('Good');
      const renderCount = renderSpy.mock.calls.length;

      flushSync(() => click(target, '[data-testid="refresh-longitudinal"]'));
      await tick();
      expect(preview(target).textContent).toContain('90-day · Sonnet');
      expect(preview(target).textContent).toContain('18%');
      expect(preview(target).textContent).not.toContain('365-day');
      expect(preview(target).textContent).not.toContain('3 selected-model');
      expect(renderSpy).toHaveBeenCalledTimes(renderCount);

      flushSync(() => click(target, '.longitudinal-share-modal .icon-button'));
      flushSync(() => click(target, '[data-testid="open-longitudinal-share"]'));
      await tick();
      expect(preview(target).textContent).toContain('1-year · Opus');
      expect(preview(target).textContent).toContain('42%');
      expect(preview(target).textContent).toContain(
        '3 selected-model refusal signals · 1 recovered · 2 user-visible',
      );
      expect(
        target
          .querySelector<HTMLInputElement>('#longitudinal-sentiment')
          ?.getAttribute('aria-valuetext'),
      ).toBe('Brutal');
      const refreshedMood = target.querySelector<HTMLInputElement>('#longitudinal-sentiment');
      if (!refreshedMood) throw new Error('Missing longitudinal mood slider');
      refreshedMood.value = '2';
      flushSync(() => refreshedMood.dispatchEvent(new Event('input', { bubbles: true })));
      await tick();
      expect(refreshedMood.getAttribute('aria-valuetext')).toBe('Glorious');
      expect(preview(target).textContent).toContain('Explicit signals only · lower bound');
      expect(preview(target).querySelector('path.user-visible')).not.toBeNull();
      expect(renderSpy.mock.calls.length).toBeGreaterThan(renderCount);
    } finally {
      renderSpy.mockRestore();
      unmount(component);
      target.remove();
    }
  });
});
