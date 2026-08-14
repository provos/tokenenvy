import type { DailyPoint, ModelFamily, ModelSummary, SpeedIndex } from '$lib/types';

export type ShareTone = 'friendly' | 'spicy';

export interface ShareProductLink {
  href: string;
  label: string;
}

export interface ShareCardModel {
  family: ModelFamily;
  share: number;
}

export interface ShareTrendPoint {
  date: string;
  family: ModelFamily;
  median: number;
}

export interface ShareCardData {
  date: string;
  median: number;
  count: number;
  indexLabel: string;
  indexEligible: boolean;
  percentile: number | null;
  models: ShareCardModel[];
  trend: ShareTrendPoint[];
}

interface ShareCardInput {
  date: string;
  median: number;
  count: number;
  speedIndex: SpeedIndex;
  models: ModelSummary[];
  points: DailyPoint[];
}

function boundedNumber(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}

export function safeShareProductLink(value: string | undefined): ShareProductLink | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    const href = url.toString();
    return {
      href,
      label: href.replace(/^https?:\/\//, '').replace(/\/$/, '')
    };
  } catch {
    return null;
  }
}

export function speedIndexDelta(index: SpeedIndex): number | null {
  return index.eligible && index.value != null && Number.isFinite(index.value) ? index.value - 100 : null;
}

export function speedIndexLabel(index: SpeedIndex): string {
  const delta = speedIndexDelta(index);
  if (delta == null) return 'Building a mix-adjusted baseline';
  return `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(0)}% vs 28-day mix-adjusted baseline`;
}

/** Build the complete, privacy-allowlisted object used by both preview and PNG output. */
export function buildShareCardData(input: ShareCardInput): ShareCardData {
  const models = input.models
    .map((model) => ({ family: model.family, share: boundedNumber(model.share, 0, 1) }))
    .sort((left, right) => right.share - left.share)
    .slice(0, 4);
  const families = new Set(models.map(({ family }) => family));
  const dates = [...new Set(input.points.map(({ date }) => date))].sort().slice(-14);
  const includedDates = new Set(dates);
  const trend = input.points
    .filter(
      (point) =>
        includedDates.has(point.date) &&
        families.has(point.family) &&
        Number.isFinite(point.median) &&
        point.median >= 0
    )
    .map(({ date, family, median }) => ({ date, family, median }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.family.localeCompare(right.family));

  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : '',
    median: boundedNumber(input.median, 0, 1_000_000),
    count: Math.round(boundedNumber(input.count, 0, Number.MAX_SAFE_INTEGER)),
    indexLabel: speedIndexLabel(input.speedIndex),
    indexEligible: input.speedIndex.eligible,
    percentile:
      input.speedIndex.percentile == null
        ? null
        : boundedNumber(input.speedIndex.percentile, 0, 100),
    models,
    trend
  };
}

export function getShareTagline(tone: ShareTone, data: ShareCardData): string {
  if (!data.indexEligible || data.percentile === null) return 'A day in the life of Claude Code';
  if (tone === 'spicy') {
    if (data.percentile >= 75) return 'Anthropic loves me today';
    if (data.percentile <= 25) return 'Anthropic hates me today';
    return 'Anthropic and I are on speaking terms';
  }
  if (data.percentile >= 75) return 'Claude is flying today';
  if (data.percentile <= 25) return 'Claude is taking the scenic route';
  return 'Claude found its rhythm today';
}

export function shareTrendPath(
  trend: readonly ShareTrendPoint[],
  family: ModelFamily,
  width: number,
  height: number
): string {
  return shareTrendCoordinates(trend, family, width, height)
    .map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');
}

export function shareTrendCoordinates(
  trend: readonly ShareTrendPoint[],
  family: ModelFamily,
  width: number,
  height: number
): Array<{ x: number; y: number }> {
  const selected = trend.filter((point) => point.family === family);
  if (selected.length === 0) return [];
  const dates = [...new Set(trend.map(({ date }) => date))].sort();
  const maximum = Math.max(1, ...trend.map(({ median }) => median));
  return selected.map((point) => {
    const dateIndex = dates.indexOf(point.date);
    const x = dates.length <= 1 ? width / 2 : (dateIndex / (dates.length - 1)) * width;
    const y = height - (point.median / maximum) * height;
    return { x, y };
  });
}
