import type {
  DailyPoint,
  DatedFailureCounts,
  LongitudinalRefusalDay,
  ModelFamily,
  RefusalCounts,
  RefusalTimeline,
  SpeedIndex,
} from '$lib/types';

export const FAMILY_COLORS: Record<ModelFamily, string> = {
  opus: '#ff7359',
  sonnet: '#f0bd68',
  fable: '#ad8cff',
  haiku: '#5fd6bd',
  other: '#8391a6',
};

export function dayLabel(value: string, _timezone = 'UTC'): string {
  void _timezone; // Calendar dates remain stable across the viewer's timezone.
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    // `value` is already a local calendar date. Formatting in UTC prevents
    // the label from moving a day in extreme positive or negative timezones.
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

export function chartTickIndices(dateCount: number, maximumLabels = 7): number[] {
  if (dateCount <= 0 || maximumLabels <= 0) return [];
  if (dateCount === 1 || maximumLabels === 1) return [dateCount - 1];
  const labelCount = Math.min(dateCount, maximumLabels);
  const last = dateCount - 1;
  return Array.from({ length: labelCount }, (_, index) =>
    Math.round((index * last) / (labelCount - 1)),
  );
}

export function chartTickLabel(
  date: string,
  today: string,
  timezone = 'UTC',
): { primary: string; secondary: string | null; accessible: string } {
  const calendarLabel = dayLabel(date, timezone);
  return date === today
    ? { primary: 'Today', secondary: calendarLabel, accessible: `Today, ${calendarLabel}` }
    : { primary: calendarLabel, secondary: null, accessible: calendarLabel };
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
  }).format(value);
}

function emptyRefusalCounts(): RefusalCounts {
  return { attempted: 0, recovered: 0, userVisible: 0, unknown: 0 };
}

function mergeRefusalCounts(target: RefusalCounts, source: RefusalCounts): void {
  target.attempted += source.attempted;
  target.recovered += source.recovered;
  target.userVisible += source.userVisible;
  target.unknown += source.unknown;
}

export function filterRefusalTimeline(
  timeline: RefusalTimeline,
  families: readonly ModelFamily[],
): LongitudinalRefusalDay[] {
  const selectedFamilies = new Set(families);
  return timeline.days.flatMap((day) => {
    const selected = emptyRefusalCounts();
    for (const family of day.families) {
      if (selectedFamilies.has(family.family)) mergeRefusalCounts(selected, family);
    }
    return selected.attempted > 0 || day.unattributed.attempted > 0
      ? [{ date: day.date, selected, unattributed: { ...day.unattributed } }]
      : [];
  });
}

export function refusalDayLabel(day: LongitudinalRefusalDay): string {
  const selected = day.selected;
  const selectedLabel =
    selected.attempted === 0
      ? 'No refusal signals for selected models'
      : `${selected.attempted} selected-model refusal ${selected.attempted === 1 ? 'signal' : 'signals'}: ${selected.recovered} recovered, ${selected.userVisible} user-visible, ${selected.unknown} unresolved`;
  const unattributed = day.unattributed.attempted;
  return unattributed > 0
    ? `${selectedLabel}. ${unattributed} ${unattributed === 1 ? 'signal' : 'signals'} without a model match. Explicit signals only; lower bound.`
    : `${selectedLabel}. Explicit signals only; lower bound.`;
}

/**
 * Failure events never carry a usable model, so this label deliberately says
 * nothing about model families: the day stands on its own regardless of which
 * family chips are selected.
 */
export function failureDayLabel(day: DatedFailureCounts): string {
  // Only `overloaded` carries a measured status (529). Server faults are grouped
  // from the reported error kind, so the wording claims no status class.
  if (day.attempted === 0) {
    return 'No API failures recorded. Calls that never completed; not model refusals.';
  }
  const parts = [
    `${day.overloaded} overloaded`,
    `${day.serverError} server ${day.serverError === 1 ? 'fault' : 'faults'}`,
  ];
  const attemptedLabel = `${day.attempted} API ${day.attempted === 1 ? 'failure' : 'failures'}: ${parts.join(', ')}`;
  return `${attemptedLabel}. Calls that never completed; not model refusals.`;
}

export function speedIndexSummary(index: SpeedIndex): string {
  if (!index.eligible || index.value === null) {
    if (index.reason === 'At least 20 requests are required.') {
      return 'More measurements needed';
    }
    if (index.reason === 'Not enough comparable model and output-size coverage.') {
      return 'No reliable like-for-like comparison';
    }
    return 'Baseline warming up';
  }

  const delta = Math.round(index.value - 100);
  if (delta === 0) return 'Right at your baseline';
  return `${delta > 0 ? '+' : ''}${delta}% vs your baseline`;
}

export function chartMaximum(points: DailyPoint[]): number {
  const peak = Math.max(
    1,
    ...points.flatMap((point) => [point.q3, ...(point.ciHigh == null ? [] : [point.ciHigh])]),
  );
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const ceiling = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return ceiling * magnitude;
}

export function linePath(
  points: DailyPoint[],
  dates: string[],
  max: number,
  width: number,
  height: number,
): string {
  return points
    .map((point, index) => {
      const x =
        dates.length <= 1 ? width / 2 : (dates.indexOf(point.date) / (dates.length - 1)) * width;
      const y = height - (point.median / max) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

export function areaPath(
  points: DailyPoint[],
  dates: string[],
  max: number,
  width: number,
  height: number,
): string {
  if (!points.length) return '';
  const x = (point: DailyPoint) =>
    dates.length <= 1 ? width / 2 : (dates.indexOf(point.date) / (dates.length - 1)) * width;
  const y = (value: number) => height - (value / max) * height;
  const upper = points.map((point) => `${x(point).toFixed(2)} ${y(point.q3).toFixed(2)}`);
  const lower = [...points]
    .reverse()
    .map((point) => `${x(point).toFixed(2)} ${y(point.q1).toFixed(2)}`);
  return `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
}
