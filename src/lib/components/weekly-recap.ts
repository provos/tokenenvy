import type { WeeklyModelMix, WeeklyRecap } from '$lib/types';
import { SECURITY_BLUEPRINTS_CAPTION } from './brand';
import {
  adjustSentimentForInterruptions,
  compactSocialNumber,
  failureStampLabel,
  getCompactFailureLine,
  getInterruptionMoodLines,
  getShareFailureLine,
  getShareSentimentTheme,
  fitSocialCaption,
  SHARE_PRIVACY_NOTE,
  SHARE_SOCIAL_BRAND,
  SHARE_SOCIAL_PRIVACY,
  type SharePlatform,
  type ShareSentiment,
  type ShareTone,
} from './share';

export type WeeklyRecapData = WeeklyRecap;

export interface WeeklyRecapProductLink {
  href: string;
  label: string;
}

export const WEEKLY_RECAP_INSTALL_CTA = 'Measure your week · npx tokenenvy';
export const WEEKLY_RECAP_PRODUCT_URL = 'https://www.npmjs.com/package/tokenenvy';
export const WEEKLY_RECAP_CHALLENGE = 'How did Claude Code treat you this week?';
export const WEEKLY_RECAP_REFUSAL_NOTE = 'Explicit signals only · lower bound';
export const DASHBOARD_SHARE_CTA = {
  eyebrow: 'Your private speed receipt',
  title: 'Claude Code feels slow? Bring receipts.',
  body: 'Post today’s number or your week. Then ask how Claude treated everyone else.',
  note: 'Prompts stay on this device. Model mix, output length, and workload shape effective TPS.',
} as const;

const WEEKLY_FRIENDLY_HEADLINES: Record<ShareSentiment, string> = {
  [-2]: 'Claude Code made this a long week',
  [-1]: 'Claude Code kept me waiting this week',
  [0]: 'Claude Code kept a steady pace this week',
  [1]: 'Claude Code kept me moving this week',
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

export function weeklyRecapIndexLine(recap: WeeklyRecapData): string {
  const { speedIndex } = recap;
  if (!speedIndex.eligible || speedIndex.value === null) return 'Building a 28-day baseline';
  const value = Math.round(speedIndex.value);
  const delta = value - 100;
  if (delta === 0) return 'Speed Index 100 · matched my prior 28 days';
  return `Speed Index ${value} · ${Math.abs(delta)}% ${delta > 0 ? 'faster' : 'slower'} than my prior 28 days`;
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
  return getShareFailureLine(recap.failures);
}

export function weeklyRecapFailureStamp(recap: WeeklyRecapData): string {
  return failureStampLabel(recap.failures);
}

export function weeklyRecapPeriod(recap: WeeklyRecapData): string {
  const start = shortDate(recap.weekStart);
  const through = shortDate(recap.throughDate);
  return recap.weekStart === recap.throughDate ? start : `${start} to ${through}`;
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

export function weeklyRecapObservedWeekdays(recap: WeeklyRecapData): Set<number> {
  const weekdays = new Set<number>();
  for (const date of recap.observedDates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < recap.weekStart || date > recap.throughDate) {
      continue;
    }
    const parsed = parseLocalDate(date);
    if (!Number.isFinite(parsed.getTime())) continue;
    weekdays.add((parsed.getUTCDay() + 6) % 7);
  }
  return weekdays;
}

export function weeklyRecapCaption(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null,
  platform: SharePlatform = 'generic',
): string {
  const headline = weeklyRecapHeadline(recap, tone, sentiment);
  const median = `Weekly median: ${Math.round(recap.median ?? 0)} effective tok/s.`;
  const refusalLine = weeklyRecapRefusalLine(recap);
  const refusalNote = weeklyRecapRefusalNote(recap);
  const refusal = `${refusalLine}.${refusalNote ? ` ${refusalNote}.` : ''}`;
  const failureLine = weeklyRecapFailureLine(recap);
  const failure = failureLine ? ` ${failureLine}.` : '';
  const link = productUrl ? ` ${productUrl}` : '';

  if (platform === 'x' || platform === 'bluesky') {
    const value = Math.round(recap.speedIndex.value ?? 100);
    const delta = value - 100;
    const comparison = recap.speedIndex.eligible
      ? delta === 0
        ? 'matched my 28d baseline'
        : `${Math.abs(delta)}% ${delta > 0 ? 'above' : 'below'} my 28d baseline`
      : '28d baseline still forming';
    const compactRefusal = !recap.refusals.recorded
      ? 'Refusal signals unavailable.'
      : recap.refusals.attempted === 0
        ? 'No explicit refusal signals this week; lower bound.'
        : `${compactSocialNumber(recap.refusals.attempted)} refusal ${recap.refusals.attempted === 1 ? 'signal' : 'signals'}: ${[
            recap.refusals.recovered > 0
              ? `${compactSocialNumber(recap.refusals.recovered)} recovered`
              : null,
            recap.refusals.userVisible > 0
              ? `${compactSocialNumber(recap.refusals.userVisible)} visible`
              : null,
            recap.refusals.unknown > 0
              ? `${compactSocialNumber(recap.refusals.unknown)} unresolved`
              : null,
          ]
            .filter(Boolean)
            .join('/')}; lower bound.`;
    return fitSocialCaption(
      headline,
      [
        `${compactSocialNumber(recap.median ?? 0)} tok/s median · ${comparison}.`,
        compactRefusal,
        getCompactFailureLine(recap.failures),
        'How was your Claude week?',
        SHARE_SOCIAL_PRIVACY,
        SHARE_SOCIAL_BRAND,
      ],
      platform === 'bluesky' ? productUrl : null,
      platform === 'x' ? 250 : 300,
    );
  }

  return `${headline}. ${median} ${weeklyRecapIndexLine(recap)}. ${refusal}${failure} ${WEEKLY_RECAP_CHALLENGE} ${SHARE_PRIVACY_NOTE} #TokenEnvy. ${SECURITY_BLUEPRINTS_CAPTION}${link}`;
}

export function weeklyRecapTextReceipt(
  recap: WeeklyRecapData,
  tone: ShareTone,
  sentiment: ShareSentiment,
  productUrl: string | null = null,
): string {
  const refusalLine = weeklyRecapRefusalLine(recap);
  return [
    'Token Envy weekly receipt',
    weeklyRecapPeriod(recap),
    weeklyRecapHeadline(recap, tone, sentiment),
    `${Math.round(recap.median ?? 0)} weekly median effective tok/s`,
    weeklyRecapIndexLine(recap),
    `${recap.requestCount.toLocaleString('en-US')} measured ${recap.requestCount === 1 ? 'request' : 'requests'} · ${recap.sessions.toLocaleString('en-US')} ${recap.sessions === 1 ? 'session' : 'sessions'}`,
    refusalLine,
    weeklyRecapRefusalNote(recap),
    weeklyRecapFailureLine(recap),
    SHARE_PRIVACY_NOTE,
    WEEKLY_RECAP_INSTALL_CTA,
    SECURITY_BLUEPRINTS_CAPTION,
    productUrl,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
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
