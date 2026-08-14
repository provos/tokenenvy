import { describe, expect, it } from 'vitest';
import type { DailyPoint } from '../../src/lib/types';
import { areaPath, chartMaximum, dayLabel, linePath } from '../../src/lib/components/chart';
import {
  buildShareCardData,
  getShareTagline,
  safeShareProductLink,
  shareTrendPath
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
  it('accepts only credential-free HTTP(S) product links', () => {
    expect(safeShareProductLink('https://example.com/speedometer/')).toEqual({
      href: 'https://example.com/speedometer/',
      label: 'example.com/speedometer'
    });
    expect(safeShareProductLink('javascript:alert(1)')).toBeNull();
    expect(safeShareProductLink('https://user:secret@example.com')).toBeNull();
    expect(safeShareProductLink(undefined)).toBeNull();
  });

  it('allowlists fields, sorts output mix, and bounds the trend to fourteen days', () => {
    const privateMarker = 'PRIVATE_CANARY_DO_NOT_SHARE';
    const card = buildShareCardData({
      date: '2026-08-14',
      median: 70,
      count: 30,
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
      points: Array.from({ length: 18 }, (_, index) => ({
        ...points[0],
        date: `2026-07-${String(index + 15).padStart(2, '0')}`,
        median: 40 + index,
        privateMarker
      })) as never
    });

    expect(card.indexLabel).toBe('+12% vs 28-day mix-adjusted baseline');
    expect(card.models.map(({ family }) => family)).toEqual(['opus', 'sonnet']);
    expect(new Set(card.trend.map(({ date }) => date))).toHaveLength(14);
    expect(JSON.stringify(card)).not.toContain(privateMarker);
    expect(getShareTagline('spicy', card)).toBe('Anthropic loves me today');
    expect(shareTrendPath(card.trend, 'sonnet', 320, 54)).not.toContain('NaN');
  });
});
