import type { DatedFailureCounts, FailureCounts, LongitudinalSummary } from '$lib/types';
import type { ShareFailureCounts, ShareSentiment } from './share';

export type FailureMoodReason = 'unavailable' | 'none-observed' | 'isolated' | 'sustained';

export interface FailureMoodAdjustment {
  /** The already refusal-adjusted mood this adjustment was applied to. */
  base: ShareSentiment;
  suggested: ShareSentiment;
  stepsLowered: number;
  reason: FailureMoodReason;
  counts: FailureCounts;
}

/**
 * Brutal is reserved for refusals. Being throttled by an outage is not the same
 * as being refused, so the failure contribution never reaches the bottom stop.
 */
const FAILURE_FLOOR: ShareSentiment = -1;
/** An isolated outage still cannot leave the card reading as the top mood. */
const ISOLATED_CEILING: ShareSentiment = 1;
/** A sustained outage pulls the card back to an even reading at best. */
const SUSTAINED_CEILING: ShareSentiment = 0;
/** Three attempts is where a stray retry stops being a coincidence. */
const SUSTAINED_ATTEMPTS = 3;

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function sentiment(value: number): ShareSentiment {
  return Math.max(-2, Math.min(2, Math.round(value))) as ShareSentiment;
}

function normalizedCounts(input: ShareFailureCounts): FailureCounts {
  const attempted = input.recorded ? nonNegativeInteger(input.attempted) : 0;
  const overloaded = Math.min(attempted, nonNegativeInteger(input.overloaded));
  const serverError = Math.min(attempted - overloaded, nonNegativeInteger(input.serverError));
  return { attempted, overloaded, serverError };
}

/**
 * Adjusts presentation mood only, and always more gently than refusals: a
 * failure says the service could not answer, not that the model would not.
 * The result is composed with `Math.min`, so the adjustment can only ever lower
 * the mood it was handed.
 */
export function adjustSentimentForFailures(
  baseInput: ShareSentiment,
  input: ShareFailureCounts,
): FailureMoodAdjustment {
  const base = sentiment(baseInput);
  const counts = normalizedCounts(input);
  const unchanged = {
    base,
    suggested: base,
    stepsLowered: 0,
    counts,
  };

  if (!input.recorded) return { ...unchanged, reason: 'unavailable' };
  if (counts.attempted === 0) return { ...unchanged, reason: 'none-observed' };

  // A single server fault counts as sustained: it is a heavier signal than a
  // retryable overload, so it does not get the isolated ceiling.
  const sustained = counts.attempted >= SUSTAINED_ATTEMPTS || counts.serverError > 0;
  const contribution = Math.max(
    FAILURE_FLOOR,
    Math.min(base - 1, sustained ? SUSTAINED_CEILING : ISOLATED_CEILING),
  );
  const suggested = sentiment(Math.min(base, contribution));

  return {
    base,
    suggested,
    stepsLowered: base - suggested,
    reason: sustained ? 'sustained' : 'isolated',
    counts,
  };
}

export function sumFailureCounts(days: readonly DatedFailureCounts[]): FailureCounts {
  return days.reduce<FailureCounts>(
    (total, day) => ({
      attempted: total.attempted + day.attempted,
      overloaded: total.overloaded + day.overloaded,
      serverError: total.serverError + day.serverError,
    }),
    { attempted: 0, overloaded: 0, serverError: 0 },
  );
}

/**
 * Failure events carry `model: "<synthetic>"`, so unlike refusals they are never
 * narrowed to the card's selected families: every failure in range counts.
 */
export function longitudinalFailureCounts(summary: LongitudinalSummary): ShareFailureCounts {
  return { recorded: summary.failuresRecorded, ...sumFailureCounts(summary.failures) };
}
