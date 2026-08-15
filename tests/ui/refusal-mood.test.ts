import { describe, expect, it } from 'vitest';
import { adjustSentimentForRefusals } from '../../src/lib/components/refusal-mood';

const counts = (
  attempted: number,
  recovered: number,
  userVisible: number,
  unknown = attempted - recovered - userVisible,
) => ({ recorded: true, attempted, recovered, userVisible, unknown });

describe('refusal-aware mood policy', () => {
  it('does not treat unavailable or absent signals as positive evidence', () => {
    expect(
      adjustSentimentForRefusals(1, {
        recorded: false,
        attempted: 0,
        recovered: 0,
        userVisible: 0,
        unknown: 0,
      }),
    ).toMatchObject({ suggested: 1, reason: 'unavailable', stepsLowered: 0 });
    expect(adjustSentimentForRefusals(1, counts(0, 0, 0))).toMatchObject({
      suggested: 1,
      reason: 'none-observed',
      stepsLowered: 0,
    });
  });

  it('lowers recovered-only attempts one stop', () => {
    expect(adjustSentimentForRefusals(2, counts(1, 1, 0))).toMatchObject({
      suggested: 1,
      reason: 'recovered',
      stepsLowered: 1,
    });
    expect(adjustSentimentForRefusals(-2, counts(4, 4, 0)).suggested).toBe(-2);
  });

  it('lowers unresolved attempts one stop and caps them at Neutral', () => {
    expect(adjustSentimentForRefusals(2, counts(1, 0, 0))).toMatchObject({
      suggested: 0,
      reason: 'unresolved',
      stepsLowered: 2,
    });
    expect(adjustSentimentForRefusals(0, counts(1, 0, 0)).suggested).toBe(-1);
  });

  it('lowers one user-visible refusal two stops and caps it at Rough', () => {
    expect(adjustSentimentForRefusals(2, counts(1, 0, 1))).toMatchObject({
      suggested: -1,
      reason: 'user-visible',
      stepsLowered: 3,
    });
    expect(adjustSentimentForRefusals(1, counts(1, 0, 1)).suggested).toBe(-1);
    expect(adjustSentimentForRefusals(0, counts(1, 0, 1)).suggested).toBe(-2);
  });

  it('selects Brutal for two or more user-visible refusals', () => {
    expect(adjustSentimentForRefusals(2, counts(2, 0, 2))).toMatchObject({
      suggested: -2,
      reason: 'repeated-user-visible',
      stepsLowered: 4,
    });
  });
});
