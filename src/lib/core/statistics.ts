import type { QuantileSummary } from '../types';

export interface MetricSample {
  value: number;
  sessionId: string;
}

function sortedQuantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upper = sorted[Math.min(sorted.length - 1, lower + 1)];
  return sorted[lower] + (upper - sorted[lower]) * fraction;
}

export function quantile(values: readonly number[], probability: number): number {
  return sortedQuantile([...values].sort((left, right) => left - right), probability);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Bootstrap requests by session, retaining within-session correlation. */
export function clusteredMedianInterval(
  samples: readonly MetricSample[],
  iterations = 500,
  seed = 0x5eed1234
): [number, number] | null {
  const groups = new Map<string, number[]>();
  for (const sample of samples) {
    const values = groups.get(sample.sessionId) ?? [];
    values.push(sample.value);
    groups.set(sample.sessionId, values);
  }
  if (samples.length < 20 || groups.size < 5) return null;

  const sessions = [...groups.values()];
  const random = seededRandom(seed);
  const medians: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resampled: number[] = [];
    for (let index = 0; index < sessions.length; index += 1) {
      const selected = sessions[Math.floor(random() * sessions.length)];
      resampled.push(...selected);
    }
    medians.push(quantile(resampled, 0.5));
  }
  return [quantile(medians, 0.025), quantile(medians, 0.975)];
}

export function summarize(samples: readonly MetricSample[]): QuantileSummary {
  const values = samples.map(({ value }) => value).sort((left, right) => left - right);
  const interval = clusteredMedianInterval(samples);
  return {
    count: samples.length,
    sessions: new Set(samples.map(({ sessionId }) => sessionId)).size,
    median: sortedQuantile(values, 0.5),
    q1: sortedQuantile(values, 0.25),
    q3: sortedQuantile(values, 0.75),
    p10: sortedQuantile(values, 0.1),
    p90: sortedQuantile(values, 0.9),
    ciLow: interval?.[0] ?? null,
    ciHigh: interval?.[1] ?? null
  };
}
