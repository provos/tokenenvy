import { describe, expect, it } from 'vitest';
import type { DailyPoint } from '../../src/lib/types';
import { areaPath, chartMaximum, chartTickIndices, chartTickLabel, dayLabel, linePath } from '../../src/lib/components/chart';
import {
  buildShareCardData,
  DEFAULT_SHARE_PRODUCT_URL,
  getShareCaption,
  getShareMoodLine,
  getShareRefusalLine,
  getShareSentimentTheme,
  getShareTagline,
  normalizeHistogram,
  safeShareProductLink,
  sentimentAfterCardChange,
  suggestedShareSentiment,
} from '../../src/lib/components/share';

const points: DailyPoint[] = [
  {
    date: '2026-08-13',
    family: 'sonnet',
    count: 42,
    sessions: 8,
    median: 52,
    q1: 40,
    q3: 60,
    p10: 30,
    p90: 80,
    ciLow: 48,
    ciHigh: 57,
    outputTokens: 3000,
    provisional: 0
  },
  {
    date: '2026-08-14',
    family: 'sonnet',
    count: 30,
    sessions: 6,
    median: 70,
    q1: 55,
    q3: 91,
    p10: 35,
    p90: 105,
    ciLow: 64,
    ciHigh: 76,
    outputTokens: 2400,
    provisional: 1
  }
];

describe('dashboard chart helpers', () => {
  it('rounds the y-axis above the highest IQR value', () => {
    expect(chartMaximum(points)).toBe(100);
  });

  it('keeps confidence whiskers inside the y-axis', () => {
    expect(chartMaximum([{ ...points[0], q3: 60, ciHigh: 142 }])).toBe(200);
  });

  it('creates finite median and band paths', () => {
    const dates = points.map((point) => point.date);
    expect(linePath(points, dates, 100, 800, 300)).toMatch(/^M 0\.00 144\.00 L 800\.00 90\.00$/);
    expect(areaPath(points, dates, 100, 800, 300)).not.toContain('NaN');
  });

  it('formats a calendar day without shifting it across timezones', () => {
    expect(dayLabel('2026-08-14', 'America/Los_Angeles')).toMatch(/Aug 14/);
    expect(dayLabel('2026-08-14', 'Pacific/Kiritimati')).toMatch(/Aug 14/);
  });

  it('uses one final tick slot for the stacked Today and calendar labels', () => {
    expect(chartTickIndices(1)).toEqual([0]);
    expect(chartTickIndices(2)).toEqual([0, 1]);
    expect(chartTickIndices(64)).toEqual([0, 11, 21, 32, 42, 53, 63]);
    expect(chartTickIndices(90)).toEqual([0, 15, 30, 45, 59, 74, 89]);
    expect(chartTickIndices(365)).toEqual([0, 61, 121, 182, 243, 303, 364]);
    expect(chartTickLabel('2026-08-14', '2026-08-14')).toEqual({
      primary: 'Today',
      secondary: expect.stringMatching(/Aug 14/),
      accessible: expect.stringMatching(/Today, Aug 14/)
    });
  });
});

describe('privacy-safe share-card data', () => {
  it('accepts only credential-free HTTPS product links', () => {
    expect(safeShareProductLink(DEFAULT_SHARE_PRODUCT_URL)).toEqual({
      href: 'https://www.npmjs.com/package/tokenenvy',
      label: 'www.npmjs.com/package/tokenenvy'
    });
    expect(safeShareProductLink('https://example.com/speedometer/')).toEqual({
      href: 'https://example.com/speedometer/',
      label: 'example.com/speedometer'
    });
    expect(safeShareProductLink('javascript:alert(1)')).toBeNull();
    expect(safeShareProductLink('http://example.com/tokenenvy')).toBeNull();
    expect(safeShareProductLink('https://user:secret@example.com')).toBeNull();
    expect(safeShareProductLink(undefined)).toBeNull();
  });

  it('allowlists fields, sorts the selected-day model mix, and bounds the histogram', () => {
    const privateMarker = 'PRIVATE_CANARY_DO_NOT_SHARE';
    const card = buildShareCardData({
      date: '2026-08-14',
      median: 70,
      count: 30,
      sessions: 6,
      outputTokens: 2_400,
      isToday: true,
      speedIndex: {
        value: 112,
        ciLow: 104,
        ciHigh: 120,
        percentile: 88,
        eligible: true,
        reason: null,
        privateMarker
      } as never,
      refusals: {
        recorded: true,
        attempted: 3,
        recovered: 1,
        userVisible: 1,
        privateMarker
      } as never,
      models: [
        { ...points[0], outputTokens: 1_000, share: 0.3, privateMarker },
        { ...points[0], family: 'opus', outputTokens: 2_000, share: 0.7, privateMarker }
      ] as never,
      histogram: Array.from({ length: 45 }, (_, index) => ({
        lower: index * 10,
        upper: index * 10 + 10,
        count: index + 1,
        privateMarker
      })) as never
    });

    expect(card.indexLabel).toBe('+12% vs your baseline');
    expect(card.models.map(({ family }) => family)).toEqual(['opus', 'sonnet']);
    expect(card.histogram).toHaveLength(40);
    expect(JSON.stringify(card)).not.toContain(privateMarker);
    expect(suggestedShareSentiment(card)).toBe(1);
    expect(getShareTagline('spicy', 2, card)).toBe('Anthropic loves me today');
    expect(getShareMoodLine(card)).toContain('88th percentile');
    expect(getShareRefusalLine(card)).toBe(
      'Refusals (explicit lower bound): 3 · 1 recovered · 1 user-visible · 1 unresolved'
    );
    expect(normalizeHistogram(card.histogram, card.median).some((bar) => bar.containsMedian)).toBe(true);
  });

  it('maps sentiment to distinct semantic palettes without changing measurements', () => {
    const negative = getShareSentimentTheme(-2);
    const neutral = getShareSentimentTheme(0);
    const positive = getShareSentimentTheme(2);

    expect([negative.label, neutral.label, positive.label]).toEqual(['Brutal', 'Neutral', 'Glorious']);
    expect(new Set([negative.backgroundStart, neutral.backgroundStart, positive.backgroundStart]).size).toBe(3);
    expect(new Set([negative.accent, neutral.accent, positive.accent]).size).toBe(3);
  });

  it('suggests conservative moods from percentile, adjusted effect, and confidence together', () => {
    const sentimentFor = (
      value: number,
      percentile: number,
      ciLow: number,
      ciHigh: number
    ) => suggestedShareSentiment(
      buildShareCardData({
        date: '2026-08-14',
        median: 60,
        count: 30,
        sessions: 6,
        outputTokens: 2_400,
        isToday: true,
        speedIndex: { value, ciLow, ciHigh, percentile, eligible: true, reason: null },
        models: [],
        histogram: []
      })
    );

    expect(sentimentFor(90, 10, 82, 99)).toBe(-2);
    expect(sentimentFor(90, 10, 82, 100)).toBe(-1);
    expect(sentimentFor(91, 10, 82, 99)).toBe(-1);
    expect(sentimentFor(99, 35, 90, 108)).toBe(-1);
    expect(sentimentFor(99, 45, 90, 108)).toBe(-1);
    expect(sentimentFor(99, 46, 90, 108)).toBe(0);
    expect(sentimentFor(100, 10, 90, 110)).toBe(0);
    expect(sentimentFor(101, 54, 92, 112)).toBe(0);
    expect(sentimentFor(101, 55, 92, 112)).toBe(1);
    expect(sentimentFor(110, 90, 101, 118)).toBe(2);
    expect(sentimentFor(110, 90, 100, 118)).toBe(1);
    expect(sentimentFor(109, 90, 101, 118)).toBe(1);
    expect(sentimentFor(101, 45, 92, 112)).toBe(0);
    expect(sentimentFor(99, 55, 90, 108)).toBe(0);
  });

  it('resets a suggested sentiment for a new day but preserves a same-day override', () => {
    expect(sentimentAfterCardChange('2026-08-14', '2026-08-14', -2, 1)).toBe(-2);
    expect(sentimentAfterCardChange('2026-08-14', '2026-08-15', -2, 1)).toBe(1);
  });

  it('uses historical tense and only adds the configured link where the flow supports it', () => {
    const card = buildShareCardData({
      date: '2026-08-13',
      median: 42,
      count: 9,
      sessions: 2,
      outputTokens: 900,
      isToday: false,
      speedIndex: {
        value: null,
        ciLow: null,
        ciHigh: null,
        percentile: null,
        eligible: false,
        reason: 'Baseline warming up'
      },
      models: [],
      histogram: [{ lower: 40, upper: 50, count: 9 }]
    });

    expect(suggestedShareSentiment(card)).toBe(0);
    expect(getShareTagline('friendly', 0, card)).toBe('Claude Code kept it steady that day');
    expect(getShareTagline('spicy', 0, card)).toBe('Anthropic and I were on speaking terms');
    expect(getShareCaption('friendly', 0, card, 'bluesky', 'https://tokenenvy.example/')).toContain(
      'https://tokenenvy.example/'
    );
    expect(getShareCaption('friendly', 0, card, 'x', null)).toContain(
      'Built by Security Blueprints, LLC: securityblueprints.io'
    );
    expect(getShareCaption('friendly', 0, card, 'linkedin', 'https://tokenenvy.example/')).not.toContain(
      'https://tokenenvy.example/'
    );
    expect(getShareRefusalLine(card)).toBe('Refusals: explicit signals unavailable');
  });

  it('shows a recorded zero rather than implying that classifier coverage is complete', () => {
    const card = buildShareCardData({
      date: '2026-08-14',
      median: 50,
      count: 4,
      sessions: 2,
      outputTokens: 400,
      isToday: true,
      speedIndex: {
        value: null,
        ciLow: null,
        ciHigh: null,
        percentile: null,
        eligible: false,
        reason: 'Baseline warming up'
      },
      refusals: { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      models: [],
      histogram: []
    });

    expect(getShareRefusalLine(card)).toBe('Refusals (explicit lower bound): 0');
  });
});
