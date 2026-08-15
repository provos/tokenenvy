import type { DailyPoint, ModelFamily } from '$lib/types';

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
