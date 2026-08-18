import type { FailureCounts, HistogramBin, ModelSummary, SpeedIndex } from '$lib/types';
import { SECURITY_BLUEPRINTS_CAPTION } from './brand';
import { adjustSentimentForFailures, type FailureMoodAdjustment } from './failure-mood';
import {
  adjustSentimentForRefusals,
  type RefusalMoodAdjustment,
  type RefusalMoodCounts,
} from './refusal-mood';

export type ShareTone = 'friendly' | 'spicy';
export type ShareSentiment = -2 | -1 | 0 | 1 | 2;
export type SharePlatform = 'generic' | 'x' | 'bluesky' | 'linkedin';
export const SHARE_INSTALL_CTA = 'Measure yours · npx tokenenvy';
export const DEFAULT_SHARE_PRODUCT_URL = 'https://www.npmjs.com/package/tokenenvy';
export const SHARE_BASELINE_LINE = 'Building a comparable baseline';
export const SHARE_PRIVACY_NOTE = 'Measured locally. Prompts stay private.';
export const SHARE_METRIC_UNIT = 'tok/s';
export const SHARE_METRIC_CONTEXT = 'effective output · wait + think time included';
export const SHARE_CHALLENGE = 'How did Claude Code treat you today?';
export const SHARE_SOCIAL_PRIVACY = 'Local stats; prompts private.';
export const SHARE_SOCIAL_BRAND = '#TokenEnvy · securityblueprints.io';
/** The dashboard chart marks platform failures with the same circled cross. */
export const FAILURE_MARK = '⊗';
/**
 * The governing split, carried onto every card: refusals are the model would
 * not, failures are the service could not. It never blames the reader and never
 * claims a status class that was not measured.
 *
 * The dashboard states this elliptically ("the model would not" / "the service
 * could not") because the two glosses sit side by side and complete each other.
 * A card carries only the failure half, and a caption is plain prose, so both
 * finish the verb instead of leaning on a twin that is not there.
 */
const FAILURE_FRAMING = 'the service could not complete';

const SOCIAL_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export interface ShareSentimentTheme {
  value: ShareSentiment;
  label: string;
  accessibleLabel: string;
  backgroundStart: string;
  backgroundMiddle: string;
  backgroundEnd: string;
  accent: string;
  secondary: string;
  text: string;
  mutedText: string;
  glow: string;
  bar: string;
  medianBar: string;
  outline: string;
}

export const SHARE_SENTIMENTS: readonly ShareSentiment[] = [-2, -1, 0, 1, 2];

const SENTIMENT_THEMES: Record<ShareSentiment, ShareSentimentTheme> = {
  [-2]: {
    value: -2,
    label: 'Brutal',
    accessibleLabel: 'Very negative',
    backgroundStart: '#160d18',
    backgroundMiddle: '#351522',
    backgroundEnd: '#53251f',
    accent: '#ff746c',
    secondary: '#c9dc58',
    text: '#fff3ef',
    mutedText: 'rgba(255, 243, 239, 0.76)',
    glow: 'rgba(255, 116, 108, 0.22)',
    bar: 'rgba(201, 220, 88, 0.25)',
    medianBar: 'rgba(255, 116, 108, 0.78)',
    outline: 'rgba(22, 13, 24, 0.82)',
  },
  [-1]: {
    value: -1,
    label: 'Rough',
    accessibleLabel: 'Negative',
    backgroundStart: '#17101b',
    backgroundMiddle: '#34202e',
    backgroundEnd: '#51342f',
    accent: '#ff9b72',
    secondary: '#dfbd70',
    text: '#fff5ef',
    mutedText: 'rgba(255, 245, 239, 0.76)',
    glow: 'rgba(255, 155, 114, 0.2)',
    bar: 'rgba(223, 189, 112, 0.24)',
    medianBar: 'rgba(255, 155, 114, 0.76)',
    outline: 'rgba(23, 16, 27, 0.82)',
  },
  [0]: {
    value: 0,
    label: 'Neutral',
    accessibleLabel: 'Neutral',
    backgroundStart: '#0d131b',
    backgroundMiddle: '#1b2730',
    backgroundEnd: '#293b45',
    accent: '#d8e1e8',
    secondary: '#7fa8b5',
    text: '#f3f6f8',
    mutedText: 'rgba(243, 246, 248, 0.74)',
    glow: 'rgba(127, 168, 181, 0.18)',
    bar: 'rgba(127, 168, 181, 0.25)',
    medianBar: 'rgba(216, 225, 232, 0.7)',
    outline: 'rgba(13, 19, 27, 0.82)',
  },
  [1]: {
    value: 1,
    label: 'Good',
    accessibleLabel: 'Positive',
    backgroundStart: '#07151b',
    backgroundMiddle: '#0c3032',
    backgroundEnd: '#154a3f',
    accent: '#6ff0c0',
    secondary: '#a6ed77',
    text: '#effff9',
    mutedText: 'rgba(239, 255, 249, 0.76)',
    glow: 'rgba(111, 240, 192, 0.2)',
    bar: 'rgba(166, 237, 119, 0.24)',
    medianBar: 'rgba(111, 240, 192, 0.76)',
    outline: 'rgba(7, 21, 27, 0.82)',
  },
  [2]: {
    value: 2,
    label: 'Glorious',
    accessibleLabel: 'Very positive',
    backgroundStart: '#0e1028',
    backgroundMiddle: '#242153',
    backgroundEnd: '#482b63',
    accent: '#ffd56a',
    secondary: '#7ae8ff',
    text: '#fffaf0',
    mutedText: 'rgba(255, 250, 240, 0.78)',
    glow: 'rgba(255, 213, 106, 0.23)',
    bar: 'rgba(122, 232, 255, 0.24)',
    medianBar: 'rgba(255, 213, 106, 0.82)',
    outline: 'rgba(14, 16, 40, 0.84)',
  },
};

export interface ShareHistogramBar {
  lower: number;
  upper: number;
  count: number;
  height: number;
  containsMedian: boolean;
}

export interface ShareCardData {
  date: string;
  median: number;
  count: number;
  sessions: number;
  outputTokens: number;
  isToday: boolean;
  indexLabel: string;
  indexEligible: boolean;
  indexValue: number | null;
  indexCiLow: number | null;
  indexCiHigh: number | null;
  percentile: number | null;
  refusals: ShareRefusalCounts;
  failures: ShareFailureCounts;
  models: Array<{ family: string; median: number; count: number }>;
  histogram: Array<{ lower: number; upper: number; count: number }>;
}

export interface ShareRefusalCounts {
  recorded: boolean;
  attempted: number;
  recovered: number;
  userVisible: number;
  unknown?: number;
}

/**
 * Platform failures. They are a separate axis from refusals and are never summed
 * with them; `attempted` is always `overloaded + serverError`.
 */
export interface ShareFailureCounts extends FailureCounts {
  recorded: boolean;
}

export interface ShareCardInput {
  date: string;
  median: number;
  count: number;
  sessions: number;
  outputTokens: number;
  isToday: boolean;
  speedIndex: SpeedIndex;
  refusals?: ShareRefusalCounts;
  failures?: ShareFailureCounts;
  models: ModelSummary[];
  histogram: HistogramBin[];
}

export interface ShareProductLink {
  href: string;
  label: string;
}

export function safeShareProductLink(value: string | undefined): ShareProductLink | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.href.length > 2048 || url.username || url.password) {
      return null;
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const label = `${url.host}${path}`;
    return { href: url.href, label: label.length > 48 ? `${label.slice(0, 47)}…` : label };
  } catch {
    return null;
  }
}

export function speedIndexDelta(index: SpeedIndex): number | null {
  if (!index.eligible || index.value === null) return null;
  return Math.round(index.value - 100);
}

export function speedIndexLabel(index: SpeedIndex): string {
  const delta = speedIndexDelta(index);
  if (delta === null) return SHARE_BASELINE_LINE;
  if (delta === 0) return 'Right at your baseline';
  return `${delta > 0 ? '+' : ''}${delta}% vs your baseline`;
}

export function normalizeShareSentiment(value: number): ShareSentiment {
  const rounded = Math.max(-2, Math.min(2, Math.round(value)));
  return rounded as ShareSentiment;
}

export function getShareSentimentTheme(value: number): ShareSentimentTheme {
  return SENTIMENT_THEMES[normalizeShareSentiment(value)];
}

export function sentimentAfterCardChange(
  previousDate: string | null,
  nextDate: string,
  current: ShareSentiment,
  suggested: ShareSentiment,
): ShareSentiment {
  return previousDate === nextDate ? current : suggested;
}

export function suggestedShareSentiment(data: ShareCardData): ShareSentiment {
  const base = suggestedPerformanceSentiment(data);
  return adjustSentimentForInterruptions(base, data.refusals, data.failures).suggested;
}

export function suggestedPerformanceSentiment(data: ShareCardData): ShareSentiment {
  const { indexValue, indexCiLow, indexCiHigh, percentile } = data;
  if (!data.indexEligible || indexValue === null || percentile === null) return 0;

  if (percentile <= 10 && indexValue <= 90 && indexCiHigh !== null && indexCiHigh < 100) {
    return -2;
  }
  if (percentile <= 45 && indexValue < 100) return -1;

  if (percentile >= 90 && indexValue >= 110 && indexCiLow !== null && indexCiLow > 100) {
    return 2;
  }
  if (percentile >= 55 && indexValue > 100) return 1;
  return 0;
}

/** The shared tail: what the signals did to the mood, and where it landed. */
function moodAdjustmentLine(
  adjustment: RefusalMoodAdjustment | FailureMoodAdjustment,
  signals: string,
): string {
  const finalMood = getShareSentimentTheme(adjustment.suggested).label;
  return `${signals} ${adjustment.stepsLowered > 0 ? 'moved it to' : 'kept it at'} ${finalMood}.`;
}

export function getRefusalMoodAdjustmentLine(adjustment: RefusalMoodAdjustment): string | null {
  if (adjustment.reason === 'unavailable' || adjustment.reason === 'none-observed') return null;

  const count =
    adjustment.reason === 'user-visible' || adjustment.reason === 'repeated-user-visible'
      ? adjustment.counts.userVisible
      : adjustment.reason === 'unresolved'
        ? adjustment.counts.unknown
        : adjustment.counts.recovered;
  const kind =
    adjustment.reason === 'user-visible' || adjustment.reason === 'repeated-user-visible'
      ? 'user-visible'
      : adjustment.reason === 'unresolved'
        ? 'unresolved'
        : 'recovered';
  const signals = `${count} ${kind} refusal ${count === 1 ? 'signal' : 'signals'}`;
  return moodAdjustmentLine(adjustment, signals);
}

/**
 * Says what the failures did to the mood without blaming the reader and without
 * naming a status class the logs never measured.
 */
function getFailureMoodAdjustmentLine(adjustment: FailureMoodAdjustment): string | null {
  if (adjustment.reason === 'unavailable' || adjustment.reason === 'none-observed') return null;
  return moodAdjustmentLine(
    adjustment,
    `${failureNoun(adjustment.counts.attempted)} that never completed`,
  );
}

/**
 * The only place the two-stage composition lives: refusals adjust the
 * performance mood, then failures adjust what the refusals left. A caller that
 * fed the failures the untouched base would silently drop the refusal step.
 */
export function adjustSentimentForInterruptions(
  base: ShareSentiment,
  refusals: RefusalMoodCounts,
  failures: ShareFailureCounts,
): {
  refusals: RefusalMoodAdjustment;
  failures: FailureMoodAdjustment;
  suggested: ShareSentiment;
} {
  const refusalAdjustment = adjustSentimentForRefusals(base, refusals);
  const failureAdjustment = adjustSentimentForFailures(refusalAdjustment.suggested, failures);
  return {
    refusals: refusalAdjustment,
    failures: failureAdjustment,
    suggested: failureAdjustment.suggested,
  };
}

/** Refusals speak first, then failures, so the stronger signal leads. */
export function getInterruptionMoodLines(
  refusals: RefusalMoodAdjustment,
  failures: FailureMoodAdjustment,
): string {
  return [getRefusalMoodAdjustmentLine(refusals), getFailureMoodAdjustmentLine(failures)]
    .filter((line): line is string => line !== null)
    .join(' ');
}

function endSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function getShareSentimentDescription(data: ShareCardData, reason?: string | null): string {
  const base = suggestedPerformanceSentiment(data);
  const { refusals, failures } = adjustSentimentForInterruptions(
    base,
    data.refusals,
    data.failures,
  );
  const baseMood = getShareSentimentTheme(base).label;
  const basis = data.indexEligible
    ? `Comparable days suggested ${baseMood}.`
    : `Neutral for now. ${endSentence(reason ?? 'The comparable baseline needs more data.')}`;
  const adjustments = getInterruptionMoodLines(refusals, failures);
  return `${basis}${adjustments ? ` ${adjustments}` : ''} Pick the mood; the numbers stay put.`;
}

function sanitizeHistogram(
  histogram: HistogramBin[],
): Array<{ lower: number; upper: number; count: number }> {
  return histogram
    .filter(
      (bin) =>
        Number.isFinite(bin.lower) &&
        Number.isFinite(bin.upper) &&
        Number.isFinite(bin.count) &&
        bin.upper > bin.lower &&
        bin.count >= 0,
    )
    .slice(0, 40)
    .map((bin) => ({
      lower: bin.lower,
      upper: bin.upper,
      count: Math.round(bin.count),
    }));
}

export function normalizeHistogram(
  histogram: Array<{ lower: number; upper: number; count: number }>,
  median: number,
): ShareHistogramBar[] {
  const bins = sanitizeHistogram(histogram);
  const maximum = Math.max(1, ...bins.map((bin) => bin.count));
  const medianIndex = bins.findIndex(
    (bin, index) =>
      median >= bin.lower &&
      (median < bin.upper || (index === bins.length - 1 && median <= bin.upper)),
  );

  return bins.map((bin, index) => ({
    ...bin,
    height: bin.count / maximum,
    containsMedian: index === medianIndex,
  }));
}

export function buildShareCardData(input: ShareCardInput): ShareCardData {
  const attempted = input.refusals?.recorded ? nonNegativeInteger(input.refusals.attempted) : 0;
  const recovered = Math.min(attempted, nonNegativeInteger(input.refusals?.recovered));
  const userVisible = Math.min(
    attempted - recovered,
    nonNegativeInteger(input.refusals?.userVisible),
  );
  const unknown = Math.max(0, attempted - recovered - userVisible);
  return {
    date: input.date,
    median: input.median,
    count: input.count,
    sessions: input.sessions,
    outputTokens: input.outputTokens,
    isToday: input.isToday,
    indexLabel: speedIndexLabel(input.speedIndex),
    indexEligible: input.speedIndex.eligible,
    indexValue: input.speedIndex.value,
    indexCiLow: input.speedIndex.ciLow,
    indexCiHigh: input.speedIndex.ciHigh,
    percentile: input.speedIndex.percentile,
    refusals: {
      recorded: input.refusals?.recorded === true,
      attempted,
      recovered,
      userVisible,
      unknown,
    },
    failures: normalizeShareFailures(input.failures),
    models: [...input.models]
      .sort((left, right) => right.share - left.share)
      .slice(0, 8)
      .map((model) => ({
        family: model.family,
        median: model.median,
        count: model.count,
      })),
    histogram: sanitizeHistogram(input.histogram),
  };
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function normalizeShareFailures(input: ShareFailureCounts | undefined): ShareFailureCounts {
  const attempted = input?.recorded ? nonNegativeInteger(input.attempted) : 0;
  const overloaded = Math.min(attempted, nonNegativeInteger(input?.overloaded));
  const serverError = Math.min(attempted - overloaded, nonNegativeInteger(input?.serverError));
  return { recorded: input?.recorded === true, attempted, overloaded, serverError };
}

export function getShareActivityLine(data: ShareCardData): string {
  const requests = `${data.count.toLocaleString('en-US')} measured ${data.count === 1 ? 'request' : 'requests'}`;
  const sessions = `${data.sessions.toLocaleString('en-US')} ${data.sessions === 1 ? 'session' : 'sessions'}`;
  return `${requests} · ${sessions}`;
}

export function getShareModelLine(data: ShareCardData): string {
  const families = data.models
    .slice(0, 3)
    .map((model) => model.family.charAt(0).toUpperCase() + model.family.slice(1))
    .join(' · ');
  return families ? `Models: ${families}` : 'All measured models';
}

export function getShareMoodLine(data: ShareCardData): string {
  if (!data.indexEligible || data.percentile === null) {
    return SHARE_BASELINE_LINE;
  }

  const percentile = Math.max(0, Math.min(100, Math.round(data.percentile)));
  if (percentile === 100) return 'Fastest among my comparable days';
  if (percentile === 0) return 'At the slow end of my comparable days';
  return `Faster than ${percentile}% of my comparable days`;
}

function getCompactShareMoodLine(data: ShareCardData): string {
  if (!data.indexEligible || data.percentile === null) return 'baseline still forming';
  const percentile = Math.max(0, Math.min(100, Math.round(data.percentile)));
  if (percentile === 100) return 'top of comparable days';
  if (percentile === 0) return 'bottom of comparable days';
  return `beat ${percentile}% of comparable days`;
}

export function getShareRefusalLine(data: ShareCardData): string {
  if (!data.refusals.recorded) return 'Explicit refusal signals unavailable';
  const { attempted, recovered, userVisible } = data.refusals;
  if (attempted === 0) return '';
  const unknown = Math.max(0, attempted - recovered - userVisible);
  const outcomes = [
    recovered > 0 ? `${recovered} recovered` : null,
    userVisible > 0 ? `${userVisible} user-visible` : null,
    unknown > 0 ? `${unknown} unresolved` : null,
  ].filter((value): value is string => value !== null);
  const label = attempted === 1 ? 'refusal signal' : 'refusal signals';
  return `${attempted} ${label}${outcomes.length > 0 ? ` · ${outcomes.join(' · ')}` : ''} · explicit lower bound`;
}

function getCompactShareRefusalLine(data: ShareCardData): string {
  if (!data.refusals.recorded) return 'Refusal signals unavailable.';
  const { attempted, recovered, userVisible } = data.refusals;
  if (attempted === 0) return '';
  const unresolved = Math.max(0, attempted - recovered - userVisible);
  const outcomes = [
    recovered > 0 ? `${compactSocialNumber(recovered)} recovered` : null,
    userVisible > 0 ? `${compactSocialNumber(userVisible)} visible` : null,
    unresolved > 0 ? `${compactSocialNumber(unresolved)} unresolved` : null,
  ].filter((outcome): outcome is string => outcome !== null);
  const signals = attempted === 1 ? 'refusal signal' : 'refusal signals';
  return `${compactSocialNumber(attempted)} ${signals}${outcomes.length ? `: ${outcomes.join('/')}` : ''}; lower bound.`;
}

export function compactSocialNumber(value: number): string {
  return SOCIAL_NUMBER_FORMATTER.format(Math.max(0, Math.round(value)));
}

/**
 * The one spelling of the failure count. `format` lets the compact social path
 * abbreviate the number without re-deriving the plural.
 */
export function failureNoun(attempted: number, format: (value: number) => string = String): string {
  return `${format(attempted)} API ${attempted === 1 ? 'failure' : 'failures'}`;
}

export function serverFaultLabel(serverError: number): string {
  return `${serverError} server ${serverError === 1 ? 'fault' : 'faults'}`;
}

/**
 * The mark that rides on the card itself. It carries only what a card can hold:
 * the count and the framing that keeps it from reading as another refusal. The
 * overloaded/server split lives in the accessible label, captions, and receipt,
 * where there is room for it. Empty when there is nothing to report, so the
 * common quiet day never grows an empty slot.
 */
export function failureStampLabel(counts: ShareFailureCounts): string {
  const failures = normalizeShareFailures(counts);
  if (failures.attempted === 0) return '';
  const calls = `${failures.attempted} ${failures.attempted === 1 ? 'call' : 'calls'}`;
  return `${calls} ${FAILURE_FRAMING}`;
}

/** The long form used in captions, receipts, and the card's accessible label. */
export function getShareFailureLine(counts: ShareFailureCounts): string {
  const failures = normalizeShareFailures(counts);
  if (failures.attempted === 0) return '';
  const parts = [
    failureNoun(failures.attempted),
    failures.overloaded > 0 ? `${failures.overloaded} overloaded` : null,
    failures.serverError > 0 ? serverFaultLabel(failures.serverError) : null,
  ].filter((part): part is string => part !== null);
  return `${parts.join(' · ')} · ${FAILURE_FRAMING}`;
}

export function getCompactFailureLine(counts: ShareFailureCounts): string {
  const failures = normalizeShareFailures(counts);
  if (failures.attempted === 0) return '';
  const outcomes = [
    failures.overloaded > 0 ? `${compactSocialNumber(failures.overloaded)} overloaded` : null,
    failures.serverError > 0 ? `${compactSocialNumber(failures.serverError)} server` : null,
  ].filter((outcome): outcome is string => outcome !== null);
  // A total with no breakdown is unreachable while every counted class also
  // increments one of the two, but adding a third platform class would land
  // here first -- and a dangling `: ;` is a worse way to find that out than a
  // total with no split.
  const split = outcomes.length > 0 ? `: ${outcomes.join('/')}` : '';
  return `${failureNoun(failures.attempted, compactSocialNumber)}${split}; ${FAILURE_FRAMING}.`;
}

export interface FailureStampTheme {
  mark: string;
  text: string;
  border: string;
  fill: string;
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace('#', '');
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((part) => part + part)
          .join('')
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return color;
  const value = Number.parseInt(expanded, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * Failures borrow the card's own foreground rather than the dashboard's cool
 * `--fault` hue: a fixed blue disappears into the calm themes and fights the
 * angry ones. Staying achromatic also keeps failures below the refusal alarm,
 * which owns the only saturated warning colors on the card.
 */
export function getFailureStampTheme(theme: ShareSentimentTheme): FailureStampTheme {
  return {
    mark: withAlpha(theme.text, 0.88),
    text: withAlpha(theme.text, 0.86),
    border: withAlpha(theme.text, 0.3),
    fill: withAlpha(theme.text, 0.08),
  };
}

export function failureStampStyle(theme: ShareSentimentTheme): string {
  const stamp = getFailureStampTheme(theme);
  return `--stamp-mark:${stamp.mark};--stamp-text:${stamp.text};--stamp-border:${stamp.border};--stamp-fill:${stamp.fill}`;
}

/** The circled cross the dashboard chart already uses for platform failures. */
export function drawFailureMark(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  lineWidth = 1.5,
): void {
  const arm = radius * 0.46;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.lineCap = 'round';
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(x - arm, y - arm);
  context.lineTo(x + arm, y + arm);
  context.moveTo(x + arm, y - arm);
  context.lineTo(x - arm, y + arm);
  context.stroke();
  context.restore();
}

export interface FailureStampOptions {
  right: number;
  top: number;
  label: string;
  theme: ShareSentimentTheme;
  fontSize?: number;
}

/**
 * Draws the right-aligned outage stamp and returns its width, or 0 when there is
 * nothing to stamp. Canvas state is saved and restored, so callers keep their
 * alignment and font.
 */
export function drawFailureStamp(
  context: CanvasRenderingContext2D,
  options: FailureStampOptions,
): number {
  if (!options.label) return 0;
  const stamp = getFailureStampTheme(options.theme);
  const fontSize = options.fontSize ?? 14;
  const font = `600 ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
  context.save();
  context.font = font;
  context.textAlign = 'left';
  const markRadius = fontSize * 0.44;
  const paddingX = fontSize * 0.74;
  const gap = fontSize * 0.46;
  const height = Math.round(fontSize * 1.85);
  const width = Math.round(
    paddingX * 2 + markRadius * 2 + gap + context.measureText(options.label).width,
  );
  const left = options.right - width;
  const middle = options.top + height / 2;

  context.beginPath();
  context.roundRect(left, options.top, width, height, height / 2);
  context.fillStyle = stamp.fill;
  context.fill();
  context.strokeStyle = stamp.border;
  context.lineWidth = 1;
  context.stroke();

  const markX = left + paddingX + markRadius;
  drawFailureMark(context, markX, middle, markRadius, stamp.mark, 1.4);

  context.fillStyle = stamp.text;
  context.fillText(options.label, markX + markRadius + gap, middle + fontSize * 0.35);
  context.restore();
  return width;
}

export function fitSocialCaption(
  lead: string,
  body: readonly string[],
  productUrl: string | null,
  maxLength: number,
): string {
  const bodySuffix = body.filter(Boolean).join(' ');
  const linkedSuffix = `${bodySuffix}${productUrl ? ` ${productUrl}` : ''}`;
  const full = `${lead}. ${linkedSuffix}`;
  if (full.length <= maxLength) return full;

  const withoutLink = `${lead}. ${bodySuffix}`;
  if (withoutLink.length <= maxLength) return withoutLink;

  const prefix = `${lead}.`;
  if (prefix.length >= maxLength) return `${lead.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;

  const suffixParts: string[] = [];
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const candidate = [body[index], ...suffixParts].filter(Boolean).join(' ');
    if (`${prefix} … ${candidate}`.length > maxLength) break;
    suffixParts.unshift(body[index]);
  }
  return suffixParts.length > 0 ? `${prefix} … ${suffixParts.join(' ')}` : prefix;
}

export function getShareImageFilename(date: string, tone: ShareTone, sentiment: number): string {
  const safeDate =
    date
      .trim()
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'day';
  const safeTone: ShareTone = tone === 'spicy' ? 'spicy' : 'friendly';
  const mood = getShareSentimentTheme(sentiment).label.toLowerCase();
  return `token-envy-${safeDate}-${safeTone}-${mood}.png`;
}

export function getShareTagline(
  tone: ShareTone,
  sentiment: ShareSentiment,
  data: ShareCardData,
): string {
  const when = data.isToday ? 'today' : 'that day';
  if (tone === 'friendly') {
    if (sentiment === -2) return `Claude Code made me wait ${when}`;
    if (sentiment === -1) return `Claude Code dragged its feet ${when}`;
    if (sentiment === 0) return `Claude Code kept pace ${when}`;
    if (sentiment === 1) return `Claude Code moved fast ${when}`;
    return `Claude Code flew ${when}`;
  }

  if (sentiment === -2) return `Anthropic ${data.isToday ? 'hates' : 'hated'} me ${when}`;
  if (sentiment === -1)
    return data.isToday
      ? 'Anthropic made me earn every token today'
      : 'Anthropic made me earn every token that day';
  if (sentiment === 0) {
    return data.isToday
      ? 'Anthropic and I called it even today'
      : 'Anthropic and I called it even that day';
  }
  if (sentiment === 1)
    return data.isToday
      ? 'Anthropic was feeling generous today'
      : 'Anthropic was feeling generous that day';
  return `Anthropic ${data.isToday ? 'loves' : 'loved'} me ${when}`;
}

export function getShareCaption(
  tone: ShareTone,
  sentiment: ShareSentiment,
  data: ShareCardData,
  platform: SharePlatform,
  productLink: string | null,
): string {
  const tagline = getShareTagline(tone, sentiment, data);
  const result = `${Math.round(data.median)} effective output ${SHARE_METRIC_UNIT}. ${getShareMoodLine(data)}.`;
  const refusalLine = getShareRefusalLine(data);
  const refusal = refusalLine ? ` ${refusalLine}.` : '';
  const failureLine = getShareFailureLine(data.failures);
  const failure = failureLine ? ` ${failureLine}.` : '';
  const attribution = `#TokenEnvy. ${SECURITY_BLUEPRINTS_CAPTION}`;
  const link =
    (platform === 'bluesky' || platform === 'generic') && productLink ? ` ${productLink}` : '';

  if (platform === 'x' || platform === 'bluesky') {
    const compactRefusal = getCompactShareRefusalLine(data);
    const challenge = data.isToday
      ? 'How did Claude treat you?'
      : 'How did Claude treat you that day?';
    return fitSocialCaption(
      tagline,
      [
        `${compactSocialNumber(data.median)} ${SHARE_METRIC_UNIT} · ${getCompactShareMoodLine(data)}.`,
        compactRefusal,
        getCompactFailureLine(data.failures),
        challenge,
        SHARE_SOCIAL_PRIVACY,
        SHARE_SOCIAL_BRAND,
      ],
      platform === 'bluesky' ? productLink : null,
      platform === 'x' ? 250 : 300,
    );
  }

  if (platform === 'linkedin') {
    const challenge = data.isToday ? SHARE_CHALLENGE : 'How did Claude Code treat you that day?';
    return `${tagline}.\n\nToken Envy receipt:\n${result}${refusal}${failure}\n\n${challenge}\n\n${SHARE_PRIVACY_NOTE}\n${attribution}`;
  }
  const challenge = data.isToday ? SHARE_CHALLENGE : 'How did Claude Code treat you that day?';
  return `${tagline}: ${result}${refusal}${failure} ${challenge} ${SHARE_PRIVACY_NOTE} ${attribution}${link}`;
}

export function getShareTextReceipt(
  tone: ShareTone,
  sentiment: ShareSentiment,
  data: ShareCardData,
  productLink: string | null = null,
): string {
  const refusalLine = getShareRefusalLine(data);
  const lines = [
    'Token Envy daily receipt',
    data.date,
    getShareTagline(tone, sentiment, data),
    `${Math.round(data.median)} effective output tokens/s`,
    getShareMoodLine(data),
    getShareActivityLine(data),
    refusalLine || null,
    getShareFailureLine(data.failures) || null,
    SHARE_PRIVACY_NOTE,
    SHARE_INSTALL_CTA,
    SECURITY_BLUEPRINTS_CAPTION,
    productLink,
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}
