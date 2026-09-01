import type { WeeklyModelMix, WeeklyRecap } from '$lib/types';
import { daysBetween } from '$lib/core/time';
import {
  adjustSentimentForInterruptions,
  compactSocialNumber,
  getInterruptionMoodLines,
  getShareSentimentTheme,
  failureNoun,
  serverFaultLabel,
  type SharePlatform,
  type ShareSentiment,
  type ShareTone,
} from './share';

export type WeeklyRecapData = WeeklyRecap;

export interface WeeklyRecapProductLink {
  href: string;
  label: string;
}

export const WEEKLY_RECAP_INSTALL_CTA = 'Measure your week: npx tokenenvy';
export const WEEKLY_RECAP_PRODUCT_URL = 'https://www.npmjs.com/package/tokenenvy';
export const WEEKLY_RECAP_REFUSAL_NOTE = 'Explicit signals only · lower bound';
const WEEKLY_RECAP_PRIVACY = 'Runs locally. Prompts stay private.';
const WEEKLY_RECAP_QUESTION = 'How did your week compare?';
export const DASHBOARD_SHARE_CTA = {
  eyebrow: 'Your private speed receipt',
  title: 'Claude Code feels slow? Bring receipts.',
  body: 'Post today’s number or your week. Then ask how Claude treated everyone else.',
  note: 'Prompts stay on this device. Model mix, output length, and workload shape effective TPS.',
} as const;

const WEEKLY_FRIENDLY_HEADLINES: Record<ShareSentiment, string> = {
  [-2]: 'Claude fought me all week',
  [-1]: 'Claude Code kept me waiting this week',
  [0]: 'Claude held steady this week',
  [1]: 'Claude behaved this week',
  [2]: 'Claude Code flew all week',
};

const WEEKLY_SPICY_HEADLINES: Record<ShareSentiment, string> = {
  [-2]: 'Anthropic hated me this week',
  [-1]: 'Anthropic made me earn every token this week',
  [0]: 'Anthropic and I called it even this week',
  [1]: 'Anthropic was feeling generous this week',
  [2]: 'Anthropic loved me this week',
};

export function weeklyRecapReady(recap: WeeklyRecapData): boolean {
  return recap.requestCount > 0 && recap.daysObserved > 0 && recap.median !== null;
}

export function weeklyPerformanceSentiment(recap: WeeklyRecapData): ShareSentiment {
  if (!recap.speedIndex.eligible || recap.speedIndex.value === null) return 0;
  if (recap.speedIndex.value >= 105) return 1;
  if (recap.speedIndex.value <= 95) return -1;
  return 0;
}

export function suggestedWeeklySentiment(recap: WeeklyRecapData): ShareSentiment {
  return adjustSentimentForInterruptions(
    weeklyPerformanceSentiment(recap),
    recap.refusals,
    recap.failures,
  ).suggested;
}

export function weeklyRecapHeadline(
  recap: WeeklyRecapData,
  tone: ShareTone = 'friendly',
  sentiment: ShareSentiment = suggestedWeeklySentiment(recap),
): string {
  return tone === 'spicy'
    ? WEEKLY_SPICY_HEADLINES[sentiment]
    : WEEKLY_FRIENDLY_HEADLINES[sentiment];
}

export function weeklyRecapComparisonLine(recap: WeeklyRecapData): string {
  const { speedIndex } = recap;
  if (!speedIndex.eligible || speedIndex.value === null) {
    return 'My 28-day baseline is still building';
  }
  const value = Math.round(speedIndex.value);
  const delta = value - 100;
  if (delta === 0) return 'Matched my prior 28 days';
  return `${Math.abs(delta)}% ${delta > 0 ? 'faster' : 'slower'} than my prior 28 days`;
}

export function weeklyRecapSentimentDescription(recap: WeeklyRecapData): string {
  const base = weeklyPerformanceSentiment(recap);
  const { refusals, failures } = adjustSentimentForInterruptions(
    base,
    recap.refusals,
    recap.failures,
  );
  const baseMood = getShareSentimentTheme(base).label;
  const basis = recap.speedIndex.eligible
    ? `My prior 28 days suggested ${baseMood}.`
    : 'Neutral for now. The 28-day baseline needs more data.';
  const adjustments = getInterruptionMoodLines(refusals, failures);
  return `${basis}${adjustments ? ` ${adjustments}` : ''} Pick the mood; the numbers stay put.`;
}

export function weeklyRecapRefusalLine(recap: WeeklyRecapData): string {
  const { refusals } = recap;
  if (!refusals.recorded) return 'Explicit refusal signals unavailable';
  if (refusals.attempted === 0) return 'No explicit refusal signals this week';
  const parts = [
    `${refusals.attempted} refusal ${refusals.attempted === 1 ? 'signal' : 'signals'}`,
    refusals.recovered > 0 ? `${refusals.recovered} recovered` : null,
    refusals.userVisible > 0 ? `${refusals.userVisible} user-visible` : null,
    refusals.unknown > 0 ? `${refusals.unknown} unresolved` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

export function weeklyRecapRefusalNote(recap: WeeklyRecapData): string {
  return recap.refusals.recorded ? WEEKLY_RECAP_REFUSAL_NOTE : '';
}

/** Empty on a clean week, so the card never carries an empty failure slot. */
export function weeklyRecapFailureLine(recap: WeeklyRecapData): string {
  const { attempted, overloaded, serverError } = recap.failures;
  if (attempted === 0) return '';
  const outcomes = [
    overloaded > 0 ? `${overloaded} overloaded` : null,
    serverError > 0 ? serverFaultLabel(serverError) : null,
  ].filter((outcome): outcome is string => outcome !== null);
  const total = failureNoun(attempted);
  return outcomes.length > 0 ? `${total}: ${outcomes.join(' · ')}` : total;
}

export function weeklyRecapFailureStamp(recap: WeeklyRecapData): string {
  return recap.failures.attempted > 0 ? failureNoun(recap.failures.attempted) : '';
}

export function weeklyRecapPeriod(recap: WeeklyRecapData): string {
  const start = shortDate(recap.startDate);
  const through = shortDate(recap.throughDate);
  return recap.startDate === recap.throughDate ? start : `${start} to ${through}`;
}

export function weeklyRecapDayLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parseLocalDate(date));
}

export function weeklyRecapTopModel(recap: WeeklyRecapData): WeeklyModelMix | null {
  return [...recap.models].sort((left, right) => right.share - left.share)[0] ?? null;
}

export function weeklyRecapDayIndex(recap: WeeklyRecapData, date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < recap.startDate || date > recap.throughDate) {
    return null;
  }
  const index = daysBetween(recap.startDate, date);
  return Number.isFinite(index) && index >= 0 && index < 7 ? index : null;
}

export function weeklyRecapObservedDayIndices(recap: WeeklyRecapData): Set<number> {
  const dayIndices = new Set<number>();
  for (const date of recap.observedDates) {
    const index = weeklyRecapDayIndex(recap, date);
    if (index !== null) dayIndices.add(index);
  }
  return dayIndices;
}

export function weeklyRecapCaption(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null,
  platform: SharePlatform = 'generic',
): string {
  if (platform === 'x') return weeklyRecapMicroPost(recap, tone, sentiment, 250);
  if (platform === 'bluesky') return weeklyRecapBlueskyPost(recap, tone, sentiment, productUrl);
  return weeklyRecapFullText(recap, tone, sentiment, productUrl, {
    includeQuestion: platform === 'linkedin',
    includeCleanFailures: false,
  });
}

export function weeklyRecapTextReceipt(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null = null,
): string {
  return weeklyRecapFullText(recap, tone, sentiment, productUrl, {
    includeQuestion: false,
    includeCleanFailures: true,
  });
}

interface WeeklyFullTextOptions {
  includeQuestion: boolean;
  includeCleanFailures: boolean;
}

function weeklyRecapFullText(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null,
  options: WeeklyFullTextOptions,
): string {
  const facts = weeklyRecapFactLines(recap, options.includeCleanFailures).map(
    (line) => `- ${line}`,
  );
  const close = [
    options.includeQuestion ? WEEKLY_RECAP_QUESTION : null,
    WEEKLY_RECAP_INSTALL_CTA,
    WEEKLY_RECAP_PRIVACY,
  ].filter((line): line is string => line !== null);
  return [
    `${weeklyRecapShareLead(recap, tone, sentiment)}:`,
    facts.join('\n'),
    close.join('\n'),
    productUrl,
  ]
    .filter((block): block is string => Boolean(block))
    .join('\n\n');
}

function weeklyRecapFactLines(recap: WeeklyRecapData, includeCleanFailures: boolean): string[] {
  const failure = weeklyRecapFailureLine(recap);
  return [
    `${Math.round(recap.median ?? 0)} weekly median effective tok/s`,
    weeklyRecapComparisonLine(recap),
    `${recap.requestCount.toLocaleString('en-US')} measured ${recap.requestCount === 1 ? 'request' : 'requests'}`,
    weeklyRecapSocialRefusalLine(recap),
    failure || (includeCleanFailures ? 'No API failures recorded this week' : null),
  ].filter((line): line is string => line !== null);
}

function weeklyRecapShareLead(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  includeFailureClause = true,
): string {
  const headline = weeklyRecapHeadline(recap, tone, sentiment);
  return includeFailureClause && recap.failures.attempted > 0
    ? `${headline}, failed calls and all`
    : headline;
}

function weeklyRecapSocialRefusalLine(recap: WeeklyRecapData, includePeriod = true): string {
  const { refusals } = recap;
  if (!refusals.recorded) return 'Explicit refusal signals unavailable';
  if (refusals.attempted === 0) {
    return `No explicit refusal signals${includePeriod ? ' this week' : ''} · lower bound`;
  }
  const outcomes = [
    refusals.recovered > 0 ? `${refusals.recovered} recovered` : null,
    refusals.userVisible > 0 ? `${refusals.userVisible} user-visible` : null,
    refusals.unknown > 0 ? `${refusals.unknown} unresolved` : null,
  ].filter((outcome): outcome is string => outcome !== null);
  const signal = refusals.attempted === 1 ? 'signal' : 'signals';
  const details = outcomes.length > 0 ? `: ${outcomes.join(' · ')}` : '';
  return `${refusals.attempted} explicit refusal ${signal}${details} · lower bound`;
}

function weeklyRecapMicroPost(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  maxLength: number,
): string {
  const lead = `${weeklyRecapShareLead(recap, tone, sentiment)}.`;
  const comparison = lowerFirst(weeklyRecapComparisonLine(recap));
  const metric = `${compactSocialNumber(recap.median ?? 0)} median effective tok/s · ${comparison}`;
  const activity = `${compactSocialNumber(recap.requestCount)} requests`;
  const refusal = weeklyRecapCompactRefusalLine(recap);
  const failure =
    recap.failures.attempted > 0 ? failureNoun(recap.failures.attempted, compactSocialNumber) : '';
  const close = 'Run yours: npx tokenenvy · prompts stay private';
  const candidates = [
    [lead, metric, activity, refusal, failure, close],
    [lead, metric, refusal, failure, close],
    [lead, metric, refusal, close],
  ];
  return (
    candidates
      .map((lines) => lines.filter(Boolean).join('\n'))
      .find((caption) => caption.length <= maxLength) ?? `${lead}\n${metric}\n${close}`
  );
}

function weeklyRecapBlueskyPost(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null,
): string {
  const lead = `${weeklyRecapShareLead(recap, tone, sentiment, false)}.`;
  const metric = `${compactSocialNumber(recap.median ?? 0)} median effective tok/s · ${lowerFirst(weeklyRecapComparisonLine(recap))}`;
  const activity = `${compactSocialNumber(recap.requestCount)} requests`;
  const refusal = weeklyRecapSocialRefusalLine(recap, false);
  const failure = weeklyRecapFailureLine(recap);
  const close = ['Run yours: npx tokenenvy', 'Local stats. Prompts private.', productUrl].filter(
    (line): line is string => Boolean(line),
  );
  const detailed = [lead, metric, activity, refusal, failure, ...close].filter(Boolean).join('\n');
  if (detailed.length <= 300) return detailed;
  const withoutActivity = [lead, metric, refusal, failure, ...close].filter(Boolean).join('\n');
  if (withoutActivity.length <= 300) return withoutActivity;
  if (productUrl) {
    const available = 300 - productUrl.length - 1;
    if (available > 0) {
      const linked = `${weeklyRecapMicroPost(recap, tone, sentiment, available)}\n${productUrl}`;
      if (linked.length <= 300) return linked;
    }
  }
  return weeklyRecapMicroPost(recap, tone, sentiment, 300);
}

function weeklyRecapCompactRefusalLine(recap: WeeklyRecapData): string {
  const { refusals } = recap;
  if (!refusals.recorded) return 'Refusal signals unavailable';
  if (refusals.attempted === 0) return '0 explicit refusal signals · lower bound';
  const outcome = refusals.userVisible
    ? `${compactSocialNumber(refusals.userVisible)} user-visible`
    : refusals.recovered
      ? `${compactSocialNumber(refusals.recovered)} recovered`
      : refusals.unknown
        ? `${compactSocialNumber(refusals.unknown)} unresolved`
        : null;
  const total = `${compactSocialNumber(refusals.attempted)} ${refusals.attempted === 1 ? 'refusal' : 'refusals'}`;
  return `${total}${outcome ? ` · ${outcome}` : ''} · lower bound`;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

export function weeklyRecapImageFilename(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
): string {
  const mood = getShareSentimentTheme(sentiment).label.toLowerCase();
  return `token-envy-week-${recap.throughDate}-${tone}-${mood}.png`;
}

export function safeWeeklyRecapProductLink(
  value: string | undefined,
): WeeklyRecapProductLink | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.href.length > 2048 || url.username || url.password) {
      return null;
    }
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    const label = `${url.host}${path}`;
    return { href: url.href, label: label.length > 48 ? `${label.slice(0, 47)}...` : label };
  } catch {
    return null;
  }
}

function shortDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parseLocalDate(date));
}

function parseLocalDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}
