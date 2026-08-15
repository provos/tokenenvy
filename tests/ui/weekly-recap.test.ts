import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import WeeklyRecapModal from '../../src/lib/components/WeeklyRecapModal.svelte';
import {
  DASHBOARD_SHARE_CTA,
  safeWeeklyRecapProductLink,
  weeklyRecapCaption,
  weeklyRecapHeadline,
  weeklyRecapIndexLine,
  weeklyRecapObservedWeekdays,
  weeklyRecapPeriod,
  weeklyRecapReady,
  type WeeklyRecapData,
} from '../../src/lib/components/weekly-recap';

const recap: WeeklyRecapData = {
  weekStart: '2026-08-10',
  throughDate: '2026-08-14',
  daysObserved: 4,
  observedDates: ['2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14'],
  requestCount: 84,
  sessions: 12,
  median: 72,
  speedIndex: {
    value: 108,
    ciLow: 102,
    ciHigh: 114,
    percentile: 93,
    eligible: true,
    reason: null,
  },
  models: [
    {
      family: 'sonnet',
      requestCount: 60,
      outputTokens: 18_000,
      share: 0.72,
    },
  ],
  fastestDay: { date: '2026-08-13', median: 91 },
  slowestDay: { date: '2026-08-11', median: 54 },
};

describe('weekly Token Envy recap', () => {
  it('uses the personal 28-day baseline without claiming a weekly percentile', () => {
    expect(weeklyRecapHeadline(recap)).toBe('Claude Code had a fast week');
    expect(weeklyRecapIndexLine(recap)).toBe('Speed Index 108 · vs my prior 28 days');
    expect(weeklyRecapIndexLine(recap)).not.toContain('percentile');
    expect(weeklyRecapPeriod(recap)).toMatch(/Aug 10, 2026 to Aug 14, 2026/);
    expect(weeklyRecapReady(recap)).toBe(true);

    const caption = weeklyRecapCaption(recap, 'https://www.npmjs.com/package/tokenenvy');
    expect(caption).toContain('How did your week compare with your own baseline?');
    expect(caption).toContain('#TokenEnvy');
    expect(caption).toContain('Built by Security Blueprints, LLC: securityblueprints.io');
    expect(caption).not.toContain('93');
  });

  it('renders a separate privacy-safe weekly artifact with clear raw standout labels', () => {
    const { body } = render(WeeklyRecapModal, {
      props: {
        open: true,
        recap,
        outputTokens: 25_000,
        onclose: () => undefined,
      },
    });
    const normalized = body.replace(/\s+/g, ' ');

    expect(normalized).toContain('Token Envy · Week so far');
    expect(normalized).toContain('weekly median effective output tokens / second');
    expect(normalized).toContain('Fastest observed day');
    expect(normalized).toContain('Slowest observed day');
    expect(normalized).toContain('91 effective tok/s');
    expect(normalized).toContain('54 effective tok/s');
    expect(normalized).toContain('Run your week · npx tokenenvy');
    expect(normalized).toContain('A Security Blueprints, LLC project · securityblueprints.io');
    expect(normalized).toContain(
      'Each Speed Index compares one person with their own local history.',
    );
    expect(normalized).toContain('Prompts stayed local');
  });

  it('keeps the dashboard call to action direct and contextual', () => {
    expect(DASHBOARD_SHARE_CTA).toEqual({
      eyebrow: 'Your private speed receipt',
      title: 'Claude Code feels slow? Bring receipts.',
      body: 'Share this day or recap your week. Ask friends to bring their own receipts.',
      note: 'Your prompts stay on this device. Model mix, output length, and workload shape effective TPS.',
    });
  });

  it('accepts only safe HTTPS product links', () => {
    expect(safeWeeklyRecapProductLink('https://www.npmjs.com/package/tokenenvy')).toMatchObject({
      href: 'https://www.npmjs.com/package/tokenenvy',
    });
    expect(safeWeeklyRecapProductLink('http://example.com')).toBeNull();
    expect(safeWeeklyRecapProductLink('https://user:secret@example.com')).toBeNull();
  });

  it('places sparse activity on its actual weekdays', () => {
    const sparse = {
      ...recap,
      daysObserved: 2,
      observedDates: ['2026-08-10', '2026-08-14'],
    };
    expect([...weeklyRecapObservedWeekdays(sparse)]).toEqual([0, 4]);

    const { body } = render(WeeklyRecapModal, {
      props: { open: true, recap: sparse, outputTokens: 4_200, onclose: () => undefined },
    });
    expect(body).toContain('data-weekday="1" data-observed="true"');
    expect(body).toContain('data-weekday="2" data-observed="false"');
    expect(body).toContain('data-weekday="5" data-observed="true"');
  });
});
