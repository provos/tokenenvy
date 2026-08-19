import { describe, expect, it } from 'vitest';
import {
  adjustSentimentForFailures,
  sumFailureCounts,
} from '../../src/lib/components/failure-mood';
import { SHARE_SENTIMENTS, type ShareSentiment } from '../../src/lib/components/share';

const counts = (
  attempted: number,
  overloaded = attempted,
  serverError = attempted - overloaded,
) => ({
  recorded: true,
  attempted,
  overloaded,
  serverError,
});

describe('failure-aware mood policy', () => {
  it('does not treat unavailable or absent failures as evidence either way', () => {
    for (const base of SHARE_SENTIMENTS) {
      expect(
        adjustSentimentForFailures(base, {
          recorded: false,
          attempted: 0,
          overloaded: 0,
          serverError: 0,
        }),
      ).toMatchObject({ suggested: base, reason: 'unavailable', stepsLowered: 0 });
      expect(adjustSentimentForFailures(base, counts(0))).toMatchObject({
        suggested: base,
        reason: 'none-observed',
        stepsLowered: 0,
      });
    }
  });

  it('lowers an isolated outage one stop and keeps it off the top mood', () => {
    expect(adjustSentimentForFailures(2, counts(1))).toMatchObject({
      suggested: 1,
      reason: 'isolated',
      stepsLowered: 1,
    });
    expect(adjustSentimentForFailures(2, counts(2))).toMatchObject({
      suggested: 1,
      reason: 'isolated',
    });
    expect(adjustSentimentForFailures(1, counts(2)).suggested).toBe(0);
    expect(adjustSentimentForFailures(0, counts(2)).suggested).toBe(-1);
  });

  it('caps a sustained outage at Neutral', () => {
    expect(adjustSentimentForFailures(2, counts(3))).toMatchObject({
      suggested: 0,
      reason: 'sustained',
      stepsLowered: 2,
    });
    expect(adjustSentimentForFailures(1, counts(10, 7, 3)).suggested).toBe(0);
    expect(adjustSentimentForFailures(0, counts(10, 7, 3)).suggested).toBe(-1);
  });

  it('treats the third attempt as the isolated-to-sustained boundary', () => {
    expect(adjustSentimentForFailures(2, counts(2)).reason).toBe('isolated');
    expect(adjustSentimentForFailures(2, counts(3)).reason).toBe('sustained');
    expect(adjustSentimentForFailures(2, counts(2)).suggested).toBe(1);
    expect(adjustSentimentForFailures(2, counts(3)).suggested).toBe(0);
  });

  it('treats a lone server fault as sustained, unlike a lone overload', () => {
    expect(adjustSentimentForFailures(2, counts(1, 1, 0))).toMatchObject({
      suggested: 1,
      reason: 'isolated',
    });
    expect(adjustSentimentForFailures(2, counts(1, 0, 1))).toMatchObject({
      suggested: 0,
      reason: 'sustained',
    });
  });

  it('never reaches Brutal on failures alone, however many there are', () => {
    const outages = [counts(1), counts(2), counts(3), counts(40, 20, 20), counts(500, 0, 500)];
    for (const base of SHARE_SENTIMENTS) {
      for (const outage of outages) {
        const { suggested } = adjustSentimentForFailures(base, outage);
        if (base > -2) expect(suggested).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  it('leaves a card that refusals already drove to Brutal at Brutal', () => {
    for (const outage of [counts(1), counts(3), counts(60, 30, 30)]) {
      expect(adjustSentimentForFailures(-2, outage).suggested).toBe(-2);
      expect(adjustSentimentForFailures(-2, outage).stepsLowered).toBe(0);
    }
  });

  it('never raises the mood it was handed', () => {
    const outages = [
      { recorded: false, attempted: 0, overloaded: 0, serverError: 0 },
      counts(0),
      counts(1),
      counts(2),
      counts(9, 6, 3),
    ];
    for (const base of SHARE_SENTIMENTS) {
      for (const outage of outages) {
        expect(adjustSentimentForFailures(base, outage).suggested).toBeLessThanOrEqual(base);
      }
    }
  });

  it('ignores counts that were never recorded and clamps impossible splits', () => {
    expect(
      adjustSentimentForFailures(2, {
        recorded: false,
        attempted: 12,
        overloaded: 12,
        serverError: 0,
      }),
    ).toMatchObject({ suggested: 2, reason: 'unavailable', counts: { attempted: 0 } });
    expect(
      adjustSentimentForFailures(2, {
        recorded: true,
        attempted: 2,
        overloaded: 5,
        serverError: 5,
      }).counts,
    ).toEqual({ attempted: 2, overloaded: 2, serverError: 0 });
  });

  it('sums a range of failure days without mixing in any other axis', () => {
    expect(
      sumFailureCounts([
        { date: '2026-08-10', attempted: 10, overloaded: 7, serverError: 3 },
        { date: '2026-08-14', attempted: 2, overloaded: 2, serverError: 0 },
      ]),
    ).toEqual({ attempted: 12, overloaded: 9, serverError: 3 });
    expect(sumFailureCounts([])).toEqual({ attempted: 0, overloaded: 0, serverError: 0 });
  });
});

describe('the two moods compose', () => {
  it('applies the gentler failure ladder on top of the refusal result', () => {
    // A refusal-driven Rough plus a sustained outage stays Rough, never Brutal.
    const sentiments: ShareSentiment[] = [-1, 0, 1, 2];
    for (const afterRefusals of sentiments) {
      const { suggested } = adjustSentimentForFailures(afterRefusals, counts(10, 7, 3));
      expect(suggested).toBeGreaterThanOrEqual(-1);
      expect(suggested).toBeLessThanOrEqual(Math.min(afterRefusals, 0));
    }
  });
});
