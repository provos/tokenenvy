import { getRuntime } from '$lib/server/runtime';
import { error, json } from '@sveltejs/kit';

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function GET({ params }) {
  if (!isCalendarDate(params.date)) error(400, 'date must be a valid YYYY-MM-DD value');
  const detail = getRuntime().day(params.date);
  if (!detail) error(404, 'No measurements were recorded for this date');
  return json(detail, { headers: { 'cache-control': 'no-store' } });
}
