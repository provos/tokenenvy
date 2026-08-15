import { getRuntime } from '$lib/server/runtime';
import { MODEL_FAMILIES, type ModelFamily } from '$lib/types';
import { error, json } from '@sveltejs/kit';

const ALLOWED_RANGES = new Set([28, 90, 365]);

export function GET({ url }) {
  const days = Number(url.searchParams.get('days') ?? 28);
  if (!ALLOWED_RANGES.has(days)) error(400, 'days must be 28, 90, or 365');
  const requested = (url.searchParams.get('families') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const families = MODEL_FAMILIES.filter((family) => requested.includes(family));
  if (
    families.length === 0 ||
    requested.some((family) => !MODEL_FAMILIES.includes(family as ModelFamily))
  ) {
    error(400, 'families must contain one or more known model families');
  }
  return json(getRuntime().longitudinal(days as 28 | 90 | 365, families), {
    headers: { 'cache-control': 'no-store' },
  });
}
