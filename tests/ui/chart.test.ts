import { describe, expect, it } from 'vitest';
import type { DailyPoint } from '../../src/lib/types';
import { areaPath, chartMaximum, dayLabel, linePath } from '../../src/lib/components/chart';
import {
  buildShareCardData,
  getShareCaption,
  getShareMoodLine,
  getShareTagline,
  normalizeHistogram,
  safeShareProductLink,
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
});

describe('privacy-safe share-card data', () => {
  it('accepts only credential-free HTTPS product links', () => {
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
    expect(getShareTagline('spicy', card)).toBe('Anthropic loves me today');
    expect(getShareMoodLine(card)).toContain('88th percentile');
    expect(normalizeHistogram(card.histogram, card.median).some((bar) => bar.containsMedian)).toBe(true);
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

    expect(getShareTagline('friendly', card)).toBe('Claude Code found its rhythm that day');
    expect(getShareTagline('spicy', card)).toBe('Anthropic and I were on speaking terms');
    expect(getShareCaption('friendly', card, 'bluesky', 'https://tokenenvy.example/')).toContain(
      'https://tokenenvy.example/'
    );
    expect(getShareCaption('friendly', card, 'linkedin', 'https://tokenenvy.example/')).not.toContain(
      'https://tokenenvy.example/'
    );
  });
});
