import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import WeeklyRecapModal from '../../src/lib/components/WeeklyRecapModal.svelte';
import {
  DASHBOARD_SHARE_CTA,
  safeWeeklyRecapProductLink,
  suggestedWeeklySentiment,
  weeklyRecapCaption,
  weeklyRecapHeadline,
  weeklyRecapImageFilename,
  weeklyRecapIndexLine,
  weeklyRecapObservedWeekdays,
  weeklyRecapPeriod,
  weeklyRecapReady,
  weeklyRecapRefusalLine,
  weeklyRecapRefusalNote,
  weeklyRecapSentimentDescription,
  weeklyRecapTextReceipt,
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
  refusals: {
    recorded: true,
    attempted: 0,
    recovered: 0,
    userVisible: 0,
    unknown: 0,
    affectedDates: [],
  },
};

describe('weekly Token Envy recap', () => {
  it('uses the personal 28-day baseline without claiming a weekly percentile', () => {
    expect(weeklyRecapHeadline(recap)).toBe('Claude Code kept me moving this week');
    expect(weeklyRecapIndexLine(recap)).toBe('Speed Index 108 · 8% faster than my prior 28 days');
    expect(weeklyRecapIndexLine(recap)).not.toContain('percentile');
    expect(weeklyRecapPeriod(recap)).toMatch(/Aug 10, 2026 to Aug 14, 2026/);
    expect(weeklyRecapReady(recap)).toBe(true);
    expect(suggestedWeeklySentiment(recap)).toBe(1);

    const caption = weeklyRecapCaption(
      recap,
      'friendly',
      1,
      'https://www.npmjs.com/package/tokenenvy',
    );
    expect(caption).toContain('How did Claude Code treat you this week?');
    expect(caption).toContain(
      'No explicit refusal signals this week. Explicit signals only · lower bound.',
    );
    expect(caption).toContain('#TokenEnvy');
    expect(caption).toContain('Built by Security Blueprints, LLC: securityblueprints.io');
    expect(caption).not.toContain('93');
  });

  it('gives every weekly mood a distinct friendly and spicy headline', () => {
    const sentiments = [-2, -1, 0, 1, 2] as const;
    expect(
      sentiments.map((sentiment) => weeklyRecapHeadline(recap, 'friendly', sentiment)),
    ).toEqual([
      'Claude Code made this a long week',
      'Claude Code kept me waiting this week',
      'Claude Code kept a steady pace this week',
      'Claude Code kept me moving this week',
      'Claude Code flew all week',
    ]);
    expect(sentiments.map((sentiment) => weeklyRecapHeadline(recap, 'spicy', sentiment))).toEqual([
      'Anthropic hated me this week',
      'Anthropic made me earn every token this week',
      'Anthropic and I called it even this week',
      'Anthropic was feeling generous this week',
      'Anthropic loved me this week',
    ]);
  });

  it('applies the shared refusal policy to the weekly performance mood', () => {
    const withRefusal = {
      ...recap,
      refusals: {
        recorded: true,
        attempted: 1,
        recovered: 1,
        userVisible: 0,
        unknown: 0,
        affectedDates: [
          {
            date: '2026-08-13',
            attempted: 1,
            recovered: 1,
            userVisible: 0,
            unknown: 0,
          },
        ],
      },
    };
    expect(suggestedWeeklySentiment(withRefusal)).toBe(0);
    expect(weeklyRecapSentimentDescription(withRefusal)).toBe(
      'My prior 28 days suggested Good. 1 recovered refusal signal moved it to Neutral. Pick the mood; the numbers stay put.',
    );
    expect(weeklyRecapRefusalLine(withRefusal)).toBe('1 refusal signal · 1 recovered');
    expect(weeklyRecapRefusalNote(withRefusal)).toBe('Explicit signals only · lower bound');
    expect(weeklyRecapCaption(withRefusal, 'spicy', -1, null)).toContain(
      '1 refusal signal · 1 recovered. Explicit signals only · lower bound.',
    );
    const xCaption = weeklyRecapCaption(withRefusal, 'spicy', -1, null, 'x');
    expect(xCaption.startsWith('Anthropic made me earn every token this week.')).toBe(true);
    expect(xCaption).toContain('1 refusal signal: 1 recovered; lower bound.');
    expect(xCaption).toContain('Local stats; prompts private.');
    expect(xCaption).toContain('#TokenEnvy · securityblueprints.io');
    expect(xCaption.length).toBeLessThanOrEqual(250);

    const blueskyCaption = weeklyRecapCaption(
      withRefusal,
      'spicy',
      -1,
      'https://www.npmjs.com/package/tokenenvy',
      'bluesky',
    );
    expect(blueskyCaption.startsWith('Anthropic made me earn every token this week.')).toBe(true);
    expect(blueskyCaption).toContain('1 refusal signal: 1 recovered; lower bound.');
    expect(blueskyCaption).toContain('#TokenEnvy · securityblueprints.io');
    expect(blueskyCaption.length).toBeLessThanOrEqual(300);
    expect(weeklyRecapImageFilename(withRefusal, 'spicy', -1)).toBe(
      'token-envy-week-2026-08-14-spicy-rough.png',
    );
    expect(weeklyRecapTextReceipt(withRefusal, 'spicy', -1)).toContain(
      'Explicit signals only · lower bound',
    );
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
    expect(normalized).toContain('weekly median effective output · tok/s');
    expect(normalized).toContain('Fastest observed day');
    expect(normalized).toContain('Slowest observed day');
    expect(normalized).toContain('91 effective tok/s');
    expect(normalized).toContain('54 effective tok/s');
    expect(normalized).toContain('Measure your week · npx tokenenvy');
    expect(normalized).toContain('A Security Blueprints, LLC project · securityblueprints.io');
    expect(normalized).toContain(
      'The card freezes this week and compares it with your own history.',
    );
    expect(normalized).toContain('Prompts stayed local');
  });

  it('keeps the dashboard call to action direct and contextual', () => {
    expect(DASHBOARD_SHARE_CTA).toEqual({
      eyebrow: 'Your private speed receipt',
      title: 'Claude Code feels slow? Bring receipts.',
      body: 'Post today’s number or your week. Then ask how Claude treated everyone else.',
      note: 'Prompts stay on this device. Model mix, output length, and workload shape effective TPS.',
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
