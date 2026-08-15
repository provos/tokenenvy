import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import DayHero from '../../src/lib/components/DayHero.svelte';
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
  histogram: [
    { lower: 40, upper: 60, count: 4 },
    { lower: 60, upper: 80, count: 8 },
  ],
  hourly: [],
  exclusions: {},
};

describe('daily hero refresh', () => {
  it('keeps the current number and histogram mounted while refreshing', () => {
    const { body } = render(DayHero, {
      props: {
        date: detail.date,
        today: detail.date,
        detail,
        loading: true,
        error: null,
        onretry: () => undefined,
        onmore: () => undefined,
      },
    });

    expect(body).toContain('64');
    expect(body).toContain('tokens/s');
    expect(body).toContain('histogram-backdrop');
    expect(body).toContain('Updating in the background');
    expect(body).not.toContain('Loading this day');
  });
});
