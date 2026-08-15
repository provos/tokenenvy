import { json } from '@sveltejs/kit';

export function GET() {
  return json(
    { ok: true, service: 'tokenenvy', now: new Date().toISOString() },
    { headers: { 'cache-control': 'no-store' } },
  );
}
