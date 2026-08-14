import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ShareModal from '../../src/lib/components/ShareModal.svelte';
import type { DayDetailResponse } from '../../src/lib/types';

const detail: DayDetailResponse = {
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
    outputTokens: 2_400
  },
  speedIndex: {
    value: 112,
    ciLow: 104,
    ciHigh: 120,
    percentile: 88,
    eligible: true,
    reason: null
  },
  models: [],
  histogram: [
    { lower: 40, upper: 60, count: 8 },
    { lower: 60, upper: 80, count: 22 }
  ],
  hourly: [],
  exclusions: {}
};

describe('share-card customization', () => {
  it('renders an accessible five-stop sentiment slider and a non-color expression cue', () => {
    const { body } = render(ShareModal, {
      props: {
        open: true,
        detail,
        refusals: { recorded: true, attempted: 2, recovered: 1, userVisible: 1 },
        isToday: true,
        refreshing: false,
        onclose: () => undefined
      }
    });

    expect(body).toContain('id="share-sentiment"');
    expect(body).toContain('type="range"');
    expect(body).toContain('min="-2"');
    expect(body).toContain('max="2"');
    expect(body).toContain('aria-valuetext="Neutral"');
    expect(body).toContain('share-sentiment-face');
    expect(body).toContain('Refusals (explicit lower bound): 2 · 1 recovered · 1 user-visible');
    expect(body).toContain('Run it yourself · npx tokenenvy');
    expect(body).toContain('Starts from your adjusted comparable-day result. Move it anywhere;');
    expect(body).toContain('it changes the attitude, expression, and palette—not your stats.');
  });
});
