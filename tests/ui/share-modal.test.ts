import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ShareModal from '../../src/lib/components/ShareModal.svelte';
import {
  buildShareCardData,
  getShareCaption,
  getShareSentimentDescription,
  getShareTextReceipt,
  type ShareFailureCounts,
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

const noFailures: ShareFailureCounts = {
  recorded: true,
  attempted: 0,
  overloaded: 0,
  serverError: 0,
};

describe('share-card customization', () => {
  const renderShareCard = (
    refusals: ShareRefusalCounts,
    isToday = true,
    failures: ShareFailureCounts = noFailures,
  ) =>
    render(ShareModal, {
      props: {
        open: true,
        detail,
        refusals,
        failures,
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
          failures: noFailures,
          models: [],
          histogram: [],
        }),
        'Not enough comparable model and output-size coverage',
      ),
    ).toBe(
      'Neutral for now. Not enough comparable model and output-size coverage. Pick the mood; the numbers stay put.',
    );
  });
  it('stamps platform failures on the card without touching the refusal line', () => {
    const { body } = renderShareCard(
      { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      true,
      {
        recorded: true,
        attempted: 10,
        overloaded: 7,
        serverError: 3,
      },
    );
    const normalizedBody = body.replace(/\s+/g, ' ');

    expect(body).toContain('class="share-failure-stamp"');
    expect(normalizedBody).toContain('10 calls the service could not complete');
    expect(body).toContain('⊗');
    // The refusal axis is untouched: no summed total, no refusal wording.
    expect(body).not.toContain('share-preview-refusals');
    expect(normalizedBody).not.toContain('10 refusal');
    expect(normalizedBody).toContain(
      'Comparable days suggested Good. 10 API failures that never completed moved it to Neutral. Pick the mood; the numbers stay put.',
    );
    // The accessible label spells the split out, which the terse stamp does not.
    expect(normalizedBody).toContain(
      '10 API failures · 7 overloaded · 3 server faults · the service could not complete',
    );
  });

  it('leaves the card unchanged when the day had no failures', () => {
    const { body } = renderShareCard(
      { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      true,
      {
        recorded: true,
        attempted: 0,
        overloaded: 0,
        serverError: 0,
      },
    );

    expect(body).not.toContain('share-failure-stamp');
    expect(body).not.toContain('API failure');
    expect(body).not.toContain('the service could not complete');
  });

  it('says nothing at all when the log format records no failures', () => {
    const { body } = renderShareCard(
      { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      true,
      {
        recorded: false,
        attempted: 0,
        overloaded: 0,
        serverError: 0,
      },
    );

    expect(body).not.toContain('share-failure-stamp');
    expect(body).not.toContain('failures unavailable');
  });

  it('reports both interruption axes in the mood copy without summing them', () => {
    const { body } = renderShareCard(
      { recorded: true, attempted: 2, recovered: 1, userVisible: 1 },
      true,
      {
        recorded: true,
        attempted: 10,
        overloaded: 7,
        serverError: 3,
      },
    );
    const normalizedBody = body.replace(/\s+/g, ' ');

    expect(normalizedBody).toContain(
      'Comparable days suggested Good. 1 user-visible refusal signal moved it to Rough. 10 API failures that never completed kept it at Rough. Pick the mood; the numbers stay put.',
    );
    expect(normalizedBody).toContain('2 refusal signals · 1 recovered · 1 user-visible');
    expect(normalizedBody).toContain('10 calls the service could not complete');
    expect(normalizedBody).not.toContain('12 ');
  });

  it('carries the failure axis into captions and the text receipt', () => {
    const card = buildShareCardData({
      date: detail.date,
      median: detail.summary.median,
      count: detail.summary.count,
      sessions: detail.summary.sessions,
      outputTokens: detail.summary.outputTokens,
      isToday: true,
      speedIndex: detail.speedIndex,
      refusals: { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      failures: { recorded: true, attempted: 10, overloaded: 7, serverError: 3 },
      models: [],
      histogram: [],
    });

    expect(getShareCaption('friendly', 0, card, 'generic', null)).toContain(
      '10 API failures · 7 overloaded · 3 server faults · the service could not complete.',
    );
    expect(getShareTextReceipt('friendly', 0, card)).toContain(
      '10 API failures · 7 overloaded · 3 server faults · the service could not complete',
    );
    const xCaption = getShareCaption('friendly', 0, card, 'x', null);
    expect(xCaption).toContain(
      '10 API failures: 7 overloaded/3 server; the service could not complete.',
    );
    expect(xCaption.length).toBeLessThanOrEqual(250);

    const quiet = buildShareCardData({
      date: detail.date,
      median: detail.summary.median,
      count: detail.summary.count,
      sessions: detail.summary.sessions,
      outputTokens: detail.summary.outputTokens,
      isToday: true,
      speedIndex: detail.speedIndex,
      refusals: { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      failures: noFailures,
      models: [],
      histogram: [],
    });
    expect(getShareCaption('friendly', 0, quiet, 'generic', null)).not.toContain('API failure');
    expect(getShareTextReceipt('friendly', 0, quiet)).not.toContain('API failure');
  });
});
