import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import HistogramDrawer from '../../src/lib/components/HistogramDrawer.svelte';
import type { DayDetailResponse } from '../../src/lib/types';

const detail: DayDetailResponse = {
  date: '2026-08-14',
  timezone: 'America/Los_Angeles',
  summary: {
    count: 12,
    sessions: 3,
    median: 64,
    q1: 50,
    q3: 75,
    p10: 42,
    p90: 90,
    ciLow: 58,
    ciHigh: 70,
    outputTokens: 4_200,
  },
  speedIndex: {
    value: 108,
    ciLow: 102,
    ciHigh: 114,
    percentile: 70,
    eligible: true,
    reason: null,
  },
  models: [],
  histogram: [],
  hourly: [],
  exclusions: {},
};

describe('daily detail refusals', () => {
  it('shows selected-day refusal outcomes and their lower-bound scope', () => {
    const { body } = render(HistogramDrawer, {
      props: {
        open: true,
        loading: false,
        detail,
        refusals: { recorded: true, attempted: 6, recovered: 2, userVisible: 1 },
        onclose: () => undefined,
      },
    });

    expect(body).toContain('Refusals for this day');
    expect(body).toContain('>6<');
    expect(body).toContain('>2<');
    expect(body).toContain('>1<');
    expect(body).toContain('>3<');
    expect(body).toContain('Explicit transcript signals only; these counts are a lower bound.');
  });

  it('explains why an eligible point estimate has no confidence interval', () => {
    const { body } = render(HistogramDrawer, {
      props: {
        open: true,
        loading: false,
        detail: {
          ...detail,
          speedIndex: { ...detail.speedIndex, ciLow: null, ciHigh: null },
        },
        refusals: { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
        onclose: () => undefined,
      },
    });

    expect(body).toContain(
      'Point estimate available. Confidence interval requires five independent sessions.',
    );
  });
});
