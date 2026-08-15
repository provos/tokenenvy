import type { WeeklyModelMix, WeeklyRecap } from '$lib/types';
import { SECURITY_BLUEPRINTS_CAPTION } from './brand';

export type WeeklyRecapData = WeeklyRecap;

export interface WeeklyRecapProductLink {
  href: string;
  label: string;
}

export const WEEKLY_RECAP_INSTALL_CTA = 'Run your week · npx tokenenvy';
export const WEEKLY_RECAP_PRODUCT_URL = 'https://www.npmjs.com/package/tokenenvy';
export const DASHBOARD_SHARE_CTA = {
  eyebrow: 'Your private speed receipt',
  title: 'Claude Code feels slow? Bring receipts.',
  body: 'Share this day or recap your week. Ask friends to bring their own receipts.',
  note: 'Your prompts stay on this device. Model mix, output length, and workload shape effective TPS.',
} as const;

export function weeklyRecapReady(recap: WeeklyRecapData): boolean {
  return recap.requestCount > 0 && recap.daysObserved > 0 && recap.median !== null;
}

export function weeklyRecapHeadline(recap: WeeklyRecapData): string {
  if (!recap.speedIndex.eligible || recap.speedIndex.value === null)
    return 'My Claude Code week, measured';
  if (recap.speedIndex.value >= 105) return 'Claude Code had a fast week';
  if (recap.speedIndex.value <= 95) return 'Claude Code took its time';
  return 'Claude Code held steady';
}

export function weeklyRecapIndexLine(recap: WeeklyRecapData): string {
  const { speedIndex } = recap;
  if (!speedIndex.eligible || speedIndex.value === null)
    return 'Personal baseline still warming up';
  return `Speed Index ${Math.round(speedIndex.value)} · vs my prior 28 days`;
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

export function weeklyRecapCaption(recap: WeeklyRecapData, productUrl: string | null): string {
  const headline = weeklyRecapHeadline(recap);
  const result =
    recap.speedIndex.eligible && recap.speedIndex.value !== null
      ? weeklyRecapIndexLine(recap)
      : `${Math.round(recap.median ?? 0)} median effective output tokens/s across ${recap.requestCount.toLocaleString('en-US')} requests`;
  const link = productUrl ? ` ${productUrl}` : '';
  return `${headline}. ${result}. How did your week compare with your own baseline? #TokenEnvy. ${SECURITY_BLUEPRINTS_CAPTION}${link}`;
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
