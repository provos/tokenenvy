import { getRuntime } from '$lib/server/runtime';
import { error, json } from '@sveltejs/kit';

const ALLOWED_RANGES = new Set([28, 90, 365]);

export function GET({ url }) {
  const days = Number(url.searchParams.get('days') ?? 28);
  if (!ALLOWED_RANGES.has(days)) error(400, 'days must be 28, 90, or 365');
  return json(getRuntime().series(days), { headers: { 'cache-control': 'no-store' } });
}
