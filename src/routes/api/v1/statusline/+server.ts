import { getRuntime } from '$lib/server/runtime';
import { error, json } from '@sveltejs/kit';

const MAX_BODY_BYTES = 4096;
const MAX_MODEL_ID_LENGTH = 64;

function quotaWindow(value: unknown): { usedPercentage: number; resetsAt: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const usedPercentage = Number(item.usedPercentage);
  const reset = typeof item.resetsAt === 'string' ? new Date(item.resetsAt) : null;
  if (!Number.isFinite(usedPercentage) || usedPercentage < 0 || usedPercentage > 100)
    return undefined;
  if (!reset || !Number.isFinite(reset.getTime())) return undefined;
  return { usedPercentage, resetsAt: reset.toISOString() };
}

/** Model ids are metadata only; anything but a short non-empty string is dropped. */
function sanitizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_MODEL_ID_LENGTH);
}

export async function POST({ request }) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) error(413, 'Status-line sample is too large');

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) error(413, 'Status-line sample is too large');
    body = JSON.parse(text);
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'status' in cause) throw cause;
    error(400, 'Invalid JSON');
  }

  const fiveHour = quotaWindow(body.fiveHour);
  const sevenDay = quotaWindow(body.sevenDay);
  if (!fiveHour && !sevenDay) error(400, 'No valid rate-limit window supplied');
  const model = sanitizeModel(body.model);

  getRuntime().recordQuotaSample({
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(model ? { model } : {}),
    observedAt: new Date().toISOString(),
  });
  return json({ accepted: true }, { status: 202, headers: { 'cache-control': 'no-store' } });
}
