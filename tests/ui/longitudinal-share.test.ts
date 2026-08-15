import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import LongitudinalShareModal from '../../src/lib/components/LongitudinalShareModal.svelte';
import {
  longitudinalCaption,
  longitudinalFamilyLabel,
  longitudinalHeadline,
  longitudinalImageFilename,
  longitudinalMetricLabel,
  longitudinalRefusalLines,
  longitudinalSentimentDescription,
  longitudinalTrendLabel,
  suggestedLongitudinalSentiment,
} from '../../src/lib/components/longitudinal-share';
import { filterRefusalTimeline, refusalDayLabel } from '../../src/lib/components/chart';
import type { LongitudinalSummary, RefusalTimeline } from '../../src/lib/types';

const summary: LongitudinalSummary = {
  timezone: 'America/Los_Angeles',
  days: 90,
  startDate: '2026-05-17',
  throughDate: '2026-08-14',
  families: ['opus', 'sonnet'],
  observedDays: 61,
  measuredRequests: 8240,
  measuredOutputTokens: 23_400_000,
  qualifiedDays: 48,
  comparableRequestCoverage: 0.86,
  quality: 'robust',
  variationPct: 18.4,
  trendPct: 12.1,
  points: [
    { date: '2026-05-17', index: 92, requestCount: 42, coverage: 0.82 },
    { date: '2026-08-14', index: 108, requestCount: 55, coverage: 0.9 },
  ],
  refusalsRecorded: true,
  refusals: [
    {
      date: '2026-08-14',
      selected: { attempted: 3, recovered: 2, userVisible: 1, unknown: 0 },
      unattributed: { attempted: 2, recovered: 2, userVisible: 0, unknown: 0 },
    },
  ],
};

describe('longitudinal share helpers', () => {
  it('uses weather variation for a conservative automatic mood', () => {
    const withoutRefusals = { ...summary, refusals: [] };
    expect(suggestedLongitudinalSentiment(withoutRefusals)).toBe(1);
    expect(suggestedLongitudinalSentiment({ ...withoutRefusals, variationPct: 20 })).toBe(0);
    expect(suggestedLongitudinalSentiment({ ...withoutRefusals, variationPct: 30 })).toBe(0);
    expect(suggestedLongitudinalSentiment({ ...withoutRefusals, variationPct: 30.01 })).toBe(-1);
    expect(suggestedLongitudinalSentiment({ ...withoutRefusals, quality: 'insufficient' })).toBe(0);
  });

  it('lowers mood using selected-model refusals but excludes unattributed signals', () => {
    expect(suggestedLongitudinalSentiment(summary)).toBe(-1);
    expect(
      suggestedLongitudinalSentiment({
        ...summary,
        refusals: summary.refusals.map((day) => ({
          ...day,
          selected: { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
        })),
      }),
    ).toBe(1);
  });

  it('keeps all friendly and spicy five-stop headlines distinct', () => {
    const sentiments = [-2, -1, 0, 1, 2] as const;
    expect(sentiments.map((sentiment) => longitudinalHeadline('friendly', sentiment))).toEqual([
      'My Claude weather went sideways',
      'My Claude weather ran hot and cold',
      'My Claude weather kept shifting',
      'My Claude weather stayed calm',
      'My Claude weather stayed clear and calm',
    ]);
    expect(sentiments.map((sentiment) => longitudinalHeadline('spicy', sentiment))).toEqual([
      'Anthropic gave me four seasons in one chart',
      'Anthropic kept moving the thermostat',
      'Anthropic weather: check again in five minutes',
      'Anthropic kept it weirdly calm',
      'Anthropic finally found the thermostat',
    ]);
    expect(longitudinalSentimentDescription(summary)).toBe(
      'Adjusted variation suggested Good. 1 user-visible refusal signal moved it to Rough. Pick the mood; the numbers stay put.',
    );
    expect(longitudinalMetricLabel(summary)).toBe('typical adjusted swing from trend');
    expect(longitudinalTrendLabel(summary)).toBe(
      'Speed trended 12% higher across the measured span',
    );
  });

  it('describes lower-bound refusal signals without implying complete coverage', () => {
    expect(longitudinalRefusalLines(summary)).toEqual([
      '3 selected-model refusal signals · 2 recovered · 1 user-visible',
      '+2 without a model match · explicit lower bound',
    ]);
    expect(longitudinalRefusalLines({ ...summary, refusals: [] })).toEqual([
      'No explicit refusal signals in this range',
    ]);
    expect(longitudinalRefusalLines({ ...summary, refusalsRecorded: false })).toEqual([
      'Explicit refusal signals unavailable',
    ]);
  });

  it('keeps filenames, captions, and filter labels tied to the frozen view', () => {
    expect(longitudinalFamilyLabel(summary.families)).toBe('Opus + Sonnet');
    expect(longitudinalImageFilename(summary, 'spicy', -1)).toBe(
      'token-envy-weather-90d-spicy-rough.png',
    );
    expect(longitudinalCaption(summary, 'friendly', 1, null)).toContain(
      'How wild is your Claude weather?',
    );
    expect(longitudinalCaption(summary, 'friendly', 1, null)).toContain(
      'Built by Security Blueprints, LLC',
    );
    expect(longitudinalCaption(summary, 'friendly', 1, null)).toContain(
      '3 selected-model refusal signals · 2 recovered · 1 user-visible. +2 without a model match · explicit lower bound.',
    );
    const xCaption = longitudinalCaption(summary, 'spicy', -2, null, 'x');
    expect(xCaption.startsWith('Anthropic gave me four seasons in one chart.')).toBe(true);
    expect(xCaption).toContain(
      '3 selected refusals: 2 recovered/1 visible; +2 unmatched; lower bound.',
    );
    expect(xCaption).toContain('Local stats; prompts private.');
    expect(xCaption).toContain('#TokenEnvy · securityblueprints.io');
    expect(xCaption.length).toBeLessThanOrEqual(250);

    const blueskyCaption = longitudinalCaption(
      summary,
      'spicy',
      -2,
      'https://www.npmjs.com/package/tokenenvy',
      'bluesky',
    );
    expect(blueskyCaption.startsWith('Anthropic gave me four seasons in one chart.')).toBe(true);
    expect(blueskyCaption).toContain(
      '3 selected refusals: 2 recovered/1 visible; +2 unmatched; lower bound.',
    );
    expect(blueskyCaption).toContain('#TokenEnvy · securityblueprints.io');
    expect(blueskyCaption.length).toBeLessThanOrEqual(300);
  });
});

describe('filtered refusal timeline', () => {
  const timeline: RefusalTimeline = {
    recorded: true,
    days: [
      {
        date: '2026-08-14',
        families: [
          { family: 'sonnet', attempted: 2, recovered: 1, userVisible: 1, unknown: 0 },
          { family: 'opus', attempted: 4, recovered: 4, userVisible: 0, unknown: 0 },
        ],
        unattributed: { attempted: 1, recovered: 0, userVisible: 0, unknown: 1 },
      },
    ],
  };

  it('includes selected families and keeps unattributed signals separate', () => {
    const [day] = filterRefusalTimeline(timeline, ['sonnet']);
    expect(day.selected).toEqual({ attempted: 2, recovered: 1, userVisible: 1, unknown: 0 });
    expect(day.unattributed.attempted).toBe(1);
    expect(refusalDayLabel(day)).toContain('2 selected-model refusal signals');
    expect(refusalDayLabel(day)).toContain('1 signal without a model match');
  });
});

describe('longitudinal share dialog', () => {
  it('renders a separate frozen-view card with five moods and refusal warnings', () => {
    const { body } = render(LongitudinalShareModal, {
      props: { open: true, summary, onclose: () => undefined },
    });

    expect(body).toContain('Put your Claude weather on the map');
    expect(body).toContain('90-day · Opus + Sonnet');
    expect(body).toContain('longitudinal-share-chart');
    expect(body).toContain('3 selected-model refusal signals · 2 recovered · 1 user-visible');
    expect(body).toContain('Chart yours · npx tokenenvy');
    for (const label of ['Brutal', 'Rough', 'Neutral', 'Good', 'Glorious']) {
      expect(body).toContain(`>${label}</span>`);
    }
  });

  it('shows unavailable refusal coverage in the visual card without a warning marker', () => {
    const { body } = render(LongitudinalShareModal, {
      props: {
        open: true,
        summary: { ...summary, refusalsRecorded: false, refusals: [] },
        onclose: () => undefined,
      },
    });

    const refusalCopy = body.slice(
      body.indexOf('class="longitudinal-refusal-copy"'),
      body.indexOf('</footer>'),
    );
    expect(refusalCopy).toContain('<span>Explicit refusal signals unavailable</span>');
    expect(refusalCopy).not.toContain('▲');
  });
});
