import { describe, expect, it } from 'vitest';
import { normalizeModelFamily, outputSizeStratum } from '../../src/lib/core/model';
import { clusteredMedianInterval, quantile, summarize } from '../../src/lib/core/statistics';

describe('model normalization', () => {
  it.each([
    ['claude-opus-4-1-20250805', 'opus'],
    ['opus', 'opus'],
    ['OPUSPLAN', 'opus'],
    ['claude-3-7-sonnet-20250219', 'sonnet'],
    ['claude-haiku-4-5', 'haiku'],
    ['claude-fable-1', 'fable'],
    ['future-bard', 'other'],
    [null, 'other']
  ])('maps %j to %s', (model, family) => {
    expect(normalizeModelFamily(model)).toBe(family);
  });

  it('uses fixed output size strata', () => {
    expect([1, 64, 65, 256, 257, 1024, 1025].map(outputSizeStratum)).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
});

describe('robust summaries', () => {
  it('uses interpolated quantiles and gates the clustered interval', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(summarize([{ value: 10, sessionId: 'a' }]).ciLow).toBeNull();
    const samples = Array.from({ length: 25 }, (_, index) => ({
      value: index + 1,
      sessionId: `session-${index % 5}`
    }));
    const first = clusteredMedianInterval(samples);
    expect(first).not.toBeNull();
    expect(clusteredMedianInterval(samples)).toEqual(first);
    expect(first?.[0]).toBeLessThanOrEqual(13);
    expect(first?.[1]).toBeGreaterThanOrEqual(13);
  });
});
