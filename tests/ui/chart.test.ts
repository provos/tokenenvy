import { describe, expect, it } from 'vitest';
import type { DailyPoint } from '../../src/lib/types';
import {
  areaPath,
  chartMaximum,
  chartTickIndices,
  chartTickLabel,
  dayLabel,
  linePath,
} from '../../src/lib/components/chart';
import {
  buildShareCardData,
  DEFAULT_SHARE_PRODUCT_URL,
  getShareCaption,
  getShareImageFilename,
  getShareMoodLine,
  getShareRefusalLine,
  getShareSentimentDescription,
  getShareSentimentTheme,
  getShareTagline,
  getShareTextReceipt,
  normalizeHistogram,
  safeShareProductLink,
  sentimentAfterCardChange,
  SHARE_SENTIMENTS,
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
    provisional: 0,
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
    provisional: 1,
  },
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
      accessible: expect.stringMatching(/Today, Aug 14/),
    });
  });
});

describe('privacy-safe share-card data', () => {
  it('accepts only credential-free HTTPS product links', () => {
    expect(safeShareProductLink(DEFAULT_SHARE_PRODUCT_URL)).toEqual({
      href: 'https://www.npmjs.com/package/tokenenvy',
      label: 'www.npmjs.com/package/tokenenvy',
    });
    expect(safeShareProductLink('https://example.com/speedometer/')).toEqual({
      href: 'https://example.com/speedometer/',
      label: 'example.com/speedometer',
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
        privateMarker,
      } as never,
      refusals: {
        recorded: true,
        attempted: 3,
        recovered: 1,
        userVisible: 1,
        privateMarker,
      } as never,
      models: [
        { ...points[0], outputTokens: 1_000, share: 0.3, privateMarker },
        { ...points[0], family: 'opus', outputTokens: 2_000, share: 0.7, privateMarker },
      ] as never,
      histogram: Array.from({ length: 45 }, (_, index) => ({
        lower: index * 10,
        upper: index * 10 + 10,
        count: index + 1,
        privateMarker,
      })) as never,
    });

    expect(card.indexLabel).toBe('+12% vs your baseline');
    expect(card.models.map(({ family }) => family)).toEqual(['opus', 'sonnet']);
    expect(card.histogram).toHaveLength(40);
    expect(JSON.stringify(card)).not.toContain(privateMarker);
    expect(suggestedShareSentiment(card)).toBe(-1);
    const spicyTaglines = (isToday: boolean) =>
      SHARE_SENTIMENTS.map((sentiment) =>
        getShareTagline('spicy', sentiment, { ...card, isToday }),
      );
    const friendlyTaglines = (isToday: boolean) =>
      SHARE_SENTIMENTS.map((sentiment) =>
        getShareTagline('friendly', sentiment, { ...card, isToday }),
      );
    expect(friendlyTaglines(true)).toEqual([
      'Claude Code made me wait today',
      'Claude Code dragged its feet today',
      'Claude Code kept pace today',
      'Claude Code moved fast today',
      'Claude Code flew today',
    ]);
    expect(spicyTaglines(true)).toEqual([
      'Anthropic hates me today',
      'Anthropic made me earn every token today',
      'Anthropic and I called it even today',
      'Anthropic was feeling generous today',
      'Anthropic loves me today',
    ]);
    expect(friendlyTaglines(false)).toEqual([
      'Claude Code made me wait that day',
      'Claude Code dragged its feet that day',
      'Claude Code kept pace that day',
      'Claude Code moved fast that day',
      'Claude Code flew that day',
    ]);
    expect(spicyTaglines(false)).toEqual([
      'Anthropic hated me that day',
      'Anthropic made me earn every token that day',
      'Anthropic and I called it even that day',
      'Anthropic was feeling generous that day',
      'Anthropic loved me that day',
    ]);
    expect(getShareSentimentDescription(card)).toBe(
      'Comparable days suggested Good. 1 user-visible refusal signal moved it to Rough. Pick the mood; the numbers stay put.',
    );
    expect(getShareMoodLine(card)).toBe('Faster than 88% of my comparable days');
    expect(getShareRefusalLine(card)).toBe(
      '3 refusal signals · 1 recovered · 1 user-visible · 1 unresolved · explicit lower bound',
    );
    const xCaption = getShareCaption('spicy', -1, card, 'x', null);
    expect(xCaption).toContain(
      '3 refusal signals: 1 recovered/1 visible/1 unresolved; lower bound.',
    );
    expect(xCaption).toContain('Local stats; prompts private.');
    expect(xCaption).toContain('#TokenEnvy · securityblueprints.io');
    expect(xCaption.startsWith('Anthropic made me earn every token today.')).toBe(true);
    expect(xCaption.length).toBeLessThanOrEqual(250);

    const blueskyCaption = getShareCaption(
      'spicy',
      -1,
      card,
      'bluesky',
      'https://www.npmjs.com/package/tokenenvy',
    );
    expect(blueskyCaption.startsWith('Anthropic made me earn every token today.')).toBe(true);
    expect(blueskyCaption).toContain(
      '3 refusal signals: 1 recovered/1 visible/1 unresolved; lower bound.',
    );
    expect(blueskyCaption).toContain('#TokenEnvy · securityblueprints.io');
    expect(blueskyCaption.length).toBeLessThanOrEqual(300);
    expect(normalizeHistogram(card.histogram, card.median).some((bar) => bar.containsMedian)).toBe(
      true,
    );
  });

  it('maps sentiment to distinct semantic palettes without changing measurements', () => {
    const negative = getShareSentimentTheme(-2);
    const neutral = getShareSentimentTheme(0);
    const positive = getShareSentimentTheme(2);

    expect([negative.label, neutral.label, positive.label]).toEqual([
      'Brutal',
      'Neutral',
      'Glorious',
    ]);
    expect(
      new Set([negative.backgroundStart, neutral.backgroundStart, positive.backgroundStart]).size,
    ).toBe(3);
    expect(new Set([negative.accent, neutral.accent, positive.accent]).size).toBe(3);
  });

  it('suggests conservative moods from percentile, adjusted effect, and confidence together', () => {
    const sentimentFor = (value: number, percentile: number, ciLow: number, ciHigh: number) =>
      suggestedShareSentiment(
        buildShareCardData({
          date: '2026-08-14',
          median: 60,
          count: 30,
          sessions: 6,
          outputTokens: 2_400,
          isToday: true,
          speedIndex: { value, ciLow, ciHigh, percentile, eligible: true, reason: null },
          models: [],
          histogram: [],
        }),
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

  it('suggests moderate moods from an eligible point estimate without a confidence interval', () => {
    const sentimentFor = (value: number, percentile: number) =>
      suggestedShareSentiment(
        buildShareCardData({
          date: '2026-08-14',
          median: 60,
          count: 30,
          sessions: 2,
          outputTokens: 2_400,
          isToday: true,
          speedIndex: {
            value,
            ciLow: null,
            ciHigh: null,
            percentile,
            eligible: true,
            reason: null,
          },
          models: [],
          histogram: [],
        }),
      );

    expect(sentimentFor(90, 10)).toBe(-1);
    expect(sentimentFor(99, 45)).toBe(-1);
    expect(sentimentFor(101, 55)).toBe(1);
    expect(sentimentFor(110, 90)).toBe(1);
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
        reason: 'Baseline warming up',
      },
      models: [],
      histogram: [{ lower: 40, upper: 50, count: 9 }],
    });

    expect(suggestedShareSentiment(card)).toBe(0);
    expect(getShareTagline('friendly', 0, card)).toBe('Claude Code kept pace that day');
    expect(getShareTagline('spicy', 0, card)).toBe('Anthropic and I called it even that day');
    expect(getShareCaption('friendly', 0, card, 'bluesky', 'https://tokenenvy.example/')).toContain(
      'https://tokenenvy.example/',
    );
    expect(getShareCaption('friendly', 0, card, 'bluesky', null)).toContain(
      'How did Claude treat you that day?',
    );
    expect(getShareCaption('friendly', 0, card, 'x', null)).toContain(
      '#TokenEnvy · securityblueprints.io',
    );
    expect(getShareCaption('friendly', 0, card, 'x', null)).toContain(
      'Local stats; prompts private.',
    );
    expect(
      getShareCaption('friendly', 0, card, 'linkedin', 'https://tokenenvy.example/'),
    ).not.toContain('https://tokenenvy.example/');
    expect(getShareCaption('friendly', 0, card, 'linkedin', null)).toContain(
      '\n\nToken Envy receipt:',
    );
    expect(getShareRefusalLine(card)).toBe('Explicit refusal signals unavailable');
    expect(getShareMoodLine(card)).toBe('Building a comparable baseline');
    expect(getShareSentimentDescription(card, card.indexLabel)).toBe(
      'Neutral for now. Building a comparable baseline. Pick the mood; the numbers stay put.',
    );
  });

  it('omits a recorded zero refusal line from the compact card', () => {
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
        reason: 'Baseline warming up',
      },
      refusals: { recorded: true, attempted: 0, recovered: 0, userVisible: 0 },
      models: [],
      histogram: [],
    });

    expect(getShareRefusalLine(card)).toBe('');
    expect(getShareTextReceipt('friendly', 0, card)).not.toContain('refusal');
  });

  it('builds safe variant filenames and a privacy-safe text receipt', () => {
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
      },
      refusals: { recorded: true, attempted: 3, recovered: 1, userVisible: 1 },
      models: [],
      histogram: [],
    });

    expect(getShareImageFilename(card.date, 'friendly', 1)).toBe(
      'token-envy-2026-08-14-friendly-good.png',
    );
    expect(getShareImageFilename('../private/project', 'spicy', -20)).toBe(
      'token-envy-private-project-spicy-brutal.png',
    );

    const receipt = getShareTextReceipt(
      'friendly',
      1,
      card,
      'https://www.npmjs.com/package/tokenenvy',
    );
    expect(receipt).toContain('Token Envy daily receipt\n2026-08-14');
    expect(receipt).toContain(
      '3 refusal signals · 1 recovered · 1 user-visible · 1 unresolved · explicit lower bound',
    );
    expect(receipt).toContain('Measured locally. Prompts stay private.');
    expect(receipt).toContain('Measure yours · npx tokenenvy');
    expect(receipt).toContain('Built by Security Blueprints, LLC: securityblueprints.io');
  });
});
