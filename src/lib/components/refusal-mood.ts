import type { LongitudinalSummary, RefusalCounts } from '$lib/types';
import type { ShareSentiment } from './share';

export interface RefusalMoodCounts {
  recorded: boolean;
  attempted: number;
  recovered: number;
  userVisible: number;
  unknown?: number;
}

export type RefusalMoodReason =
  | 'unavailable'
  | 'none-observed'
  | 'recovered'
  | 'unresolved'
  | 'user-visible'
  | 'repeated-user-visible';

export interface RefusalMoodAdjustment {
  base: ShareSentiment;
  suggested: ShareSentiment;
  stepsLowered: number;
  reason: RefusalMoodReason;
  counts: RefusalCounts;
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function sentiment(value: number): ShareSentiment {
  return Math.max(-2, Math.min(2, Math.round(value))) as ShareSentiment;
}

function normalizedCounts(input: RefusalMoodCounts): RefusalCounts {
  const attempted = nonNegativeInteger(input.attempted);
  const userVisible = Math.min(attempted, nonNegativeInteger(input.userVisible));
  const recovered = Math.min(attempted - userVisible, nonNegativeInteger(input.recovered));
  // Attempted is the authoritative total, so any remaining outcomes are unknown.
  const unknown = attempted - userVisible - recovered;
  return { attempted, recovered, userVisible, unknown };
}

/**
 * Adjusts presentation mood only. It must never alter performance measurements.
 * Positive refusal evidence lowers the suggestion; unavailable or absent evidence
 * never improves it.
 */
export function adjustSentimentForRefusals(
  baseInput: ShareSentiment,
  input: RefusalMoodCounts,
): RefusalMoodAdjustment {
  const base = sentiment(baseInput);
  const counts = normalizedCounts(input);
  let suggested = base;
  let reason: RefusalMoodReason = input.recorded ? 'none-observed' : 'unavailable';

  if (input.recorded && counts.attempted > 0) {
    if (counts.userVisible >= 2) {
      suggested = -2;
      reason = 'repeated-user-visible';
    } else if (counts.userVisible > 0) {
      suggested = sentiment(Math.min(base - 2, -1));
      reason = 'user-visible';
    } else if (counts.unknown > 0) {
      suggested = sentiment(Math.min(base - 1, 0));
      reason = 'unresolved';
    } else {
      suggested = sentiment(base - 1);
      reason = 'recovered';
    }
  }

  return {
    base,
    suggested,
    stepsLowered: base - suggested,
    reason,
    counts,
  };
}

/** Counts only refusals attributed to the card's selected model families. */
export function selectedLongitudinalRefusalCounts(summary: LongitudinalSummary): RefusalMoodCounts {
  const counts = summary.refusals.reduce<RefusalCounts>(
    (total, day) => ({
      attempted: total.attempted + day.selected.attempted,
      recovered: total.recovered + day.selected.recovered,
      userVisible: total.userVisible + day.selected.userVisible,
      unknown: total.unknown + day.selected.unknown,
    }),
    { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 },
  );
  return { recorded: summary.refusalsRecorded, ...counts };
}
