import { getRuntime } from '$lib/server/runtime';
import { json } from '@sveltejs/kit';

export function GET() {
  return json(getRuntime().refusals(), { headers: { 'cache-control': 'no-store' } });
}
