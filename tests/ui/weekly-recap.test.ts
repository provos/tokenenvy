import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import WeeklyRecapModal from '../../src/lib/components/WeeklyRecapModal.svelte';
import {
  DASHBOARD_SHARE_CTA,
  safeWeeklyRecapProductLink,
  suggestedWeeklySentiment,
  weeklyRecapCaption,
  weeklyRecapDayIndex,
  weeklyRecapFailureLine,
  weeklyRecapFailureStamp,
  weeklyRecapHeadline,
  weeklyRecapImageFilename,
  weeklyRecapComparisonLine,
  weeklyRecapObservedDayIndices,
  weeklyRecapPeriod,
  weeklyRecapReady,
  weeklyRecapRefusalLine,
  weeklyRecapRefusalNote,
  weeklyRecapSentimentDescription,
  weeklyRecapTextReceipt,
  type WeeklyRecapData,
} from '../../src/lib/components/weekly-recap';
import { weeklyRecapFixture } from './weekly-recap-fixture';

const recap = weeklyRecapFixture;

describe('weekly Token Envy recap', () => {
  it('uses the personal 28-day baseline without claiming a weekly percentile', () => {
    expect(weeklyRecapHeadline(recap)).toBe('Claude behaved this week');
    expect(weeklyRecapComparisonLine(recap)).toBe('8% faster than my prior 28 days');
    expect(weeklyRecapComparisonLine(recap)).not.toContain('percentile');
    expect(weeklyRecapComparisonLine(recap)).not.toContain('Speed Index');
    expect(weeklyRecapPeriod(recap)).toMatch(/Aug 8, 2026 to Aug 14, 2026/);
    expect(weeklyRecapReady(recap)).toBe(true);
    expect(suggestedWeeklySentiment(recap)).toBe(1);

    const caption = weeklyRecapCaption(
      recap,
      'friendly',
      1,
      'https://www.npmjs.com/package/tokenenvy',
    );
    expect(caption).toContain('Claude behaved this week:');
    expect(caption).not.toContain('week so far');
    expect(caption).toContain('- 72 weekly median effective tok/s');
    expect(caption).toContain('- 8% faster than my prior 28 days');
    expect(caption).toContain('- 84 measured requests');
    expect(caption).toContain('- No explicit refusal signals this week · lower bound');
    expect(caption).toContain('Measure your week: npx tokenenvy');
    expect(caption).toContain('Runs locally. Prompts stay private.');
    expect(caption).not.toContain('#TokenEnvy');
    expect(caption).not.toContain('Security Blueprints');
    expect(caption).not.toContain('No API failures');
    expect(caption).not.toContain('93');
  });

  it('gives every weekly mood a distinct friendly and spicy headline', () => {
    const sentiments = [-2, -1, 0, 1, 2] as const;
    expect(
      sentiments.map((sentiment) => weeklyRecapHeadline(recap, 'friendly', sentiment)),
    ).toEqual([
      'Claude fought me all week',
      'Claude Code kept me waiting this week',
      'Claude held steady this week',
      'Claude behaved this week',
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
      '- 1 explicit refusal signal: 1 recovered · lower bound',
    );
    const xCaption = weeklyRecapCaption(withRefusal, 'spicy', -1, null, 'x');
    expect(xCaption.startsWith('Anthropic made me earn every token this week.')).toBe(true);
    expect(xCaption).toContain('1 refusal · 1 recovered · lower bound');
    expect(xCaption).toContain('prompts stay private');
    expect(xCaption).not.toContain('#TokenEnvy');
    expect(xCaption.length).toBeLessThanOrEqual(250);

    const blueskyCaption = weeklyRecapCaption(
      withRefusal,
      'spicy',
      -1,
      'https://www.npmjs.com/package/tokenenvy',
      'bluesky',
    );
    expect(blueskyCaption.startsWith('Anthropic made me earn every token this week.')).toBe(true);
    expect(blueskyCaption).toContain('1 explicit refusal signal: 1 recovered · lower bound');
    expect(blueskyCaption).toContain('https://www.npmjs.com/package/tokenenvy');
    expect(blueskyCaption).not.toContain('#TokenEnvy');
    expect(blueskyCaption.length).toBeLessThanOrEqual(300);
    expect(weeklyRecapImageFilename(withRefusal, 'spicy', -1)).toBe(
      'token-envy-week-2026-08-14-spicy-rough.png',
    );
    const receipt = weeklyRecapTextReceipt(withRefusal, 'spicy', -1);
    expect(receipt).toContain('- 1 explicit refusal signal: 1 recovered · lower bound');
    expect(receipt).toContain('- No API failures recorded this week');
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

    expect(normalized).toContain('Token Envy · Last 7 days');
    expect(normalized).toContain('weekly median effective output · tok/s');
    expect(normalized).toContain('Fastest observed day');
    expect(normalized).toContain('Slowest observed day');
    expect(normalized).toContain('91 effective tok/s');
    expect(normalized).toContain('54 effective tok/s');
    expect(normalized).toContain('Measure your week: npx tokenenvy');
    expect(normalized).toContain('A Security Blueprints, LLC project · securityblueprints.io');
    expect(normalized).toContain(
      'The card freezes your last seven days and compares them with your own history.',
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

  it('places activity chronologically when the rolling window crosses Sunday', () => {
    const sparse: WeeklyRecapData = {
      ...recap,
      startDate: '2026-08-13',
      throughDate: '2026-08-19',
      daysObserved: 2,
      observedDates: ['2026-08-14', '2026-08-17'],
      fastestDay: { date: '2026-08-17', median: 91 },
      slowestDay: { date: '2026-08-14', median: 54 },
    };
    expect([...weeklyRecapObservedDayIndices(sparse)]).toEqual([1, 4]);
    expect(weeklyRecapDayIndex(sparse, '2026-08-12')).toBeNull();
    expect(weeklyRecapDayIndex(sparse, '2026-08-20')).toBeNull();
    expect(
      weeklyRecapDayIndex(
        { ...sparse, startDate: '2026-02-27', throughDate: '2026-03-05' },
        '2026-02-31',
      ),
    ).toBeNull();

    const { body } = render(WeeklyRecapModal, {
      props: { open: true, recap: sparse, outputTokens: 4_200, onclose: () => undefined },
    });
    expect(body).toContain('data-day-index="0" data-observed="false"');
    expect(body).toContain('data-day-index="1" data-observed="true"');
    expect(body).toContain('data-day-index="4" data-observed="true"');
  });
  it('reports platform failures on their own axis, more gently than refusals', () => {
    const withFailures: WeeklyRecapData = {
      ...recap,
      failures: {
        recorded: true,
        attempted: 2,
        overloaded: 2,
        serverError: 0,
        affectedDates: [{ date: '2026-08-13', attempted: 2, overloaded: 2, serverError: 0 }],
      },
    };

    expect(weeklyRecapFailureStamp(withFailures)).toBe('2 API failures');
    expect(weeklyRecapFailureLine(withFailures)).toBe('2 API failures: 2 overloaded');
    expect(suggestedWeeklySentiment(withFailures)).toBe(0);
    expect(weeklyRecapSentimentDescription(withFailures)).toBe(
      'My prior 28 days suggested Good. 2 API failures that never completed moved it to Neutral. Pick the mood; the numbers stay put.',
    );
    // The refusal axis is untouched and nothing is summed across the two.
    expect(weeklyRecapRefusalLine(withFailures)).toBe('No explicit refusal signals this week');

    const caption = weeklyRecapCaption(withFailures, 'friendly', 0, null);
    expect(caption).toContain('Claude held steady this week, failed calls and all:');
    expect(caption).toContain('- 2 API failures: 2 overloaded');
    expect(weeklyRecapTextReceipt(withFailures, 'friendly', 0)).toContain(
      '- 2 API failures: 2 overloaded',
    );
    const xCaption = weeklyRecapCaption(withFailures, 'friendly', 0, null, 'x');
    expect(xCaption).toContain('2 API failures');
    expect(xCaption).not.toContain('the service could not complete');
    expect(xCaption.length).toBeLessThanOrEqual(250);
  });

  it('caps a sustained weekly outage at Neutral and never at Brutal', () => {
    const sustained: WeeklyRecapData = {
      ...recap,
      failures: {
        recorded: true,
        attempted: 10,
        overloaded: 7,
        serverError: 3,
        affectedDates: [{ date: '2026-08-13', attempted: 10, overloaded: 7, serverError: 3 }],
      },
    };
    expect(suggestedWeeklySentiment(sustained)).toBe(0);
    expect(weeklyRecapFailureStamp(sustained)).toBe('10 API failures');

    const alsoRefused: WeeklyRecapData = {
      ...sustained,
      refusals: {
        recorded: true,
        attempted: 2,
        recovered: 0,
        userVisible: 2,
        unknown: 0,
        affectedDates: [
          { date: '2026-08-13', attempted: 2, recovered: 0, userVisible: 2, unknown: 0 },
        ],
      },
    };
    // Refusals already chose Brutal; the outage cannot push past it or lift it.
    expect(suggestedWeeklySentiment(alsoRefused)).toBe(-2);
    expect(weeklyRecapSentimentDescription(alsoRefused)).toBe(
      'My prior 28 days suggested Good. 2 user-visible refusal signals moved it to Brutal. 10 API failures that never completed kept it at Brutal. Pick the mood; the numbers stay put.',
    );
  });

  it('keeps the weekly card clean when the service held up', () => {
    expect(weeklyRecapFailureStamp(recap)).toBe('');
    expect(weeklyRecapFailureLine(recap)).toBe('');
    expect(suggestedWeeklySentiment(recap)).toBe(1);

    const quiet = render(WeeklyRecapModal, {
      props: { open: true, recap, outputTokens: 25_000, onclose: () => undefined },
    });
    expect(quiet.body).not.toContain('share-failure-stamp');
    expect(quiet.body).not.toContain('API failure');

    const stormy = render(WeeklyRecapModal, {
      props: {
        open: true,
        recap: {
          ...recap,
          failures: {
            recorded: true,
            attempted: 10,
            overloaded: 7,
            serverError: 3,
            affectedDates: [{ date: '2026-08-13', attempted: 10, overloaded: 7, serverError: 3 }],
          },
        },
        outputTokens: 25_000,
        onclose: () => undefined,
      },
    });
    expect(stormy.body).toContain('class="share-failure-stamp"');
    expect(stormy.body.replace(/\s+/g, ' ')).toContain('10 API failures');
  });

  it('produces a human, scannable full-week receipt', () => {
    const example: WeeklyRecapData = {
      ...recap,
      startDate: '2026-08-10',
      throughDate: '2026-08-16',
      median: 68,
      requestCount: 17_246,
      speedIndex: { ...recap.speedIndex, value: 110 },
      failures: {
        recorded: true,
        attempted: 13,
        overloaded: 10,
        serverError: 3,
        affectedDates: [],
      },
    };

    expect(
      weeklyRecapTextReceipt(example, 'friendly', 1, 'https://www.npmjs.com/package/tokenenvy'),
    ).toBe(`Claude behaved this week, failed calls and all:

- 68 weekly median effective tok/s
- 10% faster than my prior 28 days
- 17,246 measured requests
- No explicit refusal signals this week · lower bound
- 13 API failures: 10 overloaded · 3 server faults

Measure your week: npx tokenenvy
Runs locally. Prompts stay private.

https://www.npmjs.com/package/tokenenvy`);

    const linkedin = weeklyRecapCaption(
      example,
      'friendly',
      1,
      'https://www.npmjs.com/package/tokenenvy',
      'linkedin',
    );
    expect(linkedin).toContain('How did your week compare?\nMeasure your week: npx tokenenvy');

    const x = weeklyRecapCaption(example, 'friendly', 1, null, 'x');
    expect(x).toContain('68 median effective tok/s · 10% faster than my prior 28 days');
    expect(x).toContain('17.2K requests');
    expect(x).toContain('0 explicit refusal signals · lower bound');
    expect(x).toContain('13 API failures');
    expect(x).toContain('Run yours: npx tokenenvy · prompts stay private');
    expect(x.length).toBeLessThanOrEqual(250);

    const bluesky = weeklyRecapCaption(
      example,
      'friendly',
      1,
      'https://www.npmjs.com/package/tokenenvy',
      'bluesky',
    );
    expect(bluesky).toContain('13 API failures: 10 overloaded · 3 server faults');
    expect(bluesky).toContain('https://www.npmjs.com/package/tokenenvy');
    expect(bluesky.length).toBeLessThanOrEqual(300);
  });

  it('uses plain baseline states in shared text', () => {
    expect(
      weeklyRecapComparisonLine({
        ...recap,
        speedIndex: { ...recap.speedIndex, value: 100 },
      }),
    ).toBe('Matched my prior 28 days');
    expect(
      weeklyRecapComparisonLine({
        ...recap,
        speedIndex: { ...recap.speedIndex, eligible: false, value: null },
      }),
    ).toBe('My 28-day baseline is still building');
  });

  it('keeps every voice and mood within social limits without dropping the core result', () => {
    const crowded: WeeklyRecapData = {
      ...recap,
      requestCount: 987_654_321,
      median: 123_456,
      refusals: {
        recorded: true,
        attempted: 999,
        recovered: 333,
        userVisible: 333,
        unknown: 333,
        affectedDates: [],
      },
      failures: {
        recorded: true,
        attempted: 999,
        overloaded: 666,
        serverError: 333,
        affectedDates: [],
      },
    };

    for (const tone of ['friendly', 'spicy'] as const) {
      for (const sentiment of [-2, -1, 0, 1, 2] as const) {
        const x = weeklyRecapCaption(crowded, tone, sentiment, null, 'x');
        expect(x.length).toBeLessThanOrEqual(250);
        expect(x).toContain('123.5K median effective tok/s');
        expect(x).toContain('lower bound');
        expect(x).toContain('npx tokenenvy');

        const bluesky = weeklyRecapCaption(
          crowded,
          tone,
          sentiment,
          'https://www.npmjs.com/package/tokenenvy',
          'bluesky',
        );
        expect(bluesky.length).toBeLessThanOrEqual(300);
        expect(bluesky).toContain('123.5K median effective tok/s');
        expect(bluesky).toContain('lower bound');
        expect(bluesky).toContain('https://www.npmjs.com/package/tokenenvy');
      }
    }

    const longUrl = `https://example.com/${'share/'.repeat(80)}`;
    const bounded = weeklyRecapCaption(crowded, 'spicy', -2, longUrl, 'bluesky');
    expect(bounded.length).toBeLessThanOrEqual(300);
    expect(bounded).not.toContain(longUrl);
    expect(bounded).toContain('123.5K median effective tok/s');
  });
});
