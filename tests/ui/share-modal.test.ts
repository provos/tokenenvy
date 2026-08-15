import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ShareModal from '../../src/lib/components/ShareModal.svelte';
import {
  buildShareCardData,
  getShareSentimentDescription,
  type ShareRefusalCounts,
} from '../../src/lib/components/share';
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
  histogram: [
    { lower: 40, upper: 60, count: 8 },
    { lower: 60, upper: 80, count: 22 },
  ],
  hourly: [],
  exclusions: {},
};

describe('share-card customization', () => {
  const renderShareCard = (refusals: ShareRefusalCounts, isToday = true) =>
    render(ShareModal, {
      props: {
        open: true,
        detail,
        refusals,
        isToday,
        onclose: () => undefined,
      },
    });

  it('renders an accessible five-stop sentiment slider and a non-color expression cue', () => {
    const { body } = renderShareCard({
      recorded: true,
      attempted: 2,
      recovered: 1,
      userVisible: 1,
    });
    const normalizedBody = body.replace(/\s+/g, ' ');

    expect(body).toContain('id="share-sentiment"');
    expect(body).toContain('type="range"');
    expect(body).toContain('min="-2"');
    expect(body).toContain('max="2"');
    expect(body).toContain('aria-valuetext="Neutral"');
    expect(body).toContain('share-sentiment-face');
    expect(body).toContain(
      'Brutal</span><span>Rough</span><span>Neutral</span><span>Good</span><span>Glorious',
    );
    expect(body).toContain('2 refusal signals · 1 recovered · 1 user-visible');
    expect(body).toContain('explicit lower bound');
    expect(normalizedBody.match(/explicit lower bound/g)).toHaveLength(2);
    expect(body).toContain('Measure yours · npx tokenenvy');
    expect(body).toContain('A Security Blueprints, LLC project · securityblueprints.io');
    expect(body).toContain('class="share-preview-headline"');
    expect(body).toContain('class="share-metric-lockup"');
    expect(body).toContain('<span>tok/s</span>');
    expect(body).toContain('effective output · wait + think time included');
    expect(body).toContain('Copy text receipt');
    expect(normalizedBody).toContain(
      'Comparable days suggested Good. 1 user-visible refusal signal moved it to Rough. Pick the mood; the numbers stay put.',
    );
  });

  it('omits an empty refusal row from the protected card footer', () => {
    const { body } = renderShareCard({
      recorded: true,
      attempted: 0,
      recovered: 0,
      userVisible: 0,
    });

    expect(body).not.toContain('share-preview-refusals');
    expect(body).not.toContain('0 refusals');
    expect(body).toContain('--card-headline-top:');
    expect(body).toContain('--card-footer-top:');
  });

  it('keeps unavailable refusal signals explicit without exposing details', () => {
    const { body } = renderShareCard(
      { recorded: false, attempted: 0, recovered: 0, userVisible: 0 },
      false,
    );

    expect(body).toContain('class="share-preview-refusals"');
    expect(body).toContain('Explicit refusal signals unavailable');
  });

  it('explains why an ineligible comparison starts at Neutral', () => {
    expect(
      getShareSentimentDescription(
        buildShareCardData({
          date: detail.date,
          median: detail.summary.median,
          count: detail.summary.count,
          sessions: detail.summary.sessions,
          outputTokens: detail.summary.outputTokens,
          isToday: true,
          speedIndex: {
            value: 104.4,
            ciLow: null,
            ciHigh: null,
            percentile: 66.7,
            eligible: false,
            reason: 'Not enough comparable model and output-size coverage',
          },
          refusals: { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
          models: [],
          histogram: [],
        }),
        'Not enough comparable model and output-size coverage',
      ),
    ).toBe(
      'Neutral for now. Not enough comparable model and output-size coverage. Pick the mood; the numbers stay put.',
    );
  });
});
