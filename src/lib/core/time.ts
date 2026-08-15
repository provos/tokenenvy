const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timezone);
  if (!cached) {
    // Construction also validates the IANA timezone.
    cached = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, cached);
  }
  return cached;
}

export function validateTimezone(timezone: string): string {
  formatter(timezone).format(0);
  return timezone;
}

export function zonedParts(
  timestampMs: number,
  timezone: string,
): {
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  const parts = formatter(timezone).formatToParts(timestampMs);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return {
    date: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
      .toString()
      .padStart(2, '0')}`,
    year,
    month,
    day,
    hour: get('hour'),
  };
}

export function localDate(timestampMs: number, timezone: string): string {
  return zonedParts(timestampMs, timezone).date;
}

export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const parse = (date: string): number => {
    const [year, month, day] = date.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

export function isoWeekday(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** Convert a local midnight to an instant, including DST offset changes. */
export function zonedMidnight(date: string, timezone: string): number {
  validateTimezone(timezone);
  const [year, month, day] = date.split('-').map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let candidate = targetAsUtc;

  // Offset iteration works for non-hour offsets and historical transitions.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedParts(candidate, timezone);
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour);
    const next = candidate + (targetAsUtc - representedAsUtc);
    if (next === candidate) return next;
    candidate = next;
  }
  return candidate;
}
