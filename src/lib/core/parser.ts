import { createHash } from 'node:crypto';
import { normalizeModelFamily } from './model';
import type { FailureClass } from '../types';

export interface ParsedEvent {
  eventId: string;
  parentId: string | null;
  requestId: string | null;
  sessionId: string;
  timestampMs: number | null;
  type: 'assistant' | 'other';
  model: string | null;
  outputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  terminal: boolean | null;
  synthetic: boolean;
  refusalOutcome: 'recovered' | 'user_visible' | 'unknown' | null;
  failureClass: FailureClass | null;
  qualityFlags: string | null;
}

type Digest = (value: string) => string;

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Parse only the allowlisted performance metadata needed by the database. Raw
 * content is deliberately never included in the returned object.
 */
export function parseTranscriptEvent(
  rawLine: string,
  sourceId: string,
  lineOffset: number,
  digest: Digest,
): ParsedEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawLine) as Record<string, unknown>;
  } catch {
    return null;
  }

  const uuid = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : null;
  const parentUuid = typeof raw.parentUuid === 'string' && raw.parentUuid ? raw.parentUuid : null;
  const requestId = typeof raw.requestId === 'string' && raw.requestId ? raw.requestId : null;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null;
  const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
  const type = raw.type === 'assistant' ? 'assistant' : 'other';
  const subtype = typeof raw.subtype === 'string' ? raw.subtype : null;
  const message =
    raw.message && typeof raw.message === 'object' ? (raw.message as Record<string, unknown>) : {};
  const usage =
    message.usage && typeof message.usage === 'object'
      ? (message.usage as Record<string, unknown>)
      : {};
  const occurrenceSeed = `${sourceId}:${lineOffset}:${createHash('sha256').update(rawLine).digest('hex')}`;
  // `<synthetic>` is the CLI's placeholder on rows it wrote itself, such as API
  // error rows. It names no model, so normalizing it would invent a real-looking
  // `other` family for a request that never reported one.
  const rawModel = typeof message.model === 'string' ? message.model : null;
  const hasStopReason = Object.prototype.hasOwnProperty.call(message, 'stop_reason');
  const stopReason = message.stop_reason;
  const terminal = !hasStopReason
    ? null
    : stopReason === null
      ? false
      : typeof stopReason === 'string' && stopReason.length > 0
        ? true
        : null;

  // Transport failures are classified from structured fields only. The error
  // text in message.content is never read so no prompt or response wording can
  // reach the index.
  let failureClass: FailureClass | null = null;
  if (raw.isApiErrorMessage === true) {
    const errorKind = typeof raw.error === 'string' ? raw.error : null;
    const status = typeof raw.apiErrorStatus === 'number' ? raw.apiErrorStatus : null;
    if (errorKind === 'authentication_failed') failureClass = 'client';
    else if (errorKind === 'invalid_request') failureClass = 'safeguard_block';
    else if (status === 529) failureClass = 'overloaded';
    // A measured status outside 5xx (400, 408, 429, …) is a caller-side or
    // quota fault, so it must not be counted as a service fault.
    else if (status != null && (status < 500 || status > 599)) failureClass = 'client';
    // Status-less rows keep `server_error`: the error kind is the only
    // structured evidence available, and it reports a fault, not a rejection.
    else failureClass = 'server_error';
  }

  let refusalOutcome: ParsedEvent['refusalOutcome'] = null;
  if (subtype === 'model_refusal_fallback') refusalOutcome = 'recovered';
  else if (subtype === 'model_refusal_no_fallback') refusalOutcome = 'user_visible';
  else if (raw.apiRefusalCategory != null) refusalOutcome = 'unknown';
  // An API-layer safety block is a refusal the user saw, with no fallback.
  else if (failureClass === 'safeguard_block') refusalOutcome = 'user_visible';

  return {
    eventId: digest(uuid ? `event:${uuid}` : `occurrence:${occurrenceSeed}`),
    parentId: parentUuid ? digest(`event:${parentUuid}`) : null,
    requestId: requestId ? digest(`request:${requestId}`) : null,
    sessionId: digest(`session:${sessionId ?? sourceId}`),
    timestampMs: Number.isFinite(timestamp) ? timestamp : null,
    type,
    model: rawModel && rawModel !== '<synthetic>' ? normalizeModelFamily(rawModel) : null,
    outputTokens: safeCount(usage.output_tokens),
    inputTokens: safeCount(usage.input_tokens),
    cacheReadTokens: safeCount(usage.cache_read_input_tokens),
    cacheCreationTokens: safeCount(usage.cache_creation_input_tokens),
    // Keep only whether the API supplied a stop-reason field and, when it did,
    // whether that reason was terminal. Older transcript formats can omit the
    // field entirely, and malformed non-string values provide no trustworthy
    // completion evidence; both are unknown rather than evidence of an
    // incomplete stream. The reason itself is never persisted.
    terminal,
    synthetic: raw.isSynthetic === true || (raw.isMeta === true && type === 'assistant'),
    refusalOutcome,
    failureClass,
    qualityFlags: uuid ? null : 'uuid_missing',
  };
}
